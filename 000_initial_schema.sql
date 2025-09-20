-- Initial database schema for the pumpgame
-- Run this first to create all basic tables

-- Create users table
CREATE TABLE IF NOT EXISTS "users" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "username" text NOT NULL UNIQUE,
  "password" text NOT NULL,
  "balance" decimal(10, 4) DEFAULT '0.0000' NOT NULL,
  "sol_balance" decimal(10, 8) DEFAULT '0.00000000' NOT NULL,
  "total_earnings" decimal(10, 2) DEFAULT '0.00' NOT NULL,
  "games_played" integer DEFAULT 0 NOT NULL,
  "kills" integer DEFAULT 0 NOT NULL,
  "deaths" integer DEFAULT 0 NOT NULL,
  "snake_color" text DEFAULT '#00FF88' NOT NULL,
  "is_online" boolean DEFAULT false NOT NULL,
  "last_active" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- Create games table
CREATE TABLE IF NOT EXISTS "games" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "region" text NOT NULL,
  "bet_amount" decimal(10, 2) NOT NULL,
  "players_count" integer DEFAULT 0 NOT NULL,
  "max_players" integer DEFAULT 20 NOT NULL,
  "status" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "started_at" timestamp,
  "ended_at" timestamp
);

-- Create game_participants table
CREATE TABLE IF NOT EXISTS "game_participants" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "game_id" varchar NOT NULL REFERENCES games(id),
  "user_id" varchar NOT NULL REFERENCES users(id),
  "kills" integer DEFAULT 0 NOT NULL,
  "earnings" decimal(10, 2) DEFAULT '0.00' NOT NULL,
  "is_alive" boolean DEFAULT true NOT NULL,
  "joined_at" timestamp DEFAULT now() NOT NULL,
  "eliminated_at" timestamp
);

-- Create daily_crates table
CREATE TABLE IF NOT EXISTS "daily_crates" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" varchar NOT NULL REFERENCES users(id),
  "claimed_at" timestamp DEFAULT now() NOT NULL,
  "reward" decimal(10, 4) NOT NULL
);

-- Create game_states table
CREATE TABLE IF NOT EXISTS "game_states" (
  "id" varchar PRIMARY KEY,
  "data" jsonb NOT NULL,
  "last_updated" timestamp DEFAULT now() NOT NULL
);

-- Create indexes for users table
CREATE INDEX IF NOT EXISTS "users_username_idx" ON "users" ("username");
CREATE INDEX IF NOT EXISTS "users_balance_idx" ON "users" ("balance");
CREATE INDEX IF NOT EXISTS "users_is_online_idx" ON "users" ("is_online");

-- Create indexes for games table
CREATE INDEX IF NOT EXISTS "games_status_idx" ON "games" ("status");
CREATE INDEX IF NOT EXISTS "games_region_idx" ON "games" ("region");

-- Create indexes for game_participants table
CREATE INDEX IF NOT EXISTS "game_participants_game_id_idx" ON "game_participants" ("game_id");
CREATE INDEX IF NOT EXISTS "game_participants_user_id_idx" ON "game_participants" ("user_id");

-- Create indexes for daily_crates table
CREATE INDEX IF NOT EXISTS "daily_crates_user_id_idx" ON "daily_crates" ("user_id");
CREATE INDEX IF NOT EXISTS "daily_crates_claimed_at_idx" ON "daily_crates" ("claimed_at");

-- Create indexes for game_states table
CREATE INDEX IF NOT EXISTS "game_states_id_idx" ON "game_states" ("id");
