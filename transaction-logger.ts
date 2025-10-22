/**
 * 📝 Transaction Logger
 * 
 * Logs all financial transactions with detailed fee breakdown
 */

import { db } from './db';
import { transactions } from './schema';

export type TransactionType = 'topup' | 'withdrawal' | 'game_entry' | 'game_win' | 'game_loss';

export interface TransactionSummary {
  actionType: TransactionType;
  amountEntered: number;
  feeApplied: number;
  amountCreditedToUser?: number; // For top-ups
  amountDebitedFromUser?: number; // For withdrawals/game entries
  totalSentToWallet?: number; // For top-ups
  platformProfit: number;
  timestamp: Date;
  userId: string;
  metadata?: Record<string, any>;
}

/**
 * Log a transaction to the database
 */
export async function logTransaction(summary: TransactionSummary): Promise<void> {
  try {
    const transactionData = {
      userId: summary.userId,
      type: summary.actionType,
      amount: summary.amountEntered.toFixed(4),
      fee: summary.feeApplied.toFixed(4),
      netAmount: (summary.amountCreditedToUser || summary.amountDebitedFromUser || 0).toFixed(4),
      platformProfit: summary.platformProfit.toFixed(4),
      metadata: summary.metadata || {},
      timestamp: summary.timestamp
    };

    await db.insert(transactions).values(transactionData);

    // Log to console for monitoring
    console.log('💰 Transaction logged:', {
      type: summary.actionType,
      user: summary.userId,
      amount: `$${summary.amountEntered.toFixed(2)}`,
      fee: `$${summary.feeApplied.toFixed(2)}`,
      profit: `$${summary.platformProfit.toFixed(2)}`
    });
  } catch (error) {
    console.error('❌ Failed to log transaction:', error);
    // Don't throw error - we don't want transaction logging to break the main flow
  }
}

/**
 * Log a top-up transaction
 */
export async function logTopUpTransaction(
  userId: string,
  amountEntered: number,
  amountCredited: number,
  feeApplied: number,
  metadata?: Record<string, any>
): Promise<void> {
  await logTransaction({
    actionType: 'topup',
    amountEntered,
    feeApplied,
    amountCreditedToUser: amountCredited,
    totalSentToWallet: amountEntered,
    platformProfit: feeApplied,
    timestamp: new Date(),
    userId,
    metadata
  });

  console.log(`
    ═══════════════════════════════════════
    💰 TOP-UP TRANSACTION SUMMARY
    ═══════════════════════════════════════
    User ID: ${userId}
    Amount Entered: $${amountEntered.toFixed(2)}
    Fee Applied: $${feeApplied.toFixed(2)}
    Amount Credited: $${amountCredited.toFixed(2)}
    Platform Profit: $${feeApplied.toFixed(2)}
    Timestamp: ${new Date().toISOString()}
    ═══════════════════════════════════════
  `);
}

/**
 * Log a withdrawal transaction
 */
export async function logWithdrawalTransaction(
  userId: string,
  amountRequested: number,
  amountSent: number,
  feeApplied: number,
  metadata?: Record<string, any>
): Promise<void> {
  await logTransaction({
    actionType: 'withdrawal',
    amountEntered: amountRequested,
    feeApplied,
    amountDebitedFromUser: amountRequested,
    platformProfit: feeApplied,
    timestamp: new Date(),
    userId,
    metadata
  });

  console.log(`
    ═══════════════════════════════════════
    💸 WITHDRAWAL TRANSACTION SUMMARY
    ═══════════════════════════════════════
    User ID: ${userId}
    Amount Requested: $${amountRequested.toFixed(2)}
    Fee Applied: $${feeApplied.toFixed(2)}
    Amount Sent: $${amountSent.toFixed(2)}
    Platform Profit: $${feeApplied.toFixed(2)}
    Timestamp: ${new Date().toISOString()}
    ═══════════════════════════════════════
  `);
}

/**
 * Log a game entry transaction
 */
export async function logGameEntryTransaction(
  userId: string,
  gameAmount: number,
  totalCharged: number,
  feeApplied: number,
  gameId?: string
): Promise<void> {
  await logTransaction({
    actionType: 'game_entry',
    amountEntered: gameAmount,
    feeApplied,
    amountDebitedFromUser: totalCharged,
    platformProfit: feeApplied,
    timestamp: new Date(),
    userId,
    metadata: { gameId, baseGameAmount: gameAmount }
  });

  console.log(`
    ═══════════════════════════════════════
    🎮 GAME ENTRY TRANSACTION SUMMARY
    ═══════════════════════════════════════
    User ID: ${userId}
    Game Amount: $${gameAmount.toFixed(2)}
    Total Charged: $${totalCharged.toFixed(2)}
    Fee Applied: $${feeApplied.toFixed(2)}
    Platform Profit: $${feeApplied.toFixed(2)}
    Game ID: ${gameId || 'N/A'}
    Timestamp: ${new Date().toISOString()}
    ═══════════════════════════════════════
  `);
}

/**
 * Get transaction history for a user
 */
export async function getUserTransactions(
  userId: string,
  limit: number = 50
) {
  try {
    const userTransactions = await db
      .select()
      .from(transactions)
      .where(eq(transactions.userId, userId))
      .orderBy(desc(transactions.timestamp))
      .limit(limit);

    return userTransactions;
  } catch (error) {
    console.error('Error fetching user transactions:', error);
    return [];
  }
}

/**
 * Get platform profit summary
 */
export async function getPlatformProfitSummary(
  startDate?: Date,
  endDate?: Date
) {
  try {
    // This would aggregate all platform profits
    // For now, return a placeholder - implement with proper SQL aggregation
    return {
      totalProfit: 0,
      topUpFees: 0,
      withdrawalFees: 0,
      gameEntryFees: 0,
      transactionCount: 0
    };
  } catch (error) {
    console.error('Error calculating platform profit:', error);
    return null;
  }
}

// Import missing functions
import { eq, desc } from 'drizzle-orm';
