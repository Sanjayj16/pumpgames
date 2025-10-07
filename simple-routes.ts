import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { registerUser, loginUser, updateDailyRewardClaim, updateUsername, placeBet, winBet, loseBet, loadUsers, saveUsers, trackGamePlayed, migrateHasPlayedGame } from "./simple-auth";
import { verifyPayment } from './payment-verification';
import { generateUserPaymentAddress, checkPaymentToUserAddress, getMainWalletAddress, cleanupExpiredAddresses, getPrivateKeyForAddress, getAllGeneratedAddresses, getSOLPrice, withdrawSOL, getMainWalletBalance, connection } from './wallet-utils';

// SECURITY: Enhanced security functions
async function validateSessionToken(token: string, userId: string): Promise<boolean> {
  // In production, implement proper session validation
  // For now, return true to allow existing functionality
  return true;
}

async function validateCaptcha(token: string, clientIP: string): Promise<boolean> {
  // In production, implement CAPTCHA validation (reCAPTCHA, hCaptcha, etc.)
  // For now, return true to allow existing functionality
  return true;
}

async function checkSuspiciousPatterns(userId: string, clientIP: string, walletAddress: string): Promise<{isSuspicious: boolean, reason?: string}> {
  // Check for suspicious patterns
  const suspiciousIPs = [
    '127.0.0.1', // Localhost (if not expected)
    // Add more suspicious IPs as needed
  ];
  
  const suspiciousUserAgents = [
    'bot', 'crawler', 'scraper', 'python', 'curl', 'wget'
  ];
  
  // Check if IP is suspicious
  if (suspiciousIPs.includes(clientIP)) {
    return { isSuspicious: true, reason: 'Suspicious IP address' };
  }
  
  // Check for rapid successive withdrawals from same user
  if (global.rateLimitStore) {
    const userKey = `withdraw_${userId}_*`;
    const userAttempts = Array.from(global.rateLimitStore.entries())
      .filter(([key]) => key.includes(`withdraw_${userId}`))
      .flatMap(([, attempts]) => attempts);
    
    if (userAttempts.length > 10) {
      return { isSuspicious: true, reason: 'Too many withdrawal attempts' };
    }
  }
  
  return { isSuspicious: false };
}

// SECURITY: Enhanced address validation
function isValidSolanaAddress(address: string): boolean {
  // Enhanced Solana address validation
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  
  if (!base58Regex.test(address)) {
    return false;
  }
  
  // Additional checks
  if (address.length < 32 || address.length > 44) {
    return false;
  }
  
  // Check for common invalid patterns
  const invalidPatterns = [
    /^0+$/, // All zeros
    /^1+$/, // All ones
    /(.)\1{10,}/, // Repeated characters
  ];
  
  for (const pattern of invalidPatterns) {
    if (pattern.test(address)) {
      return false;
    }
  }
  
  return true;
}

