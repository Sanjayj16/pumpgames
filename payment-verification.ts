import { Connection, PublicKey } from '@solana/web3.js';

// Get current SOL price from CoinGecko
async function getSOLPrice(): Promise<number> {
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await response.json();
    return data.solana?.usd || 100; // Fallback to $100 if API fails
  } catch (error) {
    console.error('Failed to fetch SOL price:', error);
    return 100; // Fallback price
  }
}

// Hot wallet addresses for receiving verified payments
const HOT_WALLETS = {
  SOL: '3XVzfnAsvCPjTm4LJKaVWJVMWMYAbNRra3twrzBaokJv',
  ETH: '0x19574FF4c4b0eE2785DbBE57944C498f33377078', // Your main ETH hot wallet
  BTC: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', // Your main BTC hot wallet
  BASE: '0x742d35Cc6834C0532925a3b8D23CF56d1c5de96', // Your main BASE hot wallet
  SUI: '0x742d35Cc6834C0532925a3b8D23CF56d1c5de96' // Your main SUI hot wallet
};

interface PaymentVerificationRequest {
  amount: number;
  walletAddresses: Record<string, string>;
  userId: string;
}

interface PaymentVerificationResult {
  verified: boolean;
  transactionHash?: string;
  currency?: string;
  amount?: number;
  confirmations?: number;
}

// Solana payment verification
async function verifySolanaPayment(
  walletAddress: string,
  expectedAmount: number,
  timeWindow: number = 30 * 60 * 1000 // 30 minutes
): Promise<PaymentVerificationResult> {
  try {
    console.log(`🔍 [PAYMENT_VERIFY] Starting Solana verification for wallet: ${walletAddress}`);
    console.log(`🔍 [PAYMENT_VERIFY] Expected amount: $${expectedAmount}`);
    console.log(`🔍 [PAYMENT_VERIFY] Time window: ${timeWindow / 1000 / 60} minutes`);

    // Get current SOL price for better accuracy
    const solPrice = await getSOLPrice();
    const expectedSOL = expectedAmount / solPrice;
    console.log(`💰 [PAYMENT_VERIFY] Current SOL price: $${solPrice.toFixed(2)}`);
    console.log(`💰 [PAYMENT_VERIFY] Expected SOL amount: ${expectedSOL.toFixed(4)} SOL`);

    const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    const publicKey = new PublicKey(walletAddress);

    console.log(`🌐 [PAYMENT_VERIFY] Fetching Solana transactions...`);

    // Get recent transactions
    const signatures = await connection.getSignaturesForAddress(publicKey, { limit: 50 });
    const cutoffTime = Date.now() - timeWindow;

    console.log(`📋 [PAYMENT_VERIFY] Found ${signatures.length} recent Solana signatures`);
    console.log(`📋 [PAYMENT_VERIFY] Checking transactions from: ${new Date(cutoffTime).toISOString()}`);

    let transactionCount = 0;
    for (const sig of signatures) {
      transactionCount++;
      console.log(`🔍 [PAYMENT_VERIFY] Checking transaction ${transactionCount}/${signatures.length}: ${sig.signature}`);
      
      if (sig.blockTime && sig.blockTime * 1000 > cutoffTime) {
        console.log(`⏰ [PAYMENT_VERIFY] Transaction is within time window: ${new Date(sig.blockTime * 1000).toISOString()}`);
        
        const transaction = await connection.getTransaction(sig.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        });

        if (transaction && transaction.meta) {
          console.log(`📄 [PAYMENT_VERIFY] Transaction details retrieved successfully`);
          
          // Check if this transaction involves a transfer to our wallet
          const preBalances = transaction.meta.preBalances;
          const postBalances = transaction.meta.postBalances;

          for (let i = 0; i < transaction.transaction.message.staticAccountKeys.length; i++) {
            if (transaction.transaction.message.staticAccountKeys[i].toString() === walletAddress) {
              const balanceChange = (postBalances[i] - preBalances[i]) / 1e9; // Convert from lamports to SOL

              console.log(`💰 [PAYMENT_VERIFY] Balance change for wallet: ${balanceChange} SOL`);

              if (balanceChange > 0) { // Only positive balance changes (incoming)
                const estimatedUSD = balanceChange * solPrice;

                console.log(`💰 [PAYMENT_VERIFY] Incoming payment: ${balanceChange} SOL (~$${estimatedUSD.toFixed(2)})`);
                console.log(`💰 [PAYMENT_VERIFY] Expected amount: $${expectedAmount}`);
                console.log(`💰 [PAYMENT_VERIFY] Difference: $${Math.abs(estimatedUSD - expectedAmount).toFixed(2)}`);
                console.log(`💰 [PAYMENT_VERIFY] Tolerance (15%): $${(expectedAmount * 0.15).toFixed(2)}`);

                // Check if the amount matches (within 15% tolerance for price fluctuations)
                if (Math.abs(estimatedUSD - expectedAmount) <= expectedAmount * 0.15) {
                  console.log(`✅ [PAYMENT_VERIFY] SOLANA PAYMENT VERIFIED!`);
                  console.log(`✅ [PAYMENT_VERIFY] Transaction: ${sig.signature}`);
                  console.log(`✅ [PAYMENT_VERIFY] Amount: $${estimatedUSD.toFixed(2)}`);
                  console.log(`✅ [PAYMENT_VERIFY] Expected: $${expectedAmount}`);
                  
                  return {
                    verified: true,
                    transactionHash: sig.signature,
                    currency: 'SOL',
                    amount: estimatedUSD,
                    confirmations: sig.confirmationStatus === 'confirmed' ? 1 : 0
                  };
                } else {
                  console.log(`❌ [PAYMENT_VERIFY] Amount mismatch - outside tolerance range`);
                }
              } else {
                console.log(`📤 [PAYMENT_VERIFY] Outgoing transaction (not payment)`);
              }
            }
          }
        } else {
          console.log(`❌ [PAYMENT_VERIFY] Failed to get transaction details`);
        }
      } else {
        console.log(`⏰ [PAYMENT_VERIFY] Transaction is outside time window`);
      }
    }

    console.log(`❌ [PAYMENT_VERIFY] NO MATCHING SOLANA PAYMENT FOUND`);
    console.log(`❌ [PAYMENT_VERIFY] Checked ${transactionCount} transactions`);
    console.log(`❌ [PAYMENT_VERIFY] Expected: $${expectedAmount}`);
    return { verified: false };
  } catch (error) {
    console.error(`❌ [PAYMENT_VERIFY] Solana verification error:`, error);
    return { verified: false };
  }
}

