-- Add transactions table for fee tracking
CREATE TABLE IF NOT EXISTS transactions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL REFERENCES users(id),
  type VARCHAR NOT NULL, -- 'topup', 'withdrawal', 'game_entry', 'game_win', 'game_loss'
  amount DECIMAL(10, 4) NOT NULL, -- Original amount
  fee DECIMAL(10, 4) NOT NULL, -- Fee charged
  net_amount DECIMAL(10, 4) NOT NULL, -- Amount after fee
  platform_profit DECIMAL(10, 4) NOT NULL, -- Platform's profit
  metadata JSONB, -- Additional transaction details
  timestamp TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp DESC);

