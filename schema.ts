import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, decimal, timestamp, boolean, uuid, jsonb } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  balance: decimal("balance", { precision: 10, scale: 4 }).default("0.0000").notNull(),
  solBalance: decimal("sol_balance", { precision: 10, scale: 8 }).default("0.00000000").notNull(),
  totalEarnings: decimal("total_earnings", { precision: 10, scale: 2 }).default("0.00").notNull(),
  gamesPlayed: integer("games_played").default(0).notNull(),
  kills: integer("kills").default(0).notNull(),
  deaths: integer("deaths").default(0).notNull(),
  snakeColor: text("snake_color").default("#00FF88").notNull(),
  isOnline: boolean("is_online").default(false).notNull(),
  lastActive: timestamp("last_active").default(sql`now()`).notNull(),
  createdAt: timestamp("created_at").default(sql`now()`).notNull()
});

export const games = pgTable("games", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  region: text("region").notNull(),
  betAmount: decimal("bet_amount", { precision: 10, scale: 2 }).notNull(),
  playersCount: integer("players_count").default(0).notNull(),
  maxPlayers: integer("max_players").default(20).notNull(),
  status: text("status").notNull(), // 'waiting', 'active', 'finished'
  createdAt: timestamp("created_at").default(sql`now()`).notNull(),
  startedAt: timestamp("started_at"),
  endedAt: timestamp("ended_at")
});

export const gameParticipants = pgTable("game_participants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  gameId: varchar("game_id").notNull().references(() => games.id),
  userId: varchar("user_id").notNull().references(() => users.id),
  kills: integer("kills").default(0).notNull(),
  earnings: decimal("earnings", { precision: 10, scale: 2 }).default("0.00").notNull(),
  isAlive: boolean("is_alive").default(true).notNull(),
  joinedAt: timestamp("joined_at").default(sql`now()`).notNull(),
  eliminatedAt: timestamp("eliminated_at")
});



export const dailyCrates = pgTable("daily_crates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  claimedAt: timestamp("claimed_at").default(sql`now()`).notNull(),
  reward: decimal("reward", { precision: 10, scale: 4 }).notNull()
});

export const friends = pgTable("friends", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  friendId: varchar("friend_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").default(sql`now()`).notNull()
});

export const friendRequests = pgTable("friend_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fromUserId: varchar("from_user_id").notNull().references(() => users.id),
  toUserId: varchar("to_user_id").notNull().references(() => users.id),
  status: varchar("status").notNull().default("pending"), // 'pending', 'accepted', 'declined'
  createdAt: timestamp("created_at").default(sql`now()`).notNull()
});

// Game states table for storing real-time game data
export const gameStates = pgTable("game_states", {
  id: varchar("id").primaryKey(), // matches game id
  data: jsonb("data").notNull(), // stores full GameState object
  lastUpdated: timestamp("last_updated").default(sql`now()`).notNull()
});

// Define relations
export const usersRelations = relations(users, ({ many }) => ({
  gameParticipants: many(gameParticipants),
  dailyCrates: many(dailyCrates)
}));

export const gamesRelations = relations(games, ({ many, one }) => ({
  participants: many(gameParticipants),
  gameState: one(gameStates, {
    fields: [games.id],
    references: [gameStates.id]
  })
}));

export const gameParticipantsRelations = relations(gameParticipants, ({ one }) => ({
  user: one(users, {
    fields: [gameParticipants.userId],
    references: [users.id]
  }),
  game: one(games, {
    fields: [gameParticipants.gameId],
    references: [games.id]
  })
}));



export const dailyCratesRelations = relations(dailyCrates, ({ one }) => ({
  user: one(users, {
    fields: [dailyCrates.userId],
    references: [users.id]
  })
}));

export const friendsRelations = relations(friends, ({ one }) => ({
  user: one(users, {
    fields: [friends.userId],
    references: [users.id]
  }),
  friend: one(users, {
    fields: [friends.friendId],
    references: [users.id]
  })
}));

export const friendRequestsRelations = relations(friendRequests, ({ one }) => ({
  fromUser: one(users, {
    fields: [friendRequests.fromUserId],
    references: [users.id]
  }),
  toUser: one(users, {
    fields: [friendRequests.toUserId],
    references: [users.id]
  })
}));

export const gameStatesRelations = relations(gameStates, ({ one }) => ({
  game: one(games, {
    fields: [gameStates.id],
    references: [games.id]
  })
}));

// Insert schemas
export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  lastActive: true
});

export const insertGameSchema = createInsertSchema(games).omit({
  id: true,
  createdAt: true,
  startedAt: true,
  endedAt: true
});

export const insertGameParticipantSchema = createInsertSchema(gameParticipants).omit({
  id: true,
  joinedAt: true,
  eliminatedAt: true
});



export const insertDailyCrateSchema = createInsertSchema(dailyCrates).omit({
  id: true,
  claimedAt: true
});

export const insertFriendSchema = createInsertSchema(friends).omit({
  id: true,
  createdAt: true
});

export const insertFriendRequestSchema = createInsertSchema(friendRequests).omit({
  id: true,
  createdAt: true
});

export const insertGameStateSchema = createInsertSchema(gameStates).omit({
  lastUpdated: true
});

// Types
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export type InsertGame = z.infer<typeof insertGameSchema>;
export type Game = typeof games.$inferSelect;

export type InsertGameParticipant = z.infer<typeof insertGameParticipantSchema>;
export type GameParticipant = typeof gameParticipants.$inferSelect;



export type InsertDailyCrate = z.infer<typeof insertDailyCrateSchema>;
export type DailyCrate = typeof dailyCrates.$inferSelect;

export type InsertFriend = z.infer<typeof insertFriendSchema>;
export type Friend = typeof friends.$inferSelect;

export type InsertFriendRequest = z.infer<typeof insertFriendRequestSchema>;
export type FriendRequest = typeof friendRequests.$inferSelect;

// Game state types
export interface Position {
  x: number;
  y: number;
}

export interface Food {
  id: string;
  position: Position;
  value: number;
  color: string;
}

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Snake {
  segments: Position[];
  direction: Direction;
  angle: number;
  speed: number;
  growing: boolean;
}

export interface GameState {
  id: string;
  players: Player[];
  food: Food[];
  gameArea: { width: number; height: number };
  status: 'waiting' | 'active' | 'finished';
  betAmount: number;
}

export interface Player {
  id: string;
  username: string;
  snake: Snake;
  kills: number;
  earnings: number;
  isAlive: boolean;
  color: string;
}
