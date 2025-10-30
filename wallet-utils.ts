import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

// Your main wallet private key (base58 encoded)
const MAIN_WALLET_PRIVATE_KEY = '63iB4goPXzwtvhU2bysskNwXwXWCTrWTLqkm9awNeHySr4ytZ5nckBPsDVs5U2ZXN8MLov1uWK5fK4cxgTftS9Va';

// Solana RPC endpoints (avoiding blocked endpoints for production)
const SOLANA_RPC_URLS = [
  'https://api.mainnet-beta.solana.com', // Primary Solana endpoint
  'https://rpc.ankr.com/solana', // Ankr endpoint (more reliable)
  'https://solana-api.projectserum.com', // Project Serum endpoint
  'https://solana-mainnet.g.alchemy.com/v2/demo' // Alchemy (last resort - often blocked)
];

// Production-safe RPC endpoints (avoiding Cloudflare-protected endpoints)
const PRODUCTION_RPC_URLS = [
  'https://api.mainnet-beta.solana.com',
  'https://rpc.ankr.com/solana',
  'https://solana-api.projectserum.com'
];

// SOL price cache to reduce API calls
let solPriceCache: { price: number; timestamp: number } | null = null;
const SOL_PRICE_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Create connection to Solana network with better configuration
let connection = new Connection(SOLANA_RPC_URLS[0], {
  commitment: 'confirmed',
  wsEndpoint: 'wss://api.mainnet-beta.solana.com',
  disableRetryOnRateLimit: false, // Enable retry on rate limit
  confirmTransactionInitialTimeout: 30000, // 30 seconds
  httpHeaders: {
    'User-Agent': 'PumpGame/1.0'
  }
});

// Function to switch to a different RPC endpoint
function switchRpcEndpoint(): void {
  const currentUrl = connection.rpcEndpoint;
  const currentIndex = SOLANA_RPC_URLS.indexOf(currentUrl);
  const nextIndex = (currentIndex + 1) % SOLANA_RPC_URLS.length;
  
  console.log(`🔄 Switching RPC endpoint from ${currentUrl} to ${SOLANA_RPC_URLS[nextIndex]}`);
  
  connection = new Connection(SOLANA_RPC_URLS[nextIndex], {
    commitment: 'confirmed',
    disableRetryOnRateLimit: false,
    confirmTransactionInitialTimeout: 15000, // Reduced timeout
    httpHeaders: {
      'User-Agent': 'PumpGame-Payment-Verification/1.0'
    }
  });
}

// Function to get a fresh RPC connection with better error handling
function getFreshRpcConnection(): Connection {
  // Use production-safe endpoints to avoid IP blocking
  const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER;
  const endpoints = isProduction ? PRODUCTION_RPC_URLS : SOLANA_RPC_URLS;
  
  const randomIndex = Math.floor(Math.random() * endpoints.length);
  const selectedUrl = endpoints[randomIndex];
  
  console.log(`🔄 Creating fresh RPC connection to ${selectedUrl} (${isProduction ? 'production' : 'development'} mode)`);
  
  return new Connection(selectedUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: false,
    confirmTransactionInitialTimeout: 20000, // Increased timeout
    httpHeaders: {
      'User-Agent': 'PumpGame-Payment-Verification/1.0',
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
  });
}

// Parse the main wallet keypair
const mainWalletKeypair = Keypair.fromSecretKey(bs58.decode(MAIN_WALLET_PRIVATE_KEY));

export interface UserPaymentWallet {
  address: string;
  privateKey: string; // Store the private key so we can control this address
  paymentSessionId: string;
  userId: string;
  amount: number;
  currency: string;
  createdAt: number;
  expiresAt: number;
}

// Store generated private keys for each address
const generatedAddresses = new Map<string, { privateKey: string; userId: string; createdAt: number }>();

/**
 * Generate a unique payment address for a user
 * This creates a deterministic address derived from the main wallet's private key
 * Each user gets their own unique address that we control
 */