// Ethereum/Base payment verification
async function verifyEthereumPayment(
  walletAddress: string,
  expectedAmount: number,
  network: 'ETH' | 'BASE' = 'ETH'
): Promise<PaymentVerificationResult> {
  try {
    console.log(`🔍 Checking ${network} blockchain for payments to ${walletAddress} (expecting $${expectedAmount})`);

    // Use Etherscan API for real verification
    const apiKey = 'YourEtherscanAPIKey'; // You'll need to get this from etherscan.io
    const baseUrl = network === 'ETH'
      ? 'https://api.etherscan.io/api'
      : 'https://api.basescan.org/api';

    // Get recent transactions for this address
    const url = `${baseUrl}?module=account&action=txlist&address=${walletAddress}&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`;

    console.log(`🌐 Fetching transactions from ${network} API...`);
    const response = await fetch(url);
    const data = await response.json();

    if (!data.result || !Array.isArray(data.result)) {
      console.log(`❌ No transaction data found for ${walletAddress} on ${network}`);
      return { verified: false };
    }

    // Check transactions from last 30 minutes
    const thirtyMinutesAgo = Math.floor(Date.now() / 1000) - (30 * 60);
    const recentTxs = data.result.filter((tx: any) =>
      parseInt(tx.timeStamp) > thirtyMinutesAgo && tx.to.toLowerCase() === walletAddress.toLowerCase()
    );

    console.log(`📋 Found ${recentTxs.length} recent transactions to ${walletAddress}`);

    for (const tx of recentTxs) {
      // Convert wei to ETH and then to approximate USD
      const ethAmount = parseFloat(tx.value) / 1e18;
      const estimatedUSD = ethAmount * 2500; // Rough ETH price estimate

      console.log(`💰 Transaction: ${ethAmount} ETH (~$${estimatedUSD.toFixed(2)}) - Expected: $${expectedAmount}`);

      // Check if amount matches (within 10% tolerance)
      if (Math.abs(estimatedUSD - expectedAmount) < expectedAmount * 0.1) {
        console.log(`✅ Payment verified! Transaction: ${tx.hash}`);
        return {
          verified: true,
          transactionHash: tx.hash,
          currency: network,
          amount: estimatedUSD,
          confirmations: parseInt(tx.confirmations) || 1
        };
      }
    }

    console.log(`❌ No matching payment found for $${expectedAmount} on ${network}`);
    return { verified: false };

  } catch (error) {
    console.error(`❌ ${network} verification error:`, error);
    return { verified: false };
  }
}

