/**
 * 💰 Fee Configuration
 * 
 * Centralized configuration for all platform fees.
 * All rates are configurable from this single file.
 */

export interface FeeConfig {
  // Top-Up Fees (charged on deposits)
  topUp: {
    feeRate: number; // Percentage fee (e.g., 0.20 = 20%)
    description: string;
  };

  // Withdrawal Fees (deducted before sending)
  withdrawal: {
    feeRate: number; // Percentage fee (e.g., 0.05 = 5%)
    description: string;
  };

  // Game Entry Fees (charged on joining games)
  gameEntry: {
    feeRate: number; // Percentage fee (e.g., 0.06 = 6%)
    description: string;
  };

  // Transaction Processing Fees (optional, applied to all wallet actions)
  transactionProcessing: {
    enabled: boolean;
    feeRate: number; // Percentage fee (e.g., 0.01 = 1%)
    description: string;
  };
}

/**
 * Default Fee Configuration
 * 
 * Modify these values to adjust platform fees
 */
export const FEE_CONFIG: FeeConfig = {
  // Top-Up Fees: 20%
  // Example: User deposits $1.00 → receives $0.80, $0.20 goes to platform
  topUp: {
    feeRate: 0.20, // 20%
    description: 'Deposit processing fee'
  },

  // Withdrawal Fees: 5-10%
  // Example: User withdraws $20 → receives $18-19, fee is platform profit
  withdrawal: {
    feeRate: 0.10, // 10% (you can adjust between 0.05-0.10)
    description: 'Withdrawal processing fee'
  },

  // Game Entry Fees: 6%
  // Example: $5 game → user pays $5.30 ($5 to pool, $0.30 to platform)
  gameEntry: {
    feeRate: 0.06, // 6%
    description: 'Game participation fee'
  },

  // Transaction Processing Fees: Optional 1%
  // Applied to all wallet actions (top-up, withdrawal, game join)
  transactionProcessing: {
    enabled: false, // Set to true to enable
    feeRate: 0.01, // 1%
    description: 'Transaction processing fee'
  }
};

/**
 * Fee calculation utilities
 */

/**
 * Calculate top-up fee
 * @param amountEntered - The amount user wants to deposit (e.g., $1.00)
 * @returns { amountCredited, feeApplied, totalSentToWallet }
 */
export function calculateTopUpFee(amountEntered: number) {
  const feeApplied = amountEntered * FEE_CONFIG.topUp.feeRate;
  const amountCredited = amountEntered - feeApplied;
  const totalSentToWallet = amountEntered; // Full amount goes to our wallet

  // Apply transaction processing fee if enabled
  const transactionFee = FEE_CONFIG.transactionProcessing.enabled 
    ? amountCredited * FEE_CONFIG.transactionProcessing.feeRate 
    : 0;
  
  const finalAmountCredited = amountCredited - transactionFee;
  const totalFee = feeApplied + transactionFee;

  return {
    amountEntered,
    amountCredited: finalAmountCredited,
    feeApplied: totalFee,
    totalSentToWallet,
    breakdown: {
      baseFee: feeApplied,
      transactionFee: transactionFee
    }
  };
}

/**
 * Calculate withdrawal fee
 * @param amountRequested - The amount user wants to withdraw (e.g., $20)
 * @returns { amountToSend, feeApplied, amountDeducted }
 */
export function calculateWithdrawalFee(amountRequested: number) {
  const feeApplied = amountRequested * FEE_CONFIG.withdrawal.feeRate;
  const amountToSend = amountRequested - feeApplied;
  const amountDeducted = amountRequested; // Full amount deducted from balance

  // Apply transaction processing fee if enabled
  const transactionFee = FEE_CONFIG.transactionProcessing.enabled 
    ? amountToSend * FEE_CONFIG.transactionProcessing.feeRate 
    : 0;
  
  const finalAmountToSend = amountToSend - transactionFee;
  const totalFee = feeApplied + transactionFee;

  return {
    amountRequested,
    amountToSend: finalAmountToSend,
    feeApplied: totalFee,
    amountDeducted,
    breakdown: {
      baseFee: feeApplied,
      transactionFee: transactionFee
    }
  };
}

/**
 * Calculate game entry fee
 * @param gameAmount - The base game entry cost (e.g., $5)
 * @returns { totalCharged, gamePoolAmount, feeApplied }
 */
export function calculateGameEntryFee(gameAmount: number) {
  const feeApplied = gameAmount * FEE_CONFIG.gameEntry.feeRate;
  const totalCharged = gameAmount + feeApplied;
  const gamePoolAmount = gameAmount; // Only base amount goes to game pool

  // Apply transaction processing fee if enabled
  const transactionFee = FEE_CONFIG.transactionProcessing.enabled 
    ? totalCharged * FEE_CONFIG.transactionProcessing.feeRate 
    : 0;
  
  const finalTotalCharged = totalCharged + transactionFee;
  const totalFee = feeApplied + transactionFee;

  return {
    gameAmount,
    totalCharged: finalTotalCharged,
    gamePoolAmount,
    feeApplied: totalFee,
    breakdown: {
      baseFee: feeApplied,
      transactionFee: transactionFee
    }
  };
}

/**
 * Get fee summary for display
 */
export function getFeeRates() {
  return {
    topUp: `${(FEE_CONFIG.topUp.feeRate * 100).toFixed(0)}%`,
    withdrawal: `${(FEE_CONFIG.withdrawal.feeRate * 100).toFixed(0)}%`,
    gameEntry: `${(FEE_CONFIG.gameEntry.feeRate * 100).toFixed(0)}%`,
    transactionProcessing: FEE_CONFIG.transactionProcessing.enabled 
      ? `${(FEE_CONFIG.transactionProcessing.feeRate * 100).toFixed(0)}%` 
      : 'Disabled'
  };
}

export default FEE_CONFIG;