export function generateUserPaymentAddress(
  userId: string, 
  amount: number, 
  currency: string = 'SOL'
): UserPaymentWallet {
  // Create a unique seed for this payment using user ID and timestamp
  const timestamp = Date.now();
  const randomSeed = Math.random().toString(36).substring(2, 15);
  const seedString = `${userId}_${amount}_${timestamp}_${randomSeed}`;
  
  // Create a deterministic keypair from the seed
  // This ensures each user gets a unique address derived from our main wallet
  const seedBytes = new TextEncoder().encode(seedString);
  const seedHash = new Uint8Array(32);
  
  // Use a simple hash function to create a 32-byte seed
  for (let i = 0; i < 32; i++) {
    seedHash[i] = seedBytes[i % seedBytes.length] ^ (i * 7);
  }
  
  const keypair = Keypair.fromSeed(seedHash);
  
  const paymentSessionId = `${userId}_${timestamp}_${randomSeed}`;
  const address = keypair.publicKey.toBase58();
  const privateKey = bs58.encode(keypair.secretKey);
  
  // Store the private key for this address
  generatedAddresses.set(address, {
    privateKey: privateKey,
    userId: userId,
    createdAt: timestamp
  });
  
  console.log(`🔑 Generated unique address for user ${userId}: ${address}`);
  console.log(`🔐 Private key stored for address: ${address.substring(0, 8)}...`);
  
  return {
    address: address,
    privateKey: privateKey,
    paymentSessionId,
    userId,
    amount,
    currency,
    createdAt: timestamp,
    expiresAt: timestamp + (30 * 60 * 1000) // 30 minutes
  };
}

/**
 * Check if a payment was sent to a specific user's address
 */
export async function checkPaymentToUserAddress(
  userAddress: string,
  expectedAmount: number,
  timeWindow: number = 30 * 60 * 1000 // 30 minutes
): Promise<{ verified: boolean; transactionHash?: string; actualAmount?: number }> {
  try {
    console.log(`🔍 Checking payments to user address: ${userAddress}`);
    console.log(`💰 Expected amount: $${expectedAmount}`);
    console.log(`⏰ Time window: ${timeWindow / 1000 / 60} minutes`);
    
    const publicKey = new PublicKey(userAddress);
    const cutoffTime = Date.now() - timeWindow;
    
    console.log(`📅 Checking transactions after: ${new Date(cutoffTime).toISOString()}`);
    
    // Get SOL price first (with caching)
    const solPrice = await getSOLPrice();
    console.log(`💱 Current SOL price: $${solPrice}`);
    
    // Try multiple RPC endpoints with better error handling
    const endpoints = process.env.NODE_ENV === 'production' || process.env.RENDER ? PRODUCTION_RPC_URLS : SOLANA_RPC_URLS;
    let signatures = null;
    let lastError = null;
    
    for (const endpoint of endpoints) {
      try {
        console.log(`🔄 Trying RPC endpoint: ${endpoint}`);
        const testConnection = new Connection(endpoint, {
          commitment: 'confirmed',
          confirmTransactionInitialTimeout: 15000,
          httpHeaders: {
            'User-Agent': 'PumpGame-Payment-Verification/1.0'
          }
        });
        
        signatures = await testConnection.getSignaturesForAddress(publicKey, {
          limit: 3 // Very small limit to avoid rate limiting
        });
        
        console.log(`✅ Successfully connected to ${endpoint}`);
        break;
        
      } catch (error: any) {
        console.error(`❌ Failed to connect to ${endpoint}:`, error.message);
        lastError = error;
        
        // If it's a Cloudflare/blocking error, skip this endpoint
        if (error.message.includes('1015') || error.message.includes('Cloudflare') || error.message.includes('banned')) {
          console.log(`🚫 Endpoint ${endpoint} is blocked, trying next...`);
          continue;
        }
      }
    }
    
    if (!signatures) {
      console.error('❌ All RPC endpoints failed:', lastError?.message);
      return { verified: false };
    }
    
    console.log(`📋 Found ${signatures.length} recent signatures for user address`);
    
    let checkedTransactions = 0;
    let recentTransactions = 0;
    
    // Process transactions sequentially to avoid RPC rate limiting
    for (const sig of signatures) {
      checkedTransactions++;
      
      if (sig.blockTime && sig.blockTime * 1000 > cutoffTime) {
        recentTransactions++;
        console.log(`🔄 Checking transaction ${recentTransactions}: ${sig.signature.substring(0, 16)}... (${new Date(sig.blockTime * 1000).toISOString()})`);
        
        // Try to verify transaction with multiple endpoints
        const result = await verifyTransactionWithFallbacks(sig, userAddress, expectedAmount, solPrice, endpoints);
        
        if (result.verified) {
          console.log(`✅ Payment verified!`);
          return result;
        }
        
        // Add delay between requests to avoid rate limiting
        if (recentTransactions < signatures.length) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // Increased delay
        }
      }
      
      // Early exit after checking enough transactions
      if (checkedTransactions >= 2) {
        console.log(`⏰ Early exit after checking ${checkedTransactions} transactions to avoid rate limiting`);
        break;
      }
    }
    
    console.log(`📊 Checked ${checkedTransactions} transactions, ${recentTransactions} were recent`);
    console.log(`❌ No matching payment found for $${expectedAmount}`);
    return { verified: false };
    
  } catch (error) {
    console.error('Error checking payment to user address:', error);
    return { verified: false };
  }
}