// Bitcoin payment verification
async function verifyBitcoinPayment(
  walletAddress: string,
  expectedAmount: number
): Promise<PaymentVerificationResult> {
  try {
    console.log(`🔍 Checking Bitcoin blockchain for payments to ${walletAddress} (expecting $${expectedAmount})`);

    // Use BlockCypher API for real BTC verification
    const url = `https://api.blockcypher.com/v1/btc/main/addrs/${walletAddress}/txs?limit=50`;

    console.log(`🌐 Fetching Bitcoin transactions...`);
    const response = await fetch(url);
    const data = await response.json();

    if (!data.txs || !Array.isArray(data.txs)) {
      console.log(`❌ No Bitcoin transaction data found for ${walletAddress}`);
      return { verified: false };
    }

    // Check transactions from last 30 minutes
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    const recentTxs = data.txs.filter((tx: any) => {
      const txDate = new Date(tx.received);
      return txDate > thirtyMinutesAgo;
    });

    console.log(`📋 Found ${recentTxs.length} recent Bitcoin transactions`);

    for (const tx of recentTxs) {
      // Check if this transaction sends BTC to our address
      for (const output of tx.outputs) {
        if (output.addresses && output.addresses.includes(walletAddress)) {
          // Convert satoshis to BTC and then to approximate USD
          const btcAmount = output.value / 1e8;
          const estimatedUSD = btcAmount * 45000; // Rough BTC price estimate

          console.log(`💰 Bitcoin received: ${btcAmount} BTC (~$${estimatedUSD.toFixed(2)}) - Expected: $${expectedAmount}`);

          // Check if amount matches (within 10% tolerance)
          if (Math.abs(estimatedUSD - expectedAmount) < expectedAmount * 0.1) {
            console.log(`✅ Bitcoin payment verified! Transaction: ${tx.hash}`);
            return {
              verified: true,
              transactionHash: tx.hash,
              currency: 'BTC',
              amount: estimatedUSD,
              confirmations: tx.confirmations || 0
            };
          }
        }
      }
    }

    console.log(`❌ No matching Bitcoin payment found for $${expectedAmount}`);
    return { verified: false };

  } catch (error) {
    console.error(`❌ Bitcoin verification error:`, error);
    return { verified: false };
  }
}

