-- Migration to add friends and friend_requests tables
-- Run this SQL on your PostgreSQL database

-- Create friends table
CREATE TABLE IF NOT EXISTS "friends" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" varchar NOT NULL REFERENCES users(id),
  "friend_id" varchar NOT NULL REFERENCES users(id),
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- Create friend_requests table
CREATE TABLE IF NOT EXISTS "friend_requests" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "from_user_id" varchar NOT NULL REFERENCES users(id),
  "to_user_id" varchar NOT NULL REFERENCES users(id),
  "status" varchar DEFAULT 'pending' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS "friends_user_id_idx" ON "friends" ("user_id");
CREATE INDEX IF NOT EXISTS "friends_friend_id_idx" ON "friends" ("friend_id");
CREATE INDEX IF NOT EXISTS "friend_requests_from_user_id_idx" ON "friend_requests" ("from_user_id");
CREATE INDEX IF NOT EXISTS "friend_requests_to_user_id_idx" ON "friend_requests" ("to_user_id");
CREATE INDEX IF NOT EXISTS "friend_requests_status_idx" ON "friend_requests" ("status");

-- Add unique constraint to prevent duplicate friend relationships
CREATE UNIQUE INDEX IF NOT EXISTS "friends_unique_relationship" ON "friends" ("user_id", "friend_id");

-- Add unique constraint to prevent duplicate pending friend requests
CREATE UNIQUE INDEX IF NOT EXISTS "friend_requests_unique_pending" ON "friend_requests" ("from_user_id", "to_user_id") WHERE "status" = 'pending';