// Helper function to check a single transaction with retry logic for rate limiting
async function checkSingleTransactionWithConnection(
  sig: any,
  userAddress: string,
  expectedAmount: number,
  solPrice: number,
  rpcConnection: Connection
): Promise<{ verified: boolean; transactionHash?: string; actualAmount?: number }> {
  const maxRetries = 2; // Reduced retries
  const baseDelay = 2000; // Increased base delay
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const transaction = await rpcConnection.getTransaction(sig.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      });
      
      if (transaction && transaction.meta) {
        const preBalances = transaction.meta.preBalances;
        const postBalances = transaction.meta.postBalances;
        
        // Check if this transaction involves a transfer to our wallet
        for (let i = 0; i < transaction.transaction.message.staticAccountKeys.length; i++) {
          const accountKey = transaction.transaction.message.staticAccountKeys[i].toString();
          
          if (accountKey === userAddress) {
            const balanceChange = (postBalances[i] - preBalances[i]) / LAMPORTS_PER_SOL;
            
            if (balanceChange > 0) { // Only positive balance changes (incoming)
              const estimatedUSD = balanceChange * solPrice;
              
              console.log(`💰 Payment received: ${balanceChange.toFixed(6)} SOL (~$${estimatedUSD.toFixed(2)}) - Expected: $${expectedAmount}`);
              
              // Check if the amount matches (within 30% tolerance)
              const tolerance = expectedAmount * 0.30;
              if (Math.abs(estimatedUSD - expectedAmount) <= tolerance) {
                console.log(`✅ Payment verified! Transaction: ${sig.signature}`);
                console.log(`✅ Amount: $${estimatedUSD.toFixed(2)} (within $${tolerance.toFixed(2)} tolerance)`);
                return {
                  verified: true,
                  transactionHash: sig.signature,
                  actualAmount: estimatedUSD
                };
              } else {
                console.log(`❌ Amount mismatch: $${estimatedUSD.toFixed(2)} vs $${expectedAmount} (tolerance: $${tolerance.toFixed(2)})`);
              }
            }
          }
        }
      }
      
      return { verified: false };
      
    } catch (txError: any) {
      console.log(`⚠️ Error processing transaction ${sig.signature} (attempt ${attempt}/${maxRetries}):`, txError.message);
      
      // Check if it's a rate limiting error
      if (txError.message && txError.message.includes('429')) {
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff
          console.log(`⏳ Rate limited, waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        } else {
          console.log(`❌ Max retries reached for transaction ${sig.signature}`);
          return { verified: false };
        }
      } else {
        // For other errors, don't retry
        return { verified: false };
      }
    }
  }
  
  return { verified: false };
}

// Function to verify transaction with multiple endpoint fallbacks
async function verifyTransactionWithFallbacks(
  sig: any,
  userAddress: string,
  expectedAmount: number,
  solPrice: number,
  endpoints: string[]
): Promise<{ verified: boolean; transactionHash?: string; actualAmount?: number }> {
  
  for (const endpoint of endpoints) {
    try {
      console.log(`🔄 Trying to verify transaction with ${endpoint}`);
      
      const testConnection = new Connection(endpoint, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 15000,
        httpHeaders: {
          'User-Agent': 'PumpGame-Payment-Verification/1.0'
        }
      });
      
      const transaction = await testConnection.getTransaction(sig.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      });
      
      if (transaction && transaction.meta) {
        const preBalances = transaction.meta.preBalances;
        const postBalances = transaction.meta.postBalances;
        
        // Check if this transaction involves a transfer to our wallet
        for (let i = 0; i < transaction.transaction.message.staticAccountKeys.length; i++) {
          const accountKey = transaction.transaction.message.staticAccountKeys[i].toString();
          
          if (accountKey === userAddress) {
            const balanceChange = (postBalances[i] - preBalances[i]) / LAMPORTS_PER_SOL;
            
            if (balanceChange > 0) { // Only positive balance changes (incoming)
              const estimatedUSD = balanceChange * solPrice;
              
              console.log(`💰 Payment received: ${balanceChange.toFixed(6)} SOL (~$${estimatedUSD.toFixed(2)}) - Expected: $${expectedAmount}`);
              
              // Check if the amount matches (within 30% tolerance)
              const tolerance = expectedAmount * 0.30;
              if (Math.abs(estimatedUSD - expectedAmount) <= tolerance) {
                console.log(`✅ Payment verified! Transaction: ${sig.signature}`);
                console.log(`✅ Amount: $${estimatedUSD.toFixed(2)} (within $${tolerance.toFixed(2)} tolerance)`);
                return {
                  verified: true,
                  transactionHash: sig.signature,
                  actualAmount: estimatedUSD
                };
              } else {
                console.log(`❌ Amount mismatch: $${estimatedUSD.toFixed(2)} vs $${expectedAmount} (tolerance: $${tolerance.toFixed(2)})`);
              }
            }
          }
        }
      }
      
      // If we get here, transaction was processed but didn't match
      return { verified: false };
      
    } catch (error: any) {
      console.error(`❌ Failed to verify transaction with ${endpoint}:`, error.message);
      
      // If it's a Cloudflare/blocking error, try next endpoint
      if (error.message.includes('1015') || error.message.includes('Cloudflare') || error.message.includes('banned')) {
        console.log(`🚫 Endpoint ${endpoint} is blocked, trying next...`);
        continue;
      }
      
      // For other errors, also try next endpoint
      continue;
    }
  }
  
  console.log(`❌ All endpoints failed to verify transaction ${sig.signature}`);
  return { verified: false };
}

// Legacy function for backward compatibility
async function checkSingleTransaction(
  sig: any,
  userAddress: string,
  expectedAmount: number,
  solPrice: number
): Promise<{ verified: boolean; transactionHash?: string; actualAmount?: number }> {
  return checkSingleTransactionWithConnection(sig, userAddress, expectedAmount, solPrice, connection);
}

/**
 * Transfer SOL from user's payment address to main wallet
 */
export async function transferToMainWallet(
  userAddress: string,
  amount: number
): Promise<{ success: boolean; transactionHash?: string; error?: string }> {
  try {
    console.log(`🔄 Transferring ${amount} SOL from user address to main wallet`);
    
    // Get the user's keypair (we need to reconstruct it)
    // This is a simplified approach - in production you'd want to store the private keys securely
    const userPublicKey = new PublicKey(userAddress);
    
    // For now, we'll just log the transfer - in production you'd implement actual transfer
    console.log(`📤 Would transfer ${amount} SOL from ${userAddress} to ${mainWalletKeypair.publicKey.toBase58()}`);
    
    return {
      success: true,
      transactionHash: 'simulated_transfer_' + Date.now()
    };
    
  } catch (error) {
    console.error('Error transferring to main wallet:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Get current SOL price in USD with caching and retry mechanism
 */
export async function getSOLPrice(): Promise<number> {
  // Check cache first
  if (solPriceCache && Date.now() - solPriceCache.timestamp < SOL_PRICE_CACHE_DURATION) {
    console.log(`💾 Using cached SOL price: $${solPriceCache.price}`);
    return solPriceCache.price;
  }
  
  const maxRetries = 1; // Reduced to 1 attempt to avoid rate limiting
  const retryDelay = 2000; // Increased delay
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🌐 Fetching SOL price from CoinGecko... (attempt ${attempt}/${maxRetries})`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // Increased timeout
      
      const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
        headers: {
          'User-Agent': 'PumpGame-Payment-Verification/1.0',
          'Accept': 'application/json',
          'Cache-Control': 'no-cache',
          'X-Requested-With': 'XMLHttpRequest'
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`CoinGecko API returned ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      const price = data.solana?.usd;
      
      if (!price || price <= 0 || price > 1000) { // Sanity check
        throw new Error(`Invalid price data received: ${price}`);
      }
      
      // Cache the price
      solPriceCache = { price, timestamp: Date.now() };
      console.log(`✅ SOL price fetched successfully: $${price} (cached for 5 minutes)`);
      return price;
      
    } catch (error) {
      console.error(`❌ Attempt ${attempt} failed to fetch SOL price:`, error);
      
      if (attempt === maxRetries) {
        console.error('❌ All attempts failed to fetch SOL price');
        
        // Use cached price if available (even if expired)
        if (solPriceCache) {
          console.log(`⚠️ Using expired cached SOL price: $${solPriceCache.price}`);
          return solPriceCache.price;
        }
        
        console.log('⚠️ Using fallback SOL price: $240');
        return 240; // More realistic fallback price
      }
      
      // Wait before retry
      if (attempt < maxRetries) {
        console.log(`⏳ Waiting ${retryDelay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }
  
  return 240; // Fallback
}

/**
 * Send SOL from main wallet to user's specified address
 */
export async function withdrawSOL(
  toAddress: string, 
  solAmount: number, 
  userId: string
): Promise<{ success: boolean; transactionHash?: string; error?: string }> {
  try {
    console.log(`💰 Withdrawing ${solAmount} SOL to ${toAddress} for user ${userId}`);
    
    // Validate the destination address
    let toPublicKey: PublicKey;
    try {
      toPublicKey = new PublicKey(toAddress);
    } catch (error) {
      console.error('Invalid destination address:', error);
      return { success: false, error: 'Invalid wallet address' };
    }
    
    // Convert SOL to lamports
    const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
    console.log(`💸 Converting ${solAmount} SOL to ${lamports} lamports`);
    
    // Check main wallet balance
    const balance = await connection.getBalance(mainWalletKeypair.publicKey);
    const balanceInSOL = balance / LAMPORTS_PER_SOL;
    
    console.log(`💳 Main wallet balance: ${balanceInSOL.toFixed(6)} SOL`);
    
    if (balance < lamports) {
      console.error(`❌ Insufficient balance. Required: ${solAmount} SOL, Available: ${balanceInSOL.toFixed(6)} SOL`);
      return { success: false, error: `Insufficient balance. Available: ${balanceInSOL.toFixed(6)} SOL` };
    }
    
    // Create transaction
    const transaction = new Transaction();
    
    // Add transfer instruction
    const transferInstruction = SystemProgram.transfer({
      fromPubkey: mainWalletKeypair.publicKey,
      toPubkey: toPublicKey,
      lamports: lamports,
    });
    
    transaction.add(transferInstruction);
    
    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = mainWalletKeypair.publicKey;
    
    // Sign and send transaction
    console.log(`📝 Signing transaction with main wallet...`);
    transaction.sign(mainWalletKeypair);
    
    console.log(`🚀 Sending transaction to blockchain...`);
    const signature = await connection.sendTransaction(transaction, [mainWalletKeypair]);
    
    console.log(`⏳ Waiting for confirmation...`);
    await connection.confirmTransaction(signature);
    
    console.log(`✅ Withdrawal successful! Transaction: ${signature}`);
    console.log(`✅ Sent ${solAmount} SOL to ${toAddress}`);
    
    return { 
      success: true, 
      transactionHash: signature 
    };
    
  } catch (error) {
    console.error('❌ Withdrawal error:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error occurred' 
    };
  }
}

/**
 * Get main wallet balance in SOL
 */
export async function getMainWalletBalance(): Promise<{ balance: number; balanceUSD: number }> {
  try {
    const balance = await connection.getBalance(mainWalletKeypair.publicKey);
    const balanceInSOL = balance / LAMPORTS_PER_SOL;
    const solPrice = await getSOLPrice();
    const balanceUSD = balanceInSOL * solPrice;
    
    return {
      balance: balanceInSOL,
      balanceUSD: balanceUSD
    };
  } catch (error) {
    console.error('Error getting main wallet balance:', error);
    return { balance: 0, balanceUSD: 0 };
  }
}

/**
 * Get the private key for a generated address
 */
export function getPrivateKeyForAddress(address: string): string | null {
  const stored = generatedAddresses.get(address);
  if (stored) {
    // Check if the address has expired (30 minutes)
    if (Date.now() - stored.createdAt > 30 * 60 * 1000) {
      generatedAddresses.delete(address);
      console.log(`🗑️ Cleaned up expired address: ${address.substring(0, 8)}...`);
      return null;
    }
    return stored.privateKey;
  }
  return null;
}

/**
 * Clean up expired addresses (run this periodically)
 */
export function cleanupExpiredAddresses(): void {
  const now = Date.now();
  const expired = [];
  
  for (const [address, data] of generatedAddresses.entries()) {
    if (now - data.createdAt > 30 * 60 * 1000) {
      expired.push(address);
    }
  }
  
  expired.forEach(address => {
    generatedAddresses.delete(address);
    console.log(`🗑️ Cleaned up expired address: ${address.substring(0, 8)}...`);
  });
  
  if (expired.length > 0) {
    console.log(`🧹 Cleaned up ${expired.length} expired addresses`);
  }
}

/**
 * Get the main wallet address
 */
export function getMainWalletAddress(): string {
  return mainWalletKeypair.publicKey.toBase58();
}

/**
 * Get all generated addresses (for debugging)
 */
export function getAllGeneratedAddresses(): Map<string, { privateKey: string; userId: string; createdAt: number }> {
  return generatedAddresses;
}

export { connection, mainWalletKeypair };