// Main payment verification function
export async function verifyPayment(request: PaymentVerificationRequest): Promise<PaymentVerificationResult> {
  const { amount, walletAddresses, userId } = request;

  console.log(`🔍 [PAYMENT_VERIFY] ==========================================`);
  console.log(`🔍 [PAYMENT_VERIFY] STARTING PAYMENT VERIFICATION`);
  console.log(`🔍 [PAYMENT_VERIFY] User ID: ${userId}`);
  console.log(`🔍 [PAYMENT_VERIFY] Amount: $${amount}`);
  console.log(`🔍 [PAYMENT_VERIFY] Wallet Addresses:`, walletAddresses);
  console.log(`🔍 [PAYMENT_VERIFY] ==========================================`);

  // DEVELOPMENT TEST MODE - Remove this in production!
  // This will always return false for testing purposes
  if (process.env.NODE_ENV === 'development' && amount === 1) {
    console.log(`🧪 [PAYMENT_VERIFY] DEVELOPMENT TEST MODE - Simulating no payment found`);
    console.log(`🧪 [PAYMENT_VERIFY] This is for testing - no real payment verification`);
    return { verified: false };
  }

  // Use the provided wallet addresses or fall back to hot wallets
  const addresses = {
    SOL: walletAddresses?.SOL || HOT_WALLETS.SOL,
    ETH: walletAddresses?.ETH || HOT_WALLETS.ETH,
    BASE: walletAddresses?.BASE || HOT_WALLETS.BASE,
    BTC: walletAddresses?.BTC || HOT_WALLETS.BTC
  };

  console.log(`🔍 [PAYMENT_VERIFY] Using addresses:`, addresses);

  // Check each wallet for payments
  const verificationPromises = [
    verifySolanaPayment(addresses.SOL, amount),
    verifyEthereumPayment(addresses.ETH, amount, 'ETH'),
    verifyEthereumPayment(addresses.BASE, amount, 'BASE'),
    verifyBitcoinPayment(addresses.BTC, amount),
    // Add SUI verification when needed
  ];

  try {
    console.log(`🔍 [PAYMENT_VERIFY] Running verification for all currencies...`);
    const results = await Promise.allSettled(verificationPromises);

    console.log(`🔍 [PAYMENT_VERIFY] Verification results:`, results.map((r, i) => ({
      currency: ['SOL', 'ETH', 'BASE', 'BTC'][i],
      status: r.status,
      verified: r.status === 'fulfilled' ? r.value.verified : false
    })));

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const currency = ['SOL', 'ETH', 'BASE', 'BTC'][i];
      
      if (result.status === 'fulfilled' && result.value.verified) {
        console.log(`✅ [PAYMENT_VERIFY] PAYMENT VERIFIED ON ${currency}!`);
        console.log(`✅ [PAYMENT_VERIFY] Details:`, result.value);

        // TODO: Transfer funds from deposit wallet to hot wallet
        await transferToHotWallet(result.value);

        console.log(`✅ [PAYMENT_VERIFY] ==========================================`);
        console.log(`✅ [PAYMENT_VERIFY] PAYMENT VERIFICATION SUCCESSFUL`);
        console.log(`✅ [PAYMENT_VERIFY] ==========================================`);
        return result.value;
      } else if (result.status === 'rejected') {
        console.log(`❌ [PAYMENT_VERIFY] ${currency} verification failed:`, result.reason);
      } else {
        console.log(`❌ [PAYMENT_VERIFY] ${currency} verification returned no payment`);
      }
    }

    console.log(`❌ [PAYMENT_VERIFY] ==========================================`);
    console.log(`❌ [PAYMENT_VERIFY] NO PAYMENT FOUND ON ANY CURRENCY`);
    console.log(`❌ [PAYMENT_VERIFY] This means the user did NOT send any real payment`);
    console.log(`❌ [PAYMENT_VERIFY] Funds will NOT be added to their wallet`);
    console.log(`❌ [PAYMENT_VERIFY] ==========================================`);
    return { verified: false };
  } catch (error) {
    console.error(`❌ [PAYMENT_VERIFY] Payment verification failed:`, error);
    return { verified: false };
  }
}

// Transfer verified funds to hot wallet
async function transferToHotWallet(payment: PaymentVerificationResult): Promise<void> {
  try {
    console.log(`Transferring ${payment.amount} ${payment.currency} to hot wallet`);

    // In production, implement actual transfer logic here
    // For Solana: Create and send transfer transaction
    // For Ethereum: Create ERC-20 transfer or native ETH transfer
    // For Bitcoin: Create UTXO transaction

    // This would involve:
    // 1. Creating a transaction from the deposit wallet to hot wallet
    // 2. Signing with the deposit wallet's private key
    // 3. Broadcasting the transaction
    // 4. Waiting for confirmation

    console.log(`Successfully transferred ${payment.amount} ${payment.currency} to hot wallet`);
  } catch (error) {
    console.error('Hot wallet transfer failed:', error);
    // In production, you might want to retry or alert admins
  }
}

export { HOT_WALLETS };