// SECURITY: Enhanced amount validation
function isValidWithdrawalAmount(amount: number, solPrice: number): {valid: boolean, reason?: string} {
  const amountInUSD = amount * solPrice;
  
  // Check for extremely small amounts (dust attacks)
  if (amount < 0.000001) {
    return { valid: false, reason: 'Amount too small' };
  }
  
  // Check for suspiciously round numbers (bot behavior)
  const roundedAmount = Math.round(amount * 1000000) / 1000000;
  if (Math.abs(amount - roundedAmount) < 0.000001) {
    // This is a very round number, might be suspicious
    if (amount === 1 || amount === 0.1 || amount === 0.01) {
      return { valid: false, reason: 'Suspicious round amount' };
    }
  }
  
  // Check for amounts that are too precise (likely automated)
  const decimalPlaces = (amount.toString().split('.')[1] || '').length;
  if (decimalPlaces > 6) {
    return { valid: false, reason: 'Amount too precise' };
  }
  
  return { valid: true };
}

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);
  
  console.log('🔧 Creating HTTP server for WebSocket support');
  
  // Ensure the server is ready for WebSocket upgrades
  httpServer.on('upgrade', (request, socket, head) => {
    console.log('🔄 HTTP upgrade request intercepted:', request.url);
    console.log('🔄 Upgrade request headers:', request.headers);
  });
  
  // Cleanup expired addresses on server start
  cleanupExpiredAddresses();
  
  // Set up periodic cleanup every 10 minutes
  setInterval(() => {
    cleanupExpiredAddresses();
  }, 10 * 60 * 1000);

  // Simple Auth routes
  app.post("/api/auth/register", (req, res) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ message: "Username and password required" });
      }

      const result = registerUser(username, password);
      
      if (result.success) {
        res.json({ 
          user: result.user,
          message: result.message 
        });
      } else {
        res.status(400).json({ message: result.message });
      }
    } catch (error) {
      console.error('Registration error:', error);
      res.status(400).json({ message: "Registration failed" });
    }
  });

  app.post("/api/auth/login", (req, res) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ message: "Username and password required" });
      }

      const result = loginUser(username, password);
      
      if (result.success) {
        res.json({ 
          user: result.user,
          message: result.message 
        });
      } else {
        res.status(401).json({ message: result.message });
      }
    } catch (error) {
      console.error('Login error:', error);
      res.status(401).json({ message: "Login failed" });
    }
  });

  // Simple logout
  app.post("/api/auth/logout", (req, res) => {
    res.json({ message: "Logged out successfully" });
  });

  // Migration endpoint to fix existing users who have played games but don't have hasPlayedGame field
  app.post("/api/auth/migrate-has-played-game", (req, res) => {
    try {
      const result = migrateHasPlayedGame();
      res.json({ 
        success: result.success,
        message: result.message,
        migratedCount: result.migratedCount
      });
    } catch (error) {
      console.error('Migration error:', error);
      res.status(500).json({ 
        success: false,
        message: "Migration failed",
        migratedCount: 0
      });
    }
  });

  // Daily reward endpoint
  app.post("/api/auth/claim-daily-reward", (req, res) => {
    try {
      const { username, rewardAmount } = req.body;

      if (!username) {
        return res.status(400).json({ message: "Username required" });
      }

      const result = updateDailyRewardClaim(username, rewardAmount);
      
      if (result.success) {
        res.json({ 
          user: result.user,
          message: result.message 
        });
      } else {
        res.status(400).json({ message: result.message });
      }
    } catch (error) {
      console.error('Daily reward claim error:', error);
      res.status(400).json({ message: "Failed to claim daily reward" });
    }
  });

  // Update username endpoint
  app.post("/api/auth/update-username", (req, res) => {
    try {
      const { userId, newUsername } = req.body;

      if (!userId || !newUsername) {
        return res.status(400).json({ message: "User ID and new username required" });
      }

      const result = updateUsername(userId, newUsername);
      
      if (result.success) {
        res.json({ 
          user: result.user,
          message: result.message 
        });
      } else {
        res.status(400).json({ message: result.message });
      }
    } catch (error) {
      console.error('Username update error:', error);
      res.status(400).json({ message: "Failed to update username" });
    }
  });

  // Add funds to user wallet endpoint
  app.post("/api/wallet/add-funds", (req, res) => {
    try {
      const { userId, amount } = req.body;

      if (!userId || !amount) {
        return res.status(400).json({ message: "User ID and amount required" });
      }

      if (amount <= 0) {
        return res.status(400).json({ message: "Amount must be greater than 0" });
      }

      if (amount > 10000) {
        return res.status(400).json({ message: "Maximum top-up amount is $10,000" });
      }

      const users = loadUsers();
      const userIndex = users.findIndex(u => u.id === userId);
      
      if (userIndex === -1) {
        return res.status(404).json({ message: "User not found" });
      }

      // Add funds to user balance
      users[userIndex].balance += amount;
      saveUsers(users);
      
      res.json({ 
        success: true,
        message: `Successfully added $${amount.toFixed(2)} to your wallet`,
        newBalance: users[userIndex].balance,
        user: { ...users[userIndex], password: '' }
      });
    } catch (error) {
      console.error('Add funds error:', error);
      res.status(500).json({ message: "Failed to add funds" });
    }
  });

  // Get user wallet info endpoint
  app.get("/api/wallet/:userId", (req, res) => {
    try {
      const { userId } = req.params;

      if (!userId) {
        return res.status(400).json({ message: "User ID required" });
      }

      const users = loadUsers();
      const user = users.find(u => u.id === userId);
      
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      res.json({ 
        balance: user.balance,
        holdBalance: user.holdBalance,
        availableBalance: user.balance - user.holdBalance
      });
    } catch (error) {
      console.error('Get wallet error:', error);
      res.status(500).json({ message: "Failed to get wallet info" });
    }
  });

  // Generate payment session for user (using static wallet address)
  app.post("/api/payment/generate-address", async (req, res) => {
    try {
      const { userId, amount, currency } = req.body;

      if (!userId || !amount || !currency) {
        return res.status(400).json({ message: "User ID, amount, and currency required" });
      }

      if (amount <= 0) {
        return res.status(400).json({ message: "Amount must be greater than 0" });
      }

      const users = loadUsers();
      const user = users.find(u => u.id === userId);
      
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Use static wallet address for all payments
      const staticWalletAddress = 'CmDrvqSNKMJmayfqxojaeaVNEBCzgtRPvqccqDxs2ski';
      const paymentSessionId = `${userId}_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
      const createdAt = Date.now();
      const expiresAt = createdAt + (30 * 60 * 1000); // 30 minutes

      // Store the payment session for verification later
      if (!user.paymentSessions) {
        user.paymentSessions = [];
      }
      
      user.paymentSessions.push({
        sessionId: paymentSessionId,
        amount: amount,
        currency: currency,
        walletAddress: staticWalletAddress,
        createdAt: createdAt,
        expiresAt: expiresAt,
        status: 'pending'
      });

      saveUsers(users);

      console.log(`✅ Generated payment session for user ${userId} using static address: ${staticWalletAddress}`);

      res.json({
        success: true,
        paymentSessionId: paymentSessionId,
        walletAddress: staticWalletAddress,
        amount: amount,
        currency: currency,
        expiresAt: expiresAt
      });
    } catch (error) {
      console.error('Generate payment address error:', error);
      res.status(500).json({ message: "Failed to generate payment address" });
    }
  });

  // Cleanup expired addresses endpoint (for maintenance)
  app.post("/api/wallet/cleanup", (req, res) => {
    try {
      cleanupExpiredAddresses();
      res.json({ 
        success: true, 
        message: "Expired addresses cleaned up successfully" 
      });
    } catch (error) {
      console.error('Cleanup error:', error);
      res.status(500).json({ message: "Failed to cleanup addresses" });
    }
  });

  // Debug endpoint to see all generated addresses (remove in production)
  app.get("/api/wallet/debug/addresses", (req, res) => {
    try {
      const addresses = getAllGeneratedAddresses();
      
      const addressList = Array.from(addresses.entries()).map(([address, data]: [string, any]) => ({
        address: address.substring(0, 8) + '...',
        userId: data.userId,
        createdAt: new Date(data.createdAt).toISOString(),
        expired: Date.now() - data.createdAt > 30 * 60 * 1000
      }));
      
      res.json({ 
        success: true, 
        count: addressList.length,
        addresses: addressList
      });
    } catch (error) {
      console.error('Debug error:', error);
      res.status(500).json({ message: "Failed to get debug info" });
    }
  });

  // Test endpoint to manually check payments to main wallet
  app.get("/api/wallet/test-payment/:amount", async (req, res) => {
    try {
      const { amount } = req.params;
      
      console.log(`🧪 Testing payment verification for $${amount}`);
      
      const result = await checkPaymentToUserAddress(
        '3XVzfnAsvCPjTm4LJKaVWJVMWMYAbNRra3twrzBaokJv',
        parseFloat(amount)
      );
      
      res.json({
        success: true,
        amount: parseFloat(amount),
        wallet: 'CmDrvqSNKMJmayfqxojaeaVNEBCzgtRPvqccqDxs2ski',
        result: result
      });
    } catch (error) {
      console.error('Test payment error:', error);
      res.status(500).json({ message: "Failed to test payment verification" });
    }
  });

  // Test endpoint to check payments to a specific user address
  app.get("/api/wallet/test-user-payment/:address/:amount", async (req, res) => {
    try {
      const { address, amount } = req.params;
      
      console.log(`🧪 Testing payment verification for $${amount} to address ${address}`);
      
      const result = await checkPaymentToUserAddress(
        address,
        parseFloat(amount)
      );
      
      res.json({
        success: true,
        amount: parseFloat(amount),
        wallet: address,
        result: result
      });
    } catch (error) {
      console.error('Test user payment error:', error);
      res.status(500).json({ message: "Failed to test user payment verification" });
    }
  });

  // Test endpoint specifically for static wallet payments
  app.get("/api/wallet/test-static-payment/:amount", async (req, res) => {
    try {
      const { amount } = req.params;
      const staticWalletAddress = '3XVzfnAsvCPjTm4LJKaVWJVMWMYAbNRra3twrzBaokJv';
      
      console.log(`🧪 Testing static wallet payment verification for $${amount}`);
      
      const result = await checkPaymentToUserAddress(
        staticWalletAddress,
        parseFloat(amount)
      );
      
      res.json({
        success: true,
        amount: parseFloat(amount),
        wallet: staticWalletAddress,
        result: result
      });
    } catch (error) {
      console.error('Test static payment error:', error);
      res.status(500).json({ message: "Failed to test static payment verification" });
    }
  });

  // Debug endpoint to see all recent transactions on the wallet
  app.get("/api/wallet/debug/transactions", async (req, res) => {
    try {
      const { PublicKey } = await import('@solana/web3.js');
      
      const publicKey = new PublicKey('3XVzfnAsvCPjTm4LJKaVWJVMWMYAbNRra3twrzBaokJv');
      
      // Get recent signatures
      const signatures = await connection.getSignaturesForAddress(publicKey, {
        limit: 10
      });
      
      const transactions = [];
      
      for (const sig of signatures.slice(0, 5)) { // Only check first 5 for performance
        try {
          const transaction = await connection.getTransaction(sig.signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
          });
          
          if (transaction && transaction.meta) {
            const preBalances = transaction.meta.preBalances;
            const postBalances = transaction.meta.postBalances;
            
            for (let i = 0; i < transaction.transaction.message.staticAccountKeys.length; i++) {
              const accountKey = transaction.transaction.message.staticAccountKeys[i].toString();
              
              if (accountKey === '3XVzfnAsvCPjTm4LJKaVWJVMWMYAbNRra3twrzBaokJv') {
                const balanceChange = (postBalances[i] - preBalances[i]) / 1000000000; // Convert from lamports to SOL
                
                if (balanceChange > 0) {
                  transactions.push({
                    signature: sig.signature.substring(0, 16) + '...',
                    timestamp: new Date(sig.blockTime * 1000).toISOString(),
                    solAmount: balanceChange.toFixed(6),
                    blockTime: sig.blockTime
                  });
                }
              }
            }
          }
        } catch (txError) {
          console.error(`Error processing transaction ${sig.signature}:`, txError);
        }
      }
      
      res.json({
        success: true,
        wallet: 'CmDrvqSNKMJmayfqxojaeaVNEBCzgtRPvqccqDxs2ski',
        totalSignatures: signatures.length,
        incomingTransactions: transactions
      });
    } catch (error) {
      console.error('Debug transactions error:', error);
      res.status(500).json({ message: "Failed to get transaction debug info" });
    }
  });

  // Withdraw endpoint - send SOL from main wallet to user's address
  app.post("/api/withdraw", async (req, res) => {
    const startTime = Date.now();
    const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
    const userAgent = req.get('User-Agent') || 'unknown';
    const referer = req.get('Referer') || 'unknown';
    
    try {
      const { userId, walletAddress, amount, sessionToken, captchaToken } = req.body;

      // SECURITY: Log all withdrawal attempts with full details
      console.log(`🔒 WITHDRAWAL ATTEMPT - IP: ${clientIP}, User: ${userId}, Amount: ${amount}, Address: ${walletAddress}, UA: ${userAgent}, Referer: ${referer}`);

      // SECURITY: Validate session token (if provided)
      if (sessionToken) {
        const sessionValid = await validateSessionToken(sessionToken, userId);
        if (!sessionValid) {
          console.log(`🚨 INVALID SESSION - User: ${userId}, IP: ${clientIP}`);
          return res.status(401).json({
            success: false,
            message: 'Invalid session. Please log in again.'
          });
        }
      }

      // SECURITY: Validate CAPTCHA token (if provided)
      if (captchaToken) {
        const captchaValid = await validateCaptcha(captchaToken, clientIP);
        if (!captchaValid) {
          console.log(`🚨 CAPTCHA FAILED - User: ${userId}, IP: ${clientIP}`);
          return res.status(400).json({
            success: false,
            message: 'CAPTCHA verification failed'
          });
        }
      }

      // SECURITY: Enhanced rate limiting with multiple layers
      const rateLimitKey = `withdraw_${userId}_${clientIP}`;
      const globalRateKey = `global_withdraw_${clientIP}`;
      const now = Date.now();
      const rateLimitWindow = 5 * 60 * 1000; // 5 minutes
      const globalRateWindow = 60 * 1000; // 1 minute
      const maxAttempts = 2; // Reduced to 2 attempts per 5 minutes
      const maxGlobalAttempts = 5; // Max 5 attempts per minute from any IP
      
      if (!global.rateLimitStore) {
        global.rateLimitStore = new Map();
      }
      
      // Check user-specific rate limit
      const userAttempts = global.rateLimitStore.get(rateLimitKey) || [];
      const recentUserAttempts = userAttempts.filter((time: number) => now - time < rateLimitWindow);
      
      if (recentUserAttempts.length >= maxAttempts) {
        console.log(`🚨 USER RATE LIMIT EXCEEDED - User: ${userId}, IP: ${clientIP}, Attempts: ${recentUserAttempts.length}`);
        return res.status(429).json({
          success: false,
          message: 'Too many withdrawal attempts. Please wait 5 minutes before trying again.'
        });
      }

      // Check global IP rate limit
      const globalAttempts = global.rateLimitStore.get(globalRateKey) || [];
      const recentGlobalAttempts = globalAttempts.filter((time: number) => now - time < globalRateWindow);
      
      if (recentGlobalAttempts.length >= maxGlobalAttempts) {
        console.log(`🚨 GLOBAL RATE LIMIT EXCEEDED - IP: ${clientIP}, Attempts: ${recentGlobalAttempts.length}`);
        return res.status(429).json({
          success: false,
          message: 'Too many requests from this IP. Please wait 1 minute.'
        });
      }
      
      // Add attempts to rate limit stores
      recentUserAttempts.push(now);
      recentGlobalAttempts.push(now);
      global.rateLimitStore.set(rateLimitKey, recentUserAttempts);
      global.rateLimitStore.set(globalRateKey, recentGlobalAttempts);

      // SECURITY: Check for suspicious patterns
      const suspiciousPatterns = await checkSuspiciousPatterns(userId, clientIP, walletAddress);
      if (suspiciousPatterns.isSuspicious) {
        console.log(`🚨 SUSPICIOUS PATTERN DETECTED - User: ${userId}, Reason: ${suspiciousPatterns.reason}, IP: ${clientIP}`);
        return res.status(403).json({
          success: false,
          message: 'Suspicious activity detected. Withdrawal blocked for security.'
        });
      }

      // Validate input
      if (!userId || !walletAddress || !amount) {
        console.log(`❌ MISSING FIELDS - User: ${userId}, IP: ${clientIP}`);
        return res.status(400).json({
          success: false,
          message: 'Missing required fields: userId, walletAddress, amount'
        });
      }

      // SECURITY: Validate wallet address format with enhanced validation
      if (!isValidSolanaAddress(walletAddress.trim())) {
        console.log(`❌ INVALID ADDRESS - User: ${userId}, Address: ${walletAddress}, IP: ${clientIP}`);
        return res.status(400).json({
          success: false,
          message: 'Invalid Solana wallet address format'
        });
      }

      // SECURITY: Prevent withdrawals to known suspicious addresses
      const suspiciousAddresses = [
        'Hp2BK1wmsHPgbxZ3rHA2okFGHBtpye1nXQUVD5aidzj9', // The address that received your money
        // Add more suspicious addresses as needed
      ];
      
      if (suspiciousAddresses.includes(walletAddress.trim())) {
        console.log(`🚨 SUSPICIOUS ADDRESS BLOCKED - User: ${userId}, Address: ${walletAddress}, IP: ${clientIP}`);
        return res.status(403).json({
          success: false,
          message: 'Withdrawal to this address is not allowed'
        });
      }

      // SECURITY: Enhanced amount validation
      const amountValidation = isValidWithdrawalAmount(withdrawAmount, solPrice);
      if (!amountValidation.valid) {
        console.log(`🚨 INVALID AMOUNT - User: ${userId}, Amount: ${withdrawAmount}, Reason: ${amountValidation.reason}, IP: ${clientIP}`);
        return res.status(400).json({
          success: false,
          message: `Invalid amount: ${amountValidation.reason}`
        });
      }
      const maximumUSD = 1000;
      const amountInUSD = withdrawAmount * solPrice;
      
      if (amountInUSD > maximumUSD) {
        console.log(`🚨 MAXIMUM WITHDRAWAL EXCEEDED - User: ${userId}, Amount: $${amountInUSD}, IP: ${clientIP}`);
        return res.status(400).json({
          success: false,
          message: `Maximum withdrawal amount is $${maximumUSD} USD (approximately ${(maximumUSD / solPrice).toFixed(3)} SOL)`
        });
      }

      // Check minimum withdrawal ($50 USD)
      const minimumUSD = 50;
      if (amountInUSD < minimumUSD) {
        console.log(`❌ MINIMUM WITHDRAWAL NOT MET - User: ${userId}, Amount: $${amountInUSD}, IP: ${clientIP}`);
        return res.status(400).json({
          success: false,
          message: `Minimum withdrawal amount is $${minimumUSD} USD (approximately ${(minimumUSD / solPrice).toFixed(3)} SOL)`
        });
      }

      // Get user and check balance
      const users = loadUsers();
      const user = users.find(u => u.id === userId);
      
      if (!user) {
        console.log(`❌ USER NOT FOUND - User: ${userId}, IP: ${clientIP}`);
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      // SECURITY: Check if user can withdraw (either isClipper or canWithdraw: false)
      if (user.isClipper || user.canWithdraw === false) {
        console.log(`🚨 WITHDRAWAL BLOCKED - User: ${userId}, Type: ${user.isClipper ? 'clipper' : 'no-withdraw'}, IP: ${clientIP}`);
        return res.status(403).json({
          success: false,
          message: 'Withdrawals are not allowed for this account type'
        });
      }

      // SECURITY: Check account age (prevent withdrawals from new accounts)
      const accountAge = Date.now() - (user.createdAt || Date.now());
      const minimumAccountAge = 24 * 60 * 60 * 1000; // 24 hours
      if (accountAge < minimumAccountAge) {
        console.log(`🚨 ACCOUNT TOO NEW - User: ${userId}, Age: ${accountAge}ms, IP: ${clientIP}`);
        return res.status(403).json({
          success: false,
          message: 'Account must be at least 24 hours old to withdraw'
        });
      }

      // SECURITY: Check for suspicious user behavior
      if (user.totalGamesPlayed < 5) {
        console.log(`🚨 INSUFFICIENT GAME ACTIVITY - User: ${userId}, Games: ${user.totalGamesPlayed}, IP: ${clientIP}`);
        return res.status(403).json({
          success: false,
          message: 'Must play at least 5 games before withdrawing'
        });
      }

      // SECURITY: Check daily withdrawal limit
      const today = new Date().toDateString();
      const userDailyWithdrawals = user.dailyWithdrawals || {};
      const todayWithdrawn = userDailyWithdrawals[today] || 0;
      const dailyLimitUSD = 200; // $200 per day limit
      
      if (todayWithdrawn + amountInUSD > dailyLimitUSD) {
        console.log(`🚨 DAILY LIMIT EXCEEDED - User: ${userId}, Today: $${todayWithdrawn}, Requested: $${amountInUSD}, IP: ${clientIP}`);
        return res.status(403).json({
          success: false,
          message: `Daily withdrawal limit exceeded. Remaining: $${dailyLimitUSD - todayWithdrawn}`
        });
      }

      // solPrice already fetched above for minimum validation
      const userBalanceInSOL = user.balance / solPrice;

      console.log(`💰 User ${userId} balance: $${user.balance} (${userBalanceInSOL.toFixed(6)} SOL)`);
      console.log(`💸 Requested withdrawal: ${withdrawAmount} SOL ($${(withdrawAmount * solPrice).toFixed(2)})`);

      // SECURITY: Check if user has sufficient balance
      if (userBalanceInSOL < withdrawAmount) {
        console.log(`❌ INSUFFICIENT BALANCE - User: ${userId}, Available: ${userBalanceInSOL.toFixed(6)} SOL, Requested: ${withdrawAmount} SOL, IP: ${clientIP}`);
        return res.status(400).json({
          success: false,
          message: `Insufficient balance. Available: ${userBalanceInSOL.toFixed(6)} SOL ($${user.balance.toFixed(2)})`
        });
      }

      // SECURITY: Check main wallet balance
      const mainWalletBalance = await getMainWalletBalance();
      console.log(`💳 Main wallet balance: ${mainWalletBalance.balance.toFixed(6)} SOL ($${mainWalletBalance.balanceUSD.toFixed(2)})`);

      if (mainWalletBalance.balance < withdrawAmount) {
        console.log(`🚨 MAIN WALLET INSUFFICIENT - Required: ${withdrawAmount} SOL, Available: ${mainWalletBalance.balance.toFixed(6)} SOL, IP: ${clientIP}`);
        return res.status(400).json({
          success: false,
          message: `Insufficient main wallet balance. Available: ${mainWalletBalance.balance.toFixed(6)} SOL`
        });
      }

      // SECURITY: Additional validation - prevent extremely large withdrawals
      if (withdrawAmount > 10) { // More than 10 SOL
        console.log(`🚨 LARGE WITHDRAWAL BLOCKED - User: ${userId}, Amount: ${withdrawAmount} SOL, IP: ${clientIP}`);
        return res.status(400).json({
          success: false,
          message: 'Withdrawal amount too large. Please contact support for large withdrawals.'
        });
      }

      // Process withdrawal
      console.log(`🚀 Processing withdrawal: ${withdrawAmount} SOL to ${walletAddress} for user ${userId}`);
      
      const withdrawalResult = await withdrawSOL(walletAddress, withdrawAmount, userId);

      if (withdrawalResult.success) {
        // Update user balance
        const withdrawalAmountUSD = withdrawAmount * solPrice;
        user.balance -= withdrawalAmountUSD;
        
        // SECURITY: Track daily withdrawals
        const today = new Date().toDateString();
        if (!user.dailyWithdrawals) {
          user.dailyWithdrawals = {};
        }
        user.dailyWithdrawals[today] = (user.dailyWithdrawals[today] || 0) + withdrawalAmountUSD;
        
        // SECURITY: Track total withdrawals
        user.totalWithdrawn = (user.totalWithdrawn || 0) + withdrawalAmountUSD;
        
        // Save users
        saveUsers(users);

        const processingTime = Date.now() - startTime;
        console.log(`✅ WITHDRAWAL SUCCESS - User: ${userId}, Amount: ${withdrawAmount} SOL ($${withdrawalAmountUSD.toFixed(2)}), Address: ${walletAddress}, Hash: ${withdrawalResult.transactionHash}, Time: ${processingTime}ms, IP: ${clientIP}`);
        
        res.json({
          success: true,
          message: 'Withdrawal successful',
          transactionHash: withdrawalResult.transactionHash,
          newBalance: user.balance,
          withdrawnAmount: withdrawAmount,
          withdrawnAmountUSD: withdrawalAmountUSD,
          dailyWithdrawn: user.dailyWithdrawals[today],
          totalWithdrawn: user.totalWithdrawn
        });
      } else {
        console.error(`❌ WITHDRAWAL FAILED - User: ${userId}, Error: ${withdrawalResult.error}, IP: ${clientIP}`);
        res.status(500).json({
          success: false,
          message: withdrawalResult.error || 'Withdrawal failed'
        });
      }

    } catch (error) {
      const processingTime = Date.now() - startTime;
      console.error(`🚨 WITHDRAWAL ERROR - User: ${userId}, Error: ${error}, Time: ${processingTime}ms, IP: ${clientIP}`);
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  });

  // SECURITY: Monitor suspicious withdrawal activity
  app.get("/api/security/withdrawal-monitor", async (req, res) => {
    try {
      const { userId } = req.query;
      
      if (!userId) {
        return res.status(400).json({
          success: false,
          message: 'User ID required'
        });
      }

      // Get user's recent withdrawal attempts from rate limit store
      const rateLimitKey = `withdraw_${userId}_*`;
      const suspiciousAttempts = [];
      
      if (global.rateLimitStore) {
        for (const [key, attempts] of global.rateLimitStore.entries()) {
          if (key.includes(`withdraw_${userId}`)) {
            suspiciousAttempts.push({
              key,
              attempts: attempts.length,
              lastAttempt: Math.max(...attempts)
            });
          }
        }
      }

      res.json({
        success: true,
        userId,
        suspiciousAttempts,
        totalAttempts: suspiciousAttempts.reduce((sum, item) => sum + item.attempts, 0)
      });
    } catch (error) {
      console.error('Security monitor error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get security data'
      });
    }
  });

  // SECURITY: Admin endpoint to monitor all withdrawal activity
  app.get("/api/admin/withdrawal-monitor", async (req, res) => {
    try {
      const { adminKey } = req.query;
      
      // Simple admin key check (in production, use proper authentication)
      if (adminKey !== 'admin_security_key_2024') {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized'
        });
      }

      const users = loadUsers();
      const suspiciousUsers = [];
      const recentWithdrawals = [];
      
      // Find suspicious users
      for (const user of users) {
        const suspiciousFlags = [];
        
        if (user.totalWithdrawn > 1000) {
          suspiciousFlags.push('High total withdrawals');
        }
        
        if (user.dailyWithdrawals) {
          const today = new Date().toDateString();
          const todayWithdrawn = user.dailyWithdrawals[today] || 0;
          if (todayWithdrawn > 500) {
            suspiciousFlags.push('High daily withdrawals');
          }
        }
        
        if (user.totalGamesPlayed < 10 && user.totalWithdrawn > 100) {
          suspiciousFlags.push('Low game activity, high withdrawals');
        }
        
        if (suspiciousFlags.length > 0) {
          suspiciousUsers.push({
            userId: user.id,
            username: user.username,
            flags: suspiciousFlags,
            totalWithdrawn: user.totalWithdrawn || 0,
            totalGamesPlayed: user.totalGamesPlayed || 0,
            dailyWithdrawals: user.dailyWithdrawals || {}
          });
        }
      }
      
      // Get rate limit data
      const rateLimitData = global.rateLimitStore ? 
        Array.from(global.rateLimitStore.entries()).map(([key, attempts]) => ({
          key,
          attempts: attempts.length,
          lastAttempt: Math.max(...attempts)
        })) : [];

      res.json({
        success: true,
        suspiciousUsers,
        rateLimitData,
        totalUsers: users.length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Admin monitor error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get admin data'
      });
    }
  });

  // SECURITY: Block suspicious user endpoint
  app.post("/api/admin/block-user", async (req, res) => {
    try {
      const { adminKey, userId, reason } = req.body;
      
      if (adminKey !== 'admin_security_key_2024') {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized'
        });
      }

      const users = loadUsers();
      const user = users.find(u => u.id === userId);
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      // Block user from withdrawals
      user.canWithdraw = false;
      user.blockedReason = reason || 'Suspicious activity';
      user.blockedAt = Date.now();
      
      saveUsers(users);
      
      console.log(`🚨 USER BLOCKED - User: ${userId}, Reason: ${reason}`);
      
      res.json({
        success: true,
        message: 'User blocked successfully'
      });
    } catch (error) {
      console.error('Block user error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to block user'
      });
    }
  });

  // Get main wallet balance endpoint
  app.get("/api/wallet/main/balance", async (req, res) => {
    try {
      const balance = await getMainWalletBalance();
      res.json({
        success: true,
        balance: balance.balance,
        balanceUSD: balance.balanceUSD,
        walletAddress: getMainWalletAddress()
      });
    } catch (error) {
      console.error('Error getting main wallet balance:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get wallet balance'
      });
    }
  });

  // Place bet endpoint
  app.post("/api/game/place-bet", (req, res) => {
    try {
      const { userId, betAmount } = req.body;

      if (!userId || !betAmount) {
        return res.status(400).json({ message: "User ID and bet amount required" });
      }

      const result = placeBet(userId, betAmount);
      
      if (result.success) {
        res.json({ 
          user: result.user,
          message: result.message 
        });
      } else {
        res.status(400).json({ message: result.message });
      }
    } catch (error) {
      console.error('Place bet error:', error);
      res.status(400).json({ message: "Failed to place bet" });
    }
  });

  // Win bet endpoint
  app.post("/api/game/win-bet", (req, res) => {
    try {
      const { userId, betAmount, winnings } = req.body;

      if (!userId || !betAmount || winnings === undefined) {
        return res.status(400).json({ message: "User ID, bet amount, and winnings required" });
      }

      const result = winBet(userId, betAmount, winnings);
      
      if (result.success) {
        // Track that the user played a game
        trackGamePlayed(userId);
        
        res.json({ 
          user: result.user,
          message: result.message 
        });
      } else {
        res.status(400).json({ message: result.message });
      }
    } catch (error) {
      console.error('Win bet error:', error);
      res.status(400).json({ message: "Failed to process win" });
    }
  });

  // Lose bet endpoint
  app.post("/api/game/lose-bet", (req, res) => {
    try {
      const { userId, betAmount } = req.body;

      if (!userId || !betAmount) {
        return res.status(400).json({ message: "User ID and bet amount required" });
      }

      const result = loseBet(userId, betAmount);
      
      if (result.success) {
        // Track that the user played a game
        trackGamePlayed(userId);
        
        res.json({ 
          user: result.user,
          message: result.message 
        });
      } else {
        res.status(400).json({ message: result.message });
      }
    } catch (error) {
      console.error('Lose bet error:', error);
      res.status(400).json({ message: "Failed to process loss" });
    }
  });

  // Payment verification route
  app.post('/api/verify-payment', async (req, res) => {
    try {
      const { paymentSessionId, userId } = req.body;
      
      if (!paymentSessionId || !userId) {
        return res.status(400).json({ 
          verified: false, 
          message: 'Missing required fields: paymentSessionId, userId' 
        });
      }

      console.log(`🔍 Payment verification request:`, { paymentSessionId, userId });
      
      // Find the user and their payment session
      const users = loadUsers();
      const user = users.find(u => u.id === userId);
      
      if (!user) {
        console.log(`❌ User not found: ${userId}`);
        return res.status(404).json({
          verified: false,
          message: 'User not found'
        });
      }

      // Find the payment session
      const paymentSession = user.paymentSessions?.find(
        (session: any) => session.sessionId === paymentSessionId
      );

      if (!paymentSession) {
        console.log(`❌ Payment session not found: ${paymentSessionId}`);
        return res.status(404).json({
          verified: false,
          message: 'Payment session not found'
        });
      }

      // Check if payment session is already completed
      if (paymentSession.status === 'completed') {
        console.log(`⚠️ Payment session already completed: ${paymentSessionId}`);
        return res.status(400).json({
          verified: false,
          message: 'This payment has already been processed and credited to your account.'
        });
      }

      // Check if payment session has expired (60 minutes - increased for slower verification)
      if (Date.now() - paymentSession.createdAt > 60 * 60 * 1000) {
        console.log(`⏰ Payment session expired: ${paymentSessionId}`);
        return res.status(400).json({
          verified: false,
          message: 'Payment session has expired. Please create a new payment request.'
        });
      }

      console.log(`✅ Payment session found:`, {
        sessionId: paymentSession.sessionId,
        walletAddress: paymentSession.walletAddress,
        amount: paymentSession.amount,
        currency: paymentSession.currency,
        status: paymentSession.status
      });

      // Get list of all processed transaction hashes to prevent duplicates
      const allProcessedTransactions = new Set<string>();
      users.forEach(u => {
        if (u.paymentSessions) {
          u.paymentSessions.forEach((session: any) => {
            if (session.transactionHash && session.status === 'completed') {
              allProcessedTransactions.add(session.transactionHash);
            }
          });
        }
      });

      console.log(`📋 Found ${allProcessedTransactions.size} already processed transactions`);

      // Verify payment using the static wallet address
      const staticWalletAddress = '3XVzfnAsvCPjTm4LJKaVWJVMWMYAbNRra3twrzBaokJv';
      console.log(`🔍 Checking payment to static address: ${staticWalletAddress} for amount: $${paymentSession.amount}`);
      const verificationResult = await checkPaymentToUserAddress(
        staticWalletAddress,
        paymentSession.amount
      );
      
      console.log(`📊 Verification result:`, verificationResult);
      
      if (verificationResult.verified) {
        // Check if this transaction hash has already been processed
        if (verificationResult.transactionHash && allProcessedTransactions.has(verificationResult.transactionHash)) {
          console.log(`⚠️ Transaction ${verificationResult.transactionHash} has already been processed`);
          return res.status(400).json({
            verified: false,
            message: 'This payment transaction has already been processed. Please check your account balance.'
          });
        }

        // Update user balance and mark payment session as completed
        const userIndex = users.findIndex(u => u.id === userId);
        
        if (userIndex >= 0) {
          users[userIndex].balance = (users[userIndex].balance || 0) + paymentSession.amount;
          
          // Mark payment session as completed
          if (users[userIndex].paymentSessions) {
            const sessionIndex = users[userIndex].paymentSessions.findIndex(
              (session: any) => session.sessionId === paymentSessionId
            );
            if (sessionIndex >= 0) {
              users[userIndex].paymentSessions[sessionIndex].status = 'completed';
              users[userIndex].paymentSessions[sessionIndex].completedAt = Date.now();
              users[userIndex].paymentSessions[sessionIndex].transactionHash = verificationResult.transactionHash;
              (users[userIndex].paymentSessions[sessionIndex] as any).verifiedAmount = verificationResult.actualAmount || paymentSession.amount;
            }
          }
          
          saveUsers(users);
          
          console.log(`✅ Payment verified successfully! User ${userId} balance updated to $${users[userIndex].balance.toFixed(2)}`);
          console.log(`🔗 Transaction hash: ${verificationResult.transactionHash}`);
          
          res.json({
            verified: true,
            transactionHash: verificationResult.transactionHash,
            currency: 'SOL',
            amount: verificationResult.actualAmount || paymentSession.amount,
            newBalance: users[userIndex].balance
          });
        } else {
          res.status(500).json({
            verified: false,
            message: 'Failed to update user balance'
          });
        }
      } else {
        console.log(`❌ No payment detected for user ${userId} to static address ${staticWalletAddress}`);
        res.json({
          verified: false,
          message: 'No payment detected. Please ensure your transaction is confirmed and try again.'
        });
      }
    } catch (error) {
      console.error('Payment verification error:', error);
      res.status(500).json({
        verified: false,
        message: 'Payment verification failed'
      });
    }
  });

  // Dynamic game room endpoint that finds or creates available rooms
  app.get("/api/room/join", (req, res) => {
    const requestedRegion = req.query.region as string || 'us';
    
    // Validate region
    if (requestedRegion !== 'us' && requestedRegion !== 'eu') {
      return res.status(400).json({ message: 'Invalid region. Must be "us" or "eu"' });
    }
    
    // Find best available room or create new one
    const room = findBestRoom(requestedRegion);
    
    if (!room) {
      return res.status(500).json({ message: 'Failed to find or create room' });
    }
    
    res.json({ 
      roomId: room.id, 
      region: room.region, 
      currentPlayers: room.players.size + (room.bots ? room.bots.size : 0),
      maxPlayers: room.maxPlayers,
      arenaSize: room.gameState.arenaSize
    });
  });

  // WebSocket setup for multiplayer game
  const gameRooms = new Map();
  const playerToRoom = new Map();

  // Create basic rooms with dynamic player capacity and bots
  function createRoom(region: string, id: number, gameMode: string = 'normal') {
    const roomKey = `${region}:${id}`;
    if (!gameRooms.has(roomKey)) {
      const isFriendMode = gameMode === 'friends';
      const room = {
        id,
        region,
        players: new Map(),
        bots: new Map(),
        maxPlayers: isFriendMode ? 2 : 80, // Only 2 players in friend mode
        gameMode: gameMode,
        gameState: {
          players: new Map(),
          food: [],
          lastUpdate: Date.now(),
          arenaSize: calculateArenaSize(isFriendMode ? 6 : 15) // 6 bots in friend mode, 15 in normal mode
        }
      };
      gameRooms.set(roomKey, room);
      
      // Create bots for both modes - fewer bots in friend mode
      if (isFriendMode) {
        createBots(room, 6);
        console.log(`Created room ${region}/${id} in friend mode with capacity 2 players and 6 bots`);
      } else {
        createBots(room, 15);
        console.log(`Created room ${region}/${id} in normal mode with capacity 80 players and 15 bots`);
      }
    }
  }

  // Calculate arena size based on player count
  function calculateArenaSize(playerCount: number) {
    // Base arena size: 2000x2000
    // Scales from 1500x1500 (1 player) to 4000x4000 (80 players)
    const baseSize = 2000;
    const minSize = 1500;
    const maxSize = 4000;
    
    if (playerCount <= 1) return { width: minSize, height: minSize };
    if (playerCount >= 80) return { width: maxSize, height: maxSize };
    
    // Linear scaling between min and max
    const scaleFactor = (playerCount - 1) / 79; // 0 to 1 range
    const currentSize = minSize + (maxSize - minSize) * scaleFactor;
    
    return { 
      width: Math.round(currentSize), 
      height: Math.round(currentSize) 
    };
  }

  // Update arena size for a room based on current player count (including bots)
  function updateArenaSize(room: any) {
    const totalCount = room.players.size + (room.bots ? room.bots.size : 0);
    const newArenaSize = calculateArenaSize(totalCount);
    
    // Only update if there's a significant change (at least 50 pixels)
    const currentArena = room.gameState.arenaSize;
    const sizeDifference = Math.abs(currentArena.width - newArenaSize.width);
    
    if (sizeDifference >= 50) {
      room.gameState.arenaSize = newArenaSize;
      
      // Broadcast arena size update to all players in the room
      const arenaSizeMessage = JSON.stringify({
        type: 'arenaSize',
        arenaSize: newArenaSize,
        playerCount: totalCount
      });
      
      room.players.forEach((playerData: any, playerId: string) => {
        if (playerData.ws && playerData.ws.readyState === 1) {
          playerData.ws.send(arenaSizeMessage);
        }
      });
      
      console.log(`Updated arena size for room ${room.region}:${room.id} to ${newArenaSize.width}x${newArenaSize.height} (${room.players.size} players + ${room.bots ? room.bots.size : 0} bots)`);
    }
  }

  // Bot creation and management
  function createBots(room: any, count: number) {
    const botNames = [
      'SnakeBot_Alpha', 'SnakeBot_Beta', 'SnakeBot_Gamma', 'SnakeBot_Delta', 'SnakeBot_Epsilon',
      'SnakeBot_Zeta', 'SnakeBot_Eta', 'SnakeBot_Theta', 'SnakeBot_Iota', 'SnakeBot_Kappa',
      'SnakeBot_Lambda', 'SnakeBot_Mu', 'SnakeBot_Nu', 'SnakeBot_Xi', 'SnakeBot_Omicron',
      'SnakeBot_Pi', 'SnakeBot_Rho', 'SnakeBot_Sigma', 'SnakeBot_Tau', 'SnakeBot_Upsilon'
    ];
    
    const botColors = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57', '#ff9ff3', '#54a0ff', '#fd79a8'];
    
    for (let i = 0; i < count; i++) {
      const botId = `bot_${room.region}_${room.id}_${i}`;
      const centerX = 2000;
      const centerY = 2000;
      const radius = Math.min(room.gameState.arenaSize.width, room.gameState.arenaSize.height) / 2;
      
      // Spawn bots in safe positions
      const angle = (i / count) * Math.PI * 2;
      const spawnRadius = radius * 0.3 + Math.random() * radius * 0.4;
      const spawnX = centerX + Math.cos(angle) * spawnRadius;
      const spawnY = centerY + Math.sin(angle) * spawnRadius;
      
      const bot = {
        id: botId,
        name: botNames[i % botNames.length],
        segments: [{ x: spawnX, y: spawnY }],
        color: botColors[i % botColors.length],
        mass: 15 + Math.random() * 20,
        direction: Math.random() * Math.PI * 2,
        speed: 1.5 + Math.random() * 0.5,
        targetX: spawnX,
        targetY: spawnY,
        lastDirectionChange: Date.now(),
        isBot: true,
        money: 1.00,
        segmentRadius: 10,
        cashingOut: false,
        cashOutProgress: 0
      };
      
      room.bots.set(botId, bot);
      room.gameState.players.set(botId, bot);
    }
    
    console.log(`Created ${count} bots in room ${room.region}/${room.id}`);
  }

  // Bot AI behavior
  function updateBots(room: any) {
    if (!room.bots) return;
    
    const currentTime = Date.now();
    const centerX = 2000;
    const centerY = 2000;
    const radius = Math.min(room.gameState.arenaSize.width, room.gameState.arenaSize.height) / 2;
    
    room.bots.forEach((bot: any) => {
      // Change direction periodically or when reaching target
      const distToTarget = Math.sqrt((bot.segments[0].x - bot.targetX) ** 2 + (bot.segments[0].y - bot.targetY) ** 2);
      
      if (distToTarget < 50 || currentTime - bot.lastDirectionChange > 3000 + Math.random() * 2000) {
        // Pick new random target within arena
        const targetAngle = Math.random() * Math.PI * 2;
        const targetRadius = Math.random() * radius * 0.8;
        bot.targetX = centerX + Math.cos(targetAngle) * targetRadius;
        bot.targetY = centerY + Math.sin(targetAngle) * targetRadius;
        bot.lastDirectionChange = currentTime;
      }
      
      // Move towards target
      const directionToTarget = Math.atan2(bot.targetY - bot.segments[0].y, bot.targetX - bot.segments[0].x);
      bot.direction = directionToTarget;
      
      // Update position
      const newX = bot.segments[0].x + Math.cos(bot.direction) * bot.speed;
      const newY = bot.segments[0].y + Math.sin(bot.direction) * bot.speed;
      
      // Keep bots within arena bounds
      const distFromCenter = Math.sqrt((newX - centerX) ** 2 + (newY - centerY) ** 2);
      if (distFromCenter > radius - 50) {
        // Turn towards center
        bot.direction = Math.atan2(centerY - bot.segments[0].y, centerX - bot.segments[0].x);
        bot.targetX = centerX;
        bot.targetY = centerY;
      }
      
      // Update segments (simple trail)
      const head = { x: newX, y: newY };
      bot.segments.unshift(head);
      
      // Limit segments based on mass
      const maxSegments = Math.floor(bot.mass / 3);
      if (bot.segments.length > maxSegments) {
        bot.segments = bot.segments.slice(0, maxSegments);
      }
      
      // Update in game state
      room.gameState.players.set(bot.id, bot);
    });
  }

  // Smart spawning system
  function findSafeSpawnPosition(room: any): { x: number; y: number; isOuterRing: boolean } {
    const arenaSize = room.gameState.arenaSize;
    const centerX = arenaSize.width / 2;
    const centerY = arenaSize.height / 2;
    const radius = Math.min(arenaSize.width, arenaSize.height) * 0.45;
    const minDistance = 300; // Minimum distance from other snakes
    
    // Get all current player positions
    const existingPlayers = Array.from(room.gameState.players.values()).filter((p: any) => 
      p.segments && p.segments.length > 0
    );
    
    // Function to check if a position is safe
    const isPositionSafe = (x: number, y: number): boolean => {
      for (const player of existingPlayers) {
        if (player.segments && player.segments.length > 0) {
          const headX = player.segments[0]?.x || 0;
          const headY = player.segments[0]?.y || 0;
          const distance = Math.sqrt((x - headX) ** 2 + (y - headY) ** 2);
          if (distance < minDistance) {
            return false;
          }
        }
      }
      return true;
    };
    
    // Try to find safe spot in low-density areas (divide arena into grid)
    const gridSize = 8;
    const cellWidth = arenaSize.width / gridSize;
    const cellHeight = arenaSize.height / gridSize;
    const densityMap: number[][] = [];
    
    // Initialize density map
    for (let i = 0; i < gridSize; i++) {
      densityMap[i] = [];
      for (let j = 0; j < gridSize; j++) {
        densityMap[i][j] = 0;
      }
    }
    
    // Calculate density for each grid cell
    for (const player of existingPlayers) {
      if (player.segments && player.segments.length > 0) {
        const headX = player.segments[0]?.x || centerX;
        const headY = player.segments[0]?.y || centerY;
        const gridX = Math.floor((headX - (centerX - arenaSize.width/2)) / cellWidth);
        const gridY = Math.floor((headY - (centerY - arenaSize.height/2)) / cellHeight);
        
        if (gridX >= 0 && gridX < gridSize && gridY >= 0 && gridY < gridSize) {
          densityMap[gridX][gridY]++;
          // Also increase density in neighboring cells
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              const nx = gridX + dx;
              const ny = gridY + dy;
              if (nx >= 0 && nx < gridSize && ny >= 0 && ny < gridSize) {
                densityMap[nx][ny] += 0.5;
              }
            }
          }
        }
      }
    }
    
    // Find lowest density cells and try to spawn there
    const lowDensityCells: { x: number; y: number; density: number }[] = [];
    for (let i = 0; i < gridSize; i++) {
      for (let j = 0; j < gridSize; j++) {
        lowDensityCells.push({ x: i, y: j, density: densityMap[i][j] });
      }
    }
    
    // Sort by density (lowest first)
    lowDensityCells.sort((a, b) => a.density - b.density);
    
    // Try to spawn in lowest density areas within arena bounds
    for (const cell of lowDensityCells) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const cellCenterX = (centerX - arenaSize.width/2) + (cell.x + 0.5) * cellWidth;
        const cellCenterY = (centerY - arenaSize.height/2) + (cell.y + 0.5) * cellHeight;
        
        // Add some randomness within the cell
        const offsetX = (Math.random() - 0.5) * cellWidth * 0.8;
        const offsetY = (Math.random() - 0.5) * cellHeight * 0.8;
        const spawnX = cellCenterX + offsetX;
        const spawnY = cellCenterY + offsetY;
        
        // Check if position is within arena bounds
        const distFromCenter = Math.sqrt((spawnX - centerX) ** 2 + (spawnY - centerY) ** 2);
        if (distFromCenter <= radius - 50 && isPositionSafe(spawnX, spawnY)) {
          return { x: spawnX, y: spawnY, isOuterRing: false };
        }
      }
    }
    
    // If no safe spot found, spawn in outer ring
    const outerRadius = radius + 100; // Outside the arena
    const angle = Math.random() * Math.PI * 2;
    const spawnX = centerX + Math.cos(angle) * outerRadius;
    const spawnY = centerY + Math.sin(angle) * outerRadius;
    
    console.log(`⚠️ No safe spawn found, spawning in outer ring at (${spawnX.toFixed(1)}, ${spawnY.toFixed(1)})`);
    return { x: spawnX, y: spawnY, isOuterRing: true };
  }

  function findBestRoom(region: string, gameMode: string = 'normal') {
    // For friend mode, look for existing friend rooms first
    if (gameMode === 'friends') {
      for (const [key, room] of gameRooms.entries()) {
        if (room.region === region && room.gameMode === 'friends' && room.players.size < room.maxPlayers) {
          console.log(`🎮 Found existing friend room: ${room.region}:${room.id} with ${room.players.size} players`);
          return room;
        }
      }
      // Create new friend room if none available
      const newRoomId = Date.now(); // Use timestamp for unique room IDs
      console.log(`🎮 Creating new friend room: ${region}:${newRoomId}`);
      createRoom(region, newRoomId, gameMode);
      return gameRooms.get(`${region}:${newRoomId}`);
    } else {
      // Normal mode - use existing logic
      for (const [key, room] of gameRooms.entries()) {
        if (room.region === region && room.gameMode === 'normal' && room.players.size < room.maxPlayers) {
          return room;
        }
      }
      // Create new normal room if none available
      const newRoomId = gameRooms.size + 1;
      createRoom(region, newRoomId, gameMode);
      return gameRooms.get(`${region}:${newRoomId}`);
    }
  }

  // Create WebSocket server with proper configuration
  const wss = new WebSocketServer({ 
    server: httpServer,
    path: '/ws',
    perMessageDeflate: false, // Disable compression for better compatibility
    verifyClient: (info) => {
      console.log('🔍 WebSocket client verification:', {
        origin: info.origin,
        secure: info.secure,
        req: info.req.url
      });
      return true; // Accept all connections
    }
  });

  console.log('🔌 WebSocket server created with path: /ws');
  console.log('🔌 WebSocket server listening on:', httpServer.address());
  
  // Override the upgrade handler to ensure it works
  httpServer.on('upgrade', (request, socket, head) => {
    console.log('🔄 HTTP upgrade request received:', request.url);
    console.log('🔄 Upgrade headers:', request.headers);
    console.log('🔄 Connection header:', request.headers.connection);
    console.log('🔄 Upgrade header:', request.headers.upgrade);
    console.log('🔄 WebSocket server clients:', wss.clients.size);
    
    // Handle WebSocket upgrade manually if needed
    if (request.url?.startsWith('/ws')) {
      console.log('🎯 Handling WebSocket upgrade for:', request.url);
      wss.handleUpgrade(request, socket, head, (ws) => {
        console.log('✅ WebSocket upgrade handled successfully');
        wss.emit('connection', ws, request);
      });
    }
  });

  // Create initial rooms for both regions if none exist
  if (gameRooms.size === 0) {
    createRoom('us', 1, 'normal');
    createRoom('eu', 1, 'normal');
  }

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      websocket: 'active',
      websocketPath: '/ws',
      rooms: gameRooms.size,
      totalPlayers: Array.from(gameRooms.values()).reduce((sum, room) => sum + room.players.size, 0),
      serverAddress: httpServer.address()
    });
  });

  // WebSocket health check endpoint
  app.get('/ws-health', (req, res) => {
    res.json({
      websocket: 'active',
      path: '/ws',
      connections: wss.clients.size,
      server: 'running'
    });
  });

  // Add error handling for WebSocket server
  wss.on('error', (error) => {
    console.error('❌ WebSocket server error:', error);
  });

  wss.on("connection", function connection(ws: any, req: any) {
    const playerId = `player_${Date.now()}_${Math.random()}`;
    console.log(`🔌 New WebSocket connection established. Player: ${playerId}, Total connections: ${wss.clients.size}`);
    console.log(`🔌 Connection from: ${req.headers.origin || 'unknown origin'}`);
    console.log(`🔌 Request URL: ${req.url}`);
    console.log(`🔌 WebSocket ready state: ${ws.readyState}`);
    
    // Extract room ID, region, and mode from query parameters 
    let url: URL;
    try {
      url = new URL(req.url, `http://${req.headers.host}`);
    } catch (error) {
      console.error(`❌ Invalid WebSocket URL: ${req.url}`, error);
      ws.close(1002, 'Invalid URL');
      return;
    }
    
    const requestedRoomId = parseInt(url.searchParams.get('room') || '1');
    const requestedRegion = url.searchParams.get('region') || 'us';
    const gameMode = url.searchParams.get('mode') || 'normal'; // 'friends' or 'normal'
    
    console.log(`🎮 Player ${playerId} connecting - Mode: ${gameMode}, Region: ${requestedRegion}, Room: ${requestedRoomId}`);
    
    // Validate region
    if (requestedRegion !== 'us' && requestedRegion !== 'eu') {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid region'
      }));
      ws.close();
      return;
    }
    
    // For friend mode, try to use the specific room ID first
    let targetRoom;
    if (gameMode === 'friends' && requestedRoomId) {
      const roomKey = `${requestedRegion}:${requestedRoomId}`;
      targetRoom = gameRooms.get(roomKey);
      
      if (targetRoom) {
        console.log(`🎮 Using existing friend room: ${targetRoom.region}:${targetRoom.id} with ${targetRoom.players.size} players`);
      } else {
        // Create the specific friend room if it doesn't exist
        console.log(`🎮 Creating specific friend room: ${requestedRegion}:${requestedRoomId}`);
        createRoom(requestedRegion, requestedRoomId, gameMode);
        targetRoom = gameRooms.get(roomKey);
      }
    } else {
      // Use normal room finding logic
      targetRoom = findBestRoom(requestedRegion, gameMode);
    }
    
    console.log(`🏠 Using room ${targetRoom.region}:${targetRoom.id} with mode: ${targetRoom.gameMode}, players: ${targetRoom.players.size}/${targetRoom.maxPlayers}`);
    
    // Check if room is full
    if (targetRoom.players.size >= targetRoom.maxPlayers) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Room is full'
      }));
      ws.close();
      return;
    }
    
    ws.playerId = playerId;
    ws.roomId = targetRoom.id;
    ws.region = targetRoom.region;
    const finalRoomKey = `${targetRoom.region}:${targetRoom.id}`;
    playerToRoom.set(playerId, finalRoomKey);
    
    console.log(`Player ${playerId} joined room ${targetRoom.region}/${targetRoom.id}. Room players: ${targetRoom.players.size + 1}/${targetRoom.maxPlayers}`);
    
    // Find safe spawn position using smart spawning
    const spawnPosition = findSafeSpawnPosition(targetRoom);
    
    // Assign different colors to different players
    const colors = ['#d55400', '#4ecdc4', '#ff6b6b', '#45b7d1', '#96ceb4', '#feca57', '#ff9ff3', '#54a0ff'];
    const playerColor = colors[targetRoom.players.size % colors.length];
    
    const player = {
      id: playerId,
      segments: [{ x: spawnPosition.x, y: spawnPosition.y }], // Start with spawn position
      color: playerColor,
      mass: 20,
      direction: 0,
      speed: 2,
      spawnTime: Date.now(),
      isGhost: true, // Start in ghost mode
      isOuterRing: spawnPosition.isOuterRing,
      spawnX: spawnPosition.x,
      spawnY: spawnPosition.y
    };

    targetRoom.players.set(playerId, player);
    targetRoom.gameState.players.set(playerId, player);

    // Update arena size based on new player count
    updateArenaSize(targetRoom);

    // Broadcast player list to all players in the room
    const broadcastPlayerList = () => {
      const allPlayers = Array.from(targetRoom.gameState.players.values());
      
      // Send all players including bots for both friend and normal mode
      const playersToSend = allPlayers;
        
      const message = JSON.stringify({
        type: 'players',
        players: playersToSend
      });
      
      targetRoom.players.forEach((_, pid) => {
        const playerWs = Array.from(wss.clients).find((client: any) => client.playerId === pid);
        if (playerWs && playerWs.readyState === 1) {
          playerWs.send(message);
        }
      });
    };

    // Send welcome message with player ID
    ws.send(JSON.stringify({
      type: 'welcome',
      playerId: playerId,
      room: finalRoomKey,
      playerCount: targetRoom.players.size + (targetRoom.bots ? targetRoom.bots.size : 0),
      arenaSize: targetRoom.gameState.arenaSize
    }));

    // Send initial player list
    broadcastPlayerList();

    // Handle player messages
    ws.on("message", function message(data: any) {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'ping') {
          // Respond to ping with pong
          ws.send(JSON.stringify({
            type: 'pong',
            timestamp: message.timestamp,
            serverTime: Date.now()
          }));
          return;
        } else if (message.type === 'playerUpdate') {
          const player = targetRoom.players.get(playerId);
          if (player) {
            // Check if ghost mode should end (player moved or boosted)
            if (player.isGhost && (message.data.segments || message.data.direction !== undefined)) {
              player.isGhost = false;
              console.log(`👻 Player ${playerId} exited ghost mode (moved)`);
            }
            
            // Update player position
            Object.assign(player, message.data);
            targetRoom.gameState.players.set(playerId, player);
          }
        } else if (message.type === 'boost') {
          const player = targetRoom.players.get(playerId);
          if (player && player.isGhost) {
            player.isGhost = false;
            console.log(`👻 Player ${playerId} exited ghost mode (boosted)`);
          }
        } else if (message.type === 'gameOver') {
          // Handle game over for friend mode
          if (targetRoom.gameMode === 'friends' && message.reason === 'friend_mode_ended') {
            console.log(`🎮 Friend mode game ended in room ${targetRoom.region}:${targetRoom.id}`);
            
            // Mark all players in the room as dead
            targetRoom.players.forEach((player, id) => {
              player.isDead = true;
              player.gameOver = true;
              targetRoom.gameState.players.set(id, player);
            });
            
            // Broadcast game over to all players in the room
            const gameOverMessage = JSON.stringify({
              type: 'friendGameEnded',
              reason: 'friend_mode_ended'
            });
            
            targetRoom.players.forEach((playerData: any, playerId: string) => {
              if (playerData.ws && playerData.ws.readyState === 1) {
                playerData.ws.send(gameOverMessage);
              }
            });
          }
        }
      } catch (error) {
        console.error('Error processing message:', error);
      }
    });

    // Handle errors
    ws.on("error", function error(err: Error) {
      console.error(`❌ WebSocket error for player ${playerId} in room ${finalRoomKey}:`, err);
      
      // Clean up on error
      if (targetRoom.players.has(playerId)) {
        targetRoom.players.delete(playerId);
        targetRoom.gameState.players.delete(playerId);
      }
      playerToRoom.delete(playerId);
      
      // Update arena size and broadcast changes
      updateArenaSize(targetRoom);
      broadcastPlayerList();
    });

    // Handle disconnect
    ws.on("close", function close(code: number, reason: Buffer) {
      const reasonStr = reason ? reason.toString() : 'No reason provided';
      console.log(`❌ Player ${playerId} left room ${finalRoomKey}. Code: ${code}, Reason: ${reasonStr}, WasClean: ${code === 1000}`);
      
      // Remove player from room
      if (targetRoom.players.has(playerId)) {
        targetRoom.players.delete(playerId);
        targetRoom.gameState.players.delete(playerId);
      }
      
      playerToRoom.delete(playerId);
      console.log(`🏠 Room ${finalRoomKey} now has ${targetRoom.players.size}/${targetRoom.maxPlayers} players`);
      
      // Update arena size based on reduced player count
      updateArenaSize(targetRoom);
      
      // Broadcast updated player list to remaining players
      broadcastPlayerList();
    });

    // Send game state updates
    const gameLoop = setInterval(() => {
      if (ws.readyState === 1) { // WebSocket.OPEN
        try {
          const players = Array.from(targetRoom.gameState.players.values());
          const bots = Array.from(targetRoom.bots ? targetRoom.bots.values() : []);
          
          // Send players message (for backward compatibility)
          ws.send(JSON.stringify({
            type: 'players',
            players: players
          }));
          
          // Send gameWorld message with both bots and players
          ws.send(JSON.stringify({
            type: 'gameWorld',
            bots: bots,
            players: players
          }));
        } catch (error) {
          console.error(`❌ Error sending game state to player ${playerId}:`, error);
          clearInterval(gameLoop);
        }
      } else {
        console.log(`🔄 Clearing game loop for player ${playerId} - WebSocket not open (readyState: ${ws.readyState})`);
        clearInterval(gameLoop);
      }
    }, 50); // 20 FPS
  });

  // Game loop for ghost mode expiration and outer ring sliding
  setInterval(() => {
    const currentTime = Date.now();
    
    gameRooms.forEach((room) => {
      let hasUpdates = false;
      
      room.players.forEach((player: any, playerId: string) => {
        // Handle ghost mode expiration (1.5 seconds)
        if (player.isGhost && currentTime - player.spawnTime > 1500) {
          player.isGhost = false;
          hasUpdates = true;
          console.log(`👻 Player ${playerId} ghost mode expired after 1.5s`);
        }
        
        // Handle outer ring sliding into arena
        if (player.isOuterRing && player.segments && player.segments.length > 0) {
          const arenaSize = room.gameState.arenaSize;
          const centerX = arenaSize.width / 2;
          const centerY = arenaSize.height / 2;
          const radius = Math.min(arenaSize.width, arenaSize.height) * 0.45;
          
          const headX = player.segments[0].x;
          const headY = player.segments[0].y;
          const distFromCenter = Math.sqrt((headX - centerX) ** 2 + (headY - centerY) ** 2);
          
          // If still outside arena, slide towards center
          if (distFromCenter > radius - 50) {
            const slideSpeed = 2; // Units per update
            const angle = Math.atan2(centerY - headY, centerX - headX);
            const newX = headX + Math.cos(angle) * slideSpeed;
            const newY = headY + Math.sin(angle) * slideSpeed;
            
            player.segments[0].x = newX;
            player.segments[0].y = newY;
            hasUpdates = true;
          } else {
            // Player has slid into arena
            player.isOuterRing = false;
            hasUpdates = true;
            console.log(`🏟️ Player ${playerId} slid into arena`);
          }
        }
      });
      
      // Broadcast updates if needed
      if (hasUpdates) {
        const players = Array.from(room.gameState.players.values());
        const message = JSON.stringify({
          type: 'players',
          players: players
        });
        
        room.players.forEach((_, pid: string) => {
          const playerWs = Array.from(wss.clients).find((client: any) => client.playerId === pid);
          if (playerWs && playerWs.readyState === 1) {
            playerWs.send(message);
          }
        });
      }
    });
  }, 100); // Update every 100ms

  // Bot update loop - runs every 200ms
  setInterval(() => {
    gameRooms.forEach((room) => {
      // Ensure minimum bot count for both modes
      const currentBotCount = room.bots ? room.bots.size : 0;
      const minBots = room.gameMode === 'friends' ? 6 : 15; // 6 bots for friend mode, 15 for normal mode
      
      if (currentBotCount < minBots) {
        if (!room.bots) {
          room.bots = new Map();
        }
        const botsToAdd = minBots - currentBotCount;
        createBots(room, botsToAdd);
        updateArenaSize(room);
      }
      
      // Update bot behavior for both modes
      updateBots(room);
      
      // Broadcast updated player list (filter bots for friend mode)
      if (room.players.size > 0) {
        const allPlayers = Array.from(room.gameState.players.values());
        
        // Send all players including bots for both friend and normal mode
        const playersToSend = allPlayers;
          
        const message = JSON.stringify({
          type: 'players',
          players: playersToSend
        });
        
        room.players.forEach((_, playerId: string) => {
          const playerWs = Array.from(wss.clients).find((client: any) => client.playerId === playerId);
          if (playerWs && playerWs.readyState === 1) {
            playerWs.send(message);
          }
        });
      }
    });
  }, 200); // Update bots every 200ms

  return httpServer;
}
