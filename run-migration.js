#!/usr/bin/env node

/**
 * Simple migration runner for the friends tables
 * Run this script to create the friends and friend_requests tables
 * 
 * Usage: node scripts/run-migration.js
 * 
 * Make sure to set DATABASE_URL environment variable first
 */

import { Pool } from '@neondatabase/serverless';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is required');
  console.log('Please set it like: export DATABASE_URL="your-database-url"');
  process.exit(1);
}

async function runMigration() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  
  try {
    console.log('🔄 Running database migrations...');
    
    // Run initial schema migration first
    console.log('📋 Step 1: Creating initial schema...');
    const initialSchemaPath = join(__dirname, '..', 'migrations', '000_initial_schema.sql');
    const initialSchemaSQL = readFileSync(initialSchemaPath, 'utf8');
    await pool.query(initialSchemaSQL);
    console.log('✅ Initial schema created successfully!');
    
    // Run friends tables migration
    console.log('📋 Step 2: Adding friends tables...');
    const friendsMigrationPath = join(__dirname, '..', 'migrations', '001_add_friends_tables.sql');
    const friendsMigrationSQL = readFileSync(friendsMigrationPath, 'utf8');
    await pool.query(friendsMigrationSQL);
    
    console.log('✅ All migrations completed successfully!');
    console.log('📋 Created tables:');
    console.log('   - users, games, game_participants, daily_crates, game_states');
    console.log('   - friends, friend_requests');
    console.log('   - indexes for performance');
    console.log('   - unique constraints');
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error('Full error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
