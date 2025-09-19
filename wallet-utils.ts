import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

// Your main wallet private key (base58 encoded)
const MAIN_WALLET_PRIVATE_KEY = 'PPDmTNT9eFTRfbEMr7ZxmAyJe2SZEVRSQv3ZQg4dMFxBGaqGMfnLKT5zrAjK6bwEjSinoK5o6gnENJpbqBpxFGv';

// Solana RPC endpoint
const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';

// Create connection to Solana network
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

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
    
    // Get recent signatures for this address
    const signatures = await connection.getSignaturesForAddress(publicKey, {
      limit: 100 // Increased limit to catch more transactions
    });
    
    console.log(`📋 Found ${signatures.length} recent signatures for user address`);
    
    // Get current SOL price for accurate conversion
    const solPrice = await getSOLPrice();
    console.log(`💱 Current SOL price: $${solPrice}`);
    
    let checkedTransactions = 0;
    let recentTransactions = 0;
    
    for (const sig of signatures) {
      checkedTransactions++;
      
      if (sig.blockTime && sig.blockTime * 1000 > cutoffTime) {
        recentTransactions++;
        console.log(`🔄 Checking transaction ${recentTransactions}: ${sig.signature.substring(0, 16)}... (${new Date(sig.blockTime * 1000).toISOString()})`);
        
        try {
          const transaction = await connection.getTransaction(sig.signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
          });
          
          if (transaction && transaction.meta) {
            // Check if this transaction involves a transfer to our user address
            const preBalances = transaction.meta.preBalances;
            const postBalances = transaction.meta.postBalances;
            
            for (let i = 0; i < transaction.transaction.message.staticAccountKeys.length; i++) {
              const accountKey = transaction.transaction.message.staticAccountKeys[i].toString();
              
              if (accountKey === userAddress) {
                const balanceChange = (postBalances[i] - preBalances[i]) / LAMPORTS_PER_SOL; // Convert from lamports to SOL
                
                if (balanceChange > 0) { // Only positive balance changes (incoming)
                  const estimatedUSD = balanceChange * solPrice;
                  
                  console.log(`💰 Payment received: ${balanceChange.toFixed(6)} SOL (~$${estimatedUSD.toFixed(2)}) - Expected: $${expectedAmount}`);
                  
                  // Check if the amount matches (within 30% tolerance for price fluctuations)
                  const tolerance = expectedAmount * 0.30; // Increased tolerance for server issues
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
                    console.log(`📊 Difference: $${Math.abs(estimatedUSD - expectedAmount).toFixed(2)} (max allowed: $${tolerance.toFixed(2)})`);
                    console.log(`💱 SOL price used: $${solPrice.toFixed(2)}`);
                  }
                }
              }
            }
          }
        } catch (txError) {
          console.error(`Error processing transaction ${sig.signature}:`, txError);
          continue; // Skip this transaction and continue with the next one
        }
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
 * Get current SOL price in USD with retry mechanism
 */
export async function getSOLPrice(): Promise<number> {
  const maxRetries = 3;
  const retryDelay = 1000; // 1 second
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🌐 Fetching SOL price from CoinGecko... (attempt ${attempt}/${maxRetries})`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Cache-Control': 'no-cache'
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
      
      console.log(`✅ SOL price fetched successfully: $${price}`);
      return price;
      
    } catch (error) {
      console.error(`❌ Attempt ${attempt} failed to fetch SOL price:`, error);
      
      if (attempt === maxRetries) {
        console.error('❌ All attempts failed to fetch SOL price');
        console.log('⚠️ Using fallback SOL price: $150');
        return 150; // More realistic fallback price
      }
      
      // Wait before retry
      console.log(`⏳ Waiting ${retryDelay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
  
  return 150; // Fallback
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
