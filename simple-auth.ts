// Simple file-based authentication - no database needed
import fs from 'fs';
import path from 'path';

const USERS_FILE = path.join(process.cwd(), 'users.json');

interface SimpleUser {
  username: string;
  password: string;
  balance: number;
  holdBalance: number; // Money on hold from active bets
  id: string;
  lastDailyRewardClaim?: string; // ISO date string
  gamesPlayedToday?: number; // Number of games played today
  lastGameDate?: string; // Date of last game played (ISO string)
  hasPlayedGame?: boolean; // Whether user has ever played a game (enables daily rewards)
  isClipper?: boolean; // Whether user is a clipper account (cannot withdraw)
  canWithdraw?: boolean; // Whether user can withdraw money
  createdAt?: number; // Account creation timestamp
  totalGamesPlayed?: number; // Total games played all time
  totalWithdrawn?: number; // Total amount withdrawn
  dailyWithdrawals?: Array<{ date: string; amount: number }>; // Daily withdrawal tracking
  blockedReason?: string; // Reason for blocking user
  blockedAt?: number; // Timestamp when user was blocked
  paymentSessions?: Array<{
    sessionId: string;
    amount: number;
    currency: string;
    walletAddress: string;
    createdAt: number;
    expiresAt: number;
    status: 'pending' | 'completed' | 'expired';
    completedAt?: number;
    transactionHash?: string;
  }>; // Payment sessions for unique addresses
  transactions?: Array<{
    id: string;
    type: 'topup' | 'withdrawal' | 'bet' | 'win' | 'loss';
    amount: number;
    netAmount: number;
    fees?: any; // Fee breakdown object
    timestamp: number;
    method?: string;
    currency?: string;
    transactionHash?: string;
  }>; // Transaction history with fee information
}

// Load users from file
export function loadUsers(): SimpleUser[] {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      const users = JSON.parse(data);
      // Ensure numeric fields are properly converted
      return users.map((user: any) => ({
        ...user,
        balance: Number(user.balance),
        holdBalance: Number(user.holdBalance)
      }));
    }
  } catch (error) {
    console.log('No users file found, starting fresh');
  }
  return [];
}

