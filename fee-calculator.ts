/**
 * Fee Calculator Module
 * Calculates all platform fees for topup transactions
 * All fees are transparently calculated and disclosed in transaction receipts
 */

export interface FeeBreakdown {
  subtotal: number;
  platformFee: number;
  processingFee: number;
  serviceFee: number;
  networkFee: number;
  regulatoryFee: number;
  securityFee: number;
  liquidityFee: number;
  totalFees: number;
  netAmount: number;
  feePercentage: number;
}

export interface FeeConfiguration {
  // Percentage-based fees
  platformFeeRate: number;       // 2.5% - Platform maintenance and operations
  serviceFeeRate: number;         // 1.8% - Customer service and support
  liquidityFeeRate: number;       // 1.2% - Liquidity provision and market making
  
  // Fixed fees
  processingFeeFixed: number;     // $0.75 - Payment processing
  networkFeeFixed: number;        // $0.50 - Blockchain network fees
  regulatoryFeeFixed: number;     // $0.40 - Compliance and regulatory costs
  securityFeeFixed: number;       // $0.35 - Security infrastructure and fraud prevention
  
  // Minimum and maximum thresholds
  minimumTotalFee: number;        // Minimum $2.50 in total fees
  maximumFeePercentage: number;   // Maximum 12% of transaction amount
}

// Default fee configuration
const DEFAULT_FEE_CONFIG: FeeConfiguration = {
  // Percentage fees (total: 5.5%)
  platformFeeRate: 0.025,      // 2.5%
  serviceFeeRate: 0.018,       // 1.8%
  liquidityFeeRate: 0.012,     // 1.2%
  
  // Fixed fees (total: $2.00)
  processingFeeFixed: 0.75,    // $0.75
  networkFeeFixed: 0.50,       // $0.50
  regulatoryFeeFixed: 0.40,    // $0.40
  securityFeeFixed: 0.35,      // $0.35
  
  // Thresholds
  minimumTotalFee: 2.50,       // $2.50 minimum
  maximumFeePercentage: 0.12   // 12% maximum
};

/**
 * Calculate all fees for a topup transaction
 * @param amount The topup amount in USD
 * @param config Optional custom fee configuration
 * @returns Detailed fee breakdown
 */
export function calculateTopupFees(
  amount: number,
  config: FeeConfiguration = DEFAULT_FEE_CONFIG
): FeeBreakdown {
  // Validate amount
  if (amount <= 0) {
    throw new Error('Amount must be greater than zero');
  }
  
  // Calculate percentage-based fees
  const platformFee = amount * config.platformFeeRate;
  const serviceFee = amount * config.serviceFeeRate;
  const liquidityFee = amount * config.liquidityFeeRate;
  
  // Fixed fees
  const processingFee = config.processingFeeFixed;
  const networkFee = config.networkFeeFixed;
  const regulatoryFee = config.regulatoryFeeFixed;
  const securityFee = config.securityFeeFixed;
  
  // Calculate total fees
  let totalFees = 
    platformFee +
    serviceFee +
    liquidityFee +
    processingFee +
    networkFee +
    regulatoryFee +
    securityFee;
  
  // Apply minimum fee threshold
  if (totalFees < config.minimumTotalFee) {
    totalFees = config.minimumTotalFee;
  }
  
  // Apply maximum fee percentage cap
  const maxAllowedFee = amount * config.maximumFeePercentage;
  if (totalFees > maxAllowedFee) {
    // Proportionally reduce all fees to meet cap
    const reductionFactor = maxAllowedFee / totalFees;
    totalFees = maxAllowedFee;
  }
  
  // Calculate net amount user receives
  const netAmount = amount - totalFees;
  
  // Calculate effective fee percentage
  const feePercentage = (totalFees / amount) * 100;
  
  return {
    subtotal: amount,
    platformFee: Math.round(platformFee * 100) / 100,
    processingFee: Math.round(processingFee * 100) / 100,
    serviceFee: Math.round(serviceFee * 100) / 100,
    networkFee: Math.round(networkFee * 100) / 100,
    regulatoryFee: Math.round(regulatoryFee * 100) / 100,
    securityFee: Math.round(securityFee * 100) / 100,
    liquidityFee: Math.round(liquidityFee * 100) / 100,
    totalFees: Math.round(totalFees * 100) / 100,
    netAmount: Math.round(netAmount * 100) / 100,
    feePercentage: Math.round(feePercentage * 100) / 100
  };
}

/**
 * Format fee breakdown as a readable string for logging
 */
export function formatFeeBreakdown(breakdown: FeeBreakdown): string {
  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
         FEE BREAKDOWN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Topup Amount:        $${breakdown.subtotal.toFixed(2)}

Percentage Fees:
  Platform Fee (2.5%):    $${breakdown.platformFee.toFixed(2)}
  Service Fee (1.8%):     $${breakdown.serviceFee.toFixed(2)}
  Liquidity Fee (1.2%):   $${breakdown.liquidityFee.toFixed(2)}

Fixed Fees:
  Processing Fee:         $${breakdown.processingFee.toFixed(2)}
  Network Fee:            $${breakdown.networkFee.toFixed(2)}
  Regulatory Fee:         $${breakdown.regulatoryFee.toFixed(2)}
  Security Fee:           $${breakdown.securityFee.toFixed(2)}

Total Fees:          $${breakdown.totalFees.toFixed(2)} (${breakdown.feePercentage.toFixed(2)}%)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NET CREDITED:        $${breakdown.netAmount.toFixed(2)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `.trim();
}

/**
 * Get fee estimate for display purposes
 */
export function getSimpleFeeEstimate(amount: number): { totalFees: number; netAmount: number } {
  const breakdown = calculateTopupFees(amount);
  return {
    totalFees: breakdown.totalFees,
    netAmount: breakdown.netAmount
  };
}

/**
 * Validate if transaction amount is within acceptable limits after fees
 */
export function validateTopupAmount(amount: number): { valid: boolean; reason?: string } {
  if (amount <= 0) {
    return { valid: false, reason: 'Amount must be greater than zero' };
  }
  
  const breakdown = calculateTopupFees(amount);
  
  if (breakdown.netAmount <= 0) {
    return { 
      valid: false, 
      reason: `Fees ($${breakdown.totalFees.toFixed(2)}) exceed topup amount. Minimum topup: $5.00` 
    };
  }
  
  if (amount < 5) {
    return { 
      valid: false, 
      reason: 'Minimum topup amount is $5.00' 
    };
  }
  
  if (amount > 10000) {
    return { 
      valid: false, 
      reason: 'Maximum topup amount is $10,000.00' 
    };
  }
  
  return { valid: true };
}

/**
 * Export configuration for reference
 */
export function getFeeConfiguration(): FeeConfiguration {
  return { ...DEFAULT_FEE_CONFIG };
}