// Save users to file
export function saveUsers(users: SimpleUser[]): void {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Register new user
export function registerUser(username: string, password: string): { success: boolean; message: string; user?: SimpleUser } {
  const users = loadUsers();
  
  // Check if user exists
  if (users.find(u => u.username === username)) {
    return { success: false, message: 'Username already exists' };
  }

  // Validate input
  if (username.length < 3) {
    return { success: false, message: 'Username must be at least 3 characters' };
  }

  if (password.length < 6) {
    return { success: false, message: 'Password must be at least 6 characters' };
  }

  // Create user
  const newUser: SimpleUser = {
    id: Date.now().toString(),
    username,
    password, // Plain text for simplicity
    balance: 0.00, // Starting balance is $0 - users must top up
    holdBalance: 0.00 // Starting hold balance is $0
  };

  users.push(newUser);
  saveUsers(users);

  return { 
    success: true, 
    message: 'Account created successfully',
    user: { ...newUser, password: '' } // Don't return password
  };
}

// Login user
export function loginUser(username: string, password: string): { success: boolean; message: string; user?: SimpleUser } {
  const users = loadUsers();
  
  const user = users.find(u => u.username === username && u.password === password);
  
  if (!user) {
    return { success: false, message: 'Invalid username or password' };
  }

  return { 
    success: true, 
    message: 'Login successful',
    user: { ...user, password: '' } // Don't return password
  };
}

// Get user by username
export function getUser(username: string): SimpleUser | null {
  const users = loadUsers();
  const user = users.find(u => u.username === username);
  return user ? { ...user, password: '' } : null;
}

// Update user's daily reward claim time
export function updateDailyRewardClaim(username: string, rewardAmount: number = 0.10): { success: boolean; message: string; user?: SimpleUser } {
  const users = loadUsers();
  const userIndex = users.findIndex(u => u.username === username);
  
  if (userIndex === -1) {
    return { success: false, message: 'User not found' };
  }

  const now = new Date().toISOString();
  const lastClaim = users[userIndex].lastDailyRewardClaim;
  
  // Check if user has already claimed today
  if (lastClaim) {
    const lastClaimDate = new Date(lastClaim);
    const nowDate = new Date(now);
    const hoursSinceLastClaim = (nowDate.getTime() - lastClaimDate.getTime()) / (1000 * 60 * 60);
    
    if (hoursSinceLastClaim < 24) {
      const hoursLeft = Math.ceil(24 - hoursSinceLastClaim);
      return { 
        success: false, 
        message: `Daily reward already claimed. Next claim available in ${hoursLeft} hours.` 
      };
    }
  }

  // Update the last claim time and add reward
  users[userIndex].lastDailyRewardClaim = now;
  users[userIndex].balance += rewardAmount;
  
  saveUsers(users);
  
  return {
    success: true,
    message: 'Daily reward claimed successfully!',
    user: { ...users[userIndex], password: '' }
  };
}

// Update username
export function updateUsername(userId: string, newUsername: string): { success: boolean; message: string; user?: SimpleUser } {
  const users = loadUsers();
  const userIndex = users.findIndex(u => u.id === userId);
  
  if (userIndex === -1) {
    return { success: false, message: 'User not found' };
  }

  // Validate new username
  if (newUsername.length < 3) {
    return { success: false, message: 'Username must be at least 3 characters' };
  }

  if (newUsername.length > 20) {
    return { success: false, message: 'Username must be less than 20 characters' };
  }

  // Check if new username already exists (excluding current user)
  const existingUser = users.find(u => u.username === newUsername && u.id !== userId);
  if (existingUser) {
    return { success: false, message: 'Username already taken' };
  }

  // Update username
  users[userIndex].username = newUsername;
  saveUsers(users);
  
  return {
    success: true,
    message: 'Username updated successfully!',
    user: { ...users[userIndex], password: '' }
  };
}

// Place bet - move money from balance to hold balance
export function placeBet(userId: string, betAmount: number): { success: boolean; message: string; user?: SimpleUser } {
  const users = loadUsers();
  const userIndex = users.findIndex(u => u.id === userId);
  
  if (userIndex === -1) {
    return { success: false, message: 'User not found' };
  }

  const user = users[userIndex];
  
  // Check if user has sufficient balance
  const userBalance = Number(user.balance);
  console.log('Server bet validation:', { userId, userBalance, betAmount, userBalanceType: typeof user.balance, betAmountType: typeof betAmount });
  
  if (userBalance < betAmount) {
    return { success: false, message: `Insufficient balance. You have $${userBalance.toFixed(2)} but need $${betAmount.toFixed(2)}` };
  }

  // Move money from balance to hold balance
  users[userIndex].balance = userBalance - betAmount;
  users[userIndex].holdBalance = Number(users[userIndex].holdBalance) + betAmount;
  
  saveUsers(users);
  
  return {
    success: true,
    message: `Bet of $${betAmount.toFixed(2)} placed successfully`,
    user: { ...users[userIndex], password: '' }
  };
}

// Win bet - move hold balance + winnings to main balance
export function winBet(userId: string, betAmount: number, winnings: number): { success: boolean; message: string; user?: SimpleUser } {
  const users = loadUsers();
  const userIndex = users.findIndex(u => u.id === userId);
  
  if (userIndex === -1) {
    return { success: false, message: 'User not found' };
  }

  const user = users[userIndex];
  
  // Check if user has the bet amount in hold balance
  const userHoldBalance = Number(user.holdBalance);
  if (userHoldBalance < betAmount) {
    return { success: false, message: 'Bet amount not found in hold balance' };
  }

  // Move bet back to main balance + add winnings
  users[userIndex].holdBalance = userHoldBalance - betAmount;
  users[userIndex].balance = Number(users[userIndex].balance) + betAmount + winnings;
  
  saveUsers(users);
  
  return {
    success: true,
    message: `Won $${winnings.toFixed(2)}! Total returned: $${(betAmount + winnings).toFixed(2)}`,
    user: { ...users[userIndex], password: '' }
  };
}

// Lose bet - remove money from hold balance (money is lost)
export function loseBet(userId: string, betAmount: number): { success: boolean; message: string; user?: SimpleUser } {
  const users = loadUsers();
  const userIndex = users.findIndex(u => u.id === userId);
  
  if (userIndex === -1) {
    return { success: false, message: 'User not found' };
  }

  const user = users[userIndex];
  
  // Check if user has the bet amount in hold balance
  const userHoldBalance = Number(user.holdBalance);
  if (userHoldBalance < betAmount) {
    return { success: false, message: 'Bet amount not found in hold balance' };
  }

  // Remove bet from hold balance (money is lost)
  users[userIndex].holdBalance = userHoldBalance - betAmount;
  
  saveUsers(users);
  
  return {
    success: true,
    message: `Lost bet of $${betAmount.toFixed(2)}`,
    user: { ...users[userIndex], password: '' }
  };
}

// Migrate existing users who have played games but don't have hasPlayedGame field
export function migrateHasPlayedGame(): { success: boolean; message: string; migratedCount: number } {
  const users = loadUsers();
  let migratedCount = 0;
  
  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    // If user has played games but doesn't have hasPlayedGame field, set it to true
    if ((user.gamesPlayedToday && user.gamesPlayedToday > 0) || user.lastGameDate) {
      if (user.hasPlayedGame === undefined) {
        users[i].hasPlayedGame = true;
        migratedCount++;
      }
    }
  }
  
  if (migratedCount > 0) {
    saveUsers(users);
  }
  
  return {
    success: true,
    message: `Migration completed. ${migratedCount} users updated.`,
    migratedCount
  };
}

// Track game played for daily reward eligibility
export function trackGamePlayed(userId: string): { success: boolean; message: string; user?: SimpleUser } {
  const users = loadUsers();
  const userIndex = users.findIndex(u => u.id === userId);
  
  if (userIndex === -1) {
    return { success: false, message: 'User not found' };
  }

  const user = users[userIndex];
  const today = new Date().toISOString().split('T')[0]; // Get YYYY-MM-DD format
  const lastGameDate = user.lastGameDate ? user.lastGameDate.split('T')[0] : null;

  // Mark that user has played a game (enables daily rewards forever)
  user.hasPlayedGame = true;

  // If it's a new day, reset games played count
  if (lastGameDate !== today) {
    user.gamesPlayedToday = 1;
  } else {
    user.gamesPlayedToday = (user.gamesPlayedToday || 0) + 1;
  }

  user.lastGameDate = new Date().toISOString();
  users[userIndex] = user;
  saveUsers(users);

  return { 
    success: true, 
    message: 'Game tracked successfully',
    user: { ...user, password: '' } // Don't return password
  };
}
