import {
  type User,
  type InsertUser,
  type Game,
  type InsertGame,
  type GameParticipant,
  type InsertGameParticipant,
  type DailyCrate,
  type InsertDailyCrate,
  type GameState,
  type Player,
  type Direction,
  users,
  games,
  gameParticipants,
  dailyCrates,
  gameStates
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and, or } from "drizzle-orm";

export interface IStorage {
  // User operations
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, updates: Partial<User>): Promise<User | undefined>;
  updateUserBalance(id: string, amount: number): Promise<User | undefined>;

  // Game operations
  createGame(game: InsertGame): Promise<Game>;
  getGame(id: string): Promise<Game | undefined>;
  getActiveGames(): Promise<Game[]>;
  updateGame(id: string, updates: Partial<Game>): Promise<Game | undefined>;
  joinGame(gameId: string, userId: string): Promise<GameParticipant>;
  getGameParticipants(gameId: string): Promise<GameParticipant[]>;
  updateGameParticipant(id: string, updates: Partial<GameParticipant>): Promise<GameParticipant | undefined>;



  // Daily crate operations
  getLastDailyCrate(userId: string): Promise<DailyCrate | undefined>;
  claimDailyCrate(userId: string, reward: number): Promise<DailyCrate>;

  // Game state operations
  getGameState(gameId: string): Promise<GameState | undefined>;
  updateGameState(gameId: string, state: GameState): Promise<void>;
  removeGameState(gameId: string): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  // User operations
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async createUser(user: InsertUser): Promise<User> {
    const [newUser] = await db
      .insert(users)
      .values(user)
      .returning();
    return newUser;
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User | undefined> {
    const [updatedUser] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, id))
      .returning();
    return updatedUser || undefined;
  }

  async updateUserBalance(id: string, amount: number): Promise<User | undefined> {
    const user = await this.getUser(id);
    if (!user) return undefined;
    
    const currentBalance = parseFloat(user.balance);
    const newBalance = currentBalance + amount;
    
    return this.updateUser(id, { balance: newBalance.toFixed(4) });
  }



  // Game operations
  async createGame(game: InsertGame): Promise<Game> {
    const [newGame] = await db
      .insert(games)
      .values(game)
      .returning();
    return newGame;
  }

  async getGame(id: string): Promise<Game | undefined> {
    const [game] = await db.select().from(games).where(eq(games.id, id));
    return game || undefined;
  }

  async getActiveGames(): Promise<Game[]> {
    return await db
      .select()
      .from(games)
      .where(or(eq(games.status, 'waiting'), eq(games.status, 'active')));
  }

  async updateGame(id: string, updates: Partial<Game>): Promise<Game | undefined> {
    const [updatedGame] = await db
      .update(games)
      .set(updates)
      .where(eq(games.id, id))
      .returning();
    return updatedGame || undefined;
  }

  async joinGame(gameId: string, userId: string): Promise<GameParticipant> {
    const [participant] = await db
      .insert(gameParticipants)
      .values({
        gameId,
        userId,
        kills: 0,
        earnings: "0.00",
        isAlive: true
      })
      .returning();
    return participant;
  }

  async getGameParticipants(gameId: string): Promise<GameParticipant[]> {
    return await db
      .select()
      .from(gameParticipants)
      .where(eq(gameParticipants.gameId, gameId));
  }

  async updateGameParticipant(id: string, updates: Partial<GameParticipant>): Promise<GameParticipant | undefined> {
    const [updatedParticipant] = await db
      .update(gameParticipants)
      .set(updates)
      .where(eq(gameParticipants.id, id))
      .returning();
    return updatedParticipant || undefined;
  }



  // Daily crate operations
  async getLastDailyCrate(userId: string): Promise<DailyCrate | undefined> {
    const [crate] = await db
      .select()
      .from(dailyCrates)
      .where(eq(dailyCrates.userId, userId))
      .orderBy(desc(dailyCrates.claimedAt))
      .limit(1);
    return crate || undefined;
  }

  async claimDailyCrate(userId: string, reward: number): Promise<DailyCrate> {
    const [crate] = await db
      .insert(dailyCrates)
      .values({
        userId,
        reward: reward.toFixed(4)
      })
      .returning();
    return crate;
  }

  // Game state operations
  async getGameState(gameId: string): Promise<GameState | undefined> {
    const [state] = await db
      .select()
      .from(gameStates)
      .where(eq(gameStates.id, gameId));
    
    if (state) {
      return state.data as GameState;
    }

    // Create initial game state if it doesn't exist
    const game = await this.getGame(gameId);
    if (!game) return undefined;

    const participants = await this.getGameParticipants(gameId);
    const users = await Promise.all(
      participants.map(p => this.getUser(p.userId))
    );

    const players = participants.map((participant, index) => ({
      id: participant.userId,
      username: users[index]?.username || 'Unknown',
      color: this.getRandomColor(),
      kills: participant.kills,
      earnings: parseFloat(participant.earnings),
      isAlive: participant.isAlive,
      snake: {
        segments: [{ x: 500 + Math.random() * 500, y: 500 + Math.random() * 500 }],
        direction: 'right' as Direction,
        angle: Math.random() * Math.PI * 2,
        speed: 2,
        growing: false
      }
    }));

    const initialGameState: GameState = {
      id: gameId,
      players,
      food: this.generateFood(20),
      gameArea: { width: 4000, height: 4000 },
      status: 'active',
      betAmount: parseFloat(game.betAmount)
    };

    await this.updateGameState(gameId, initialGameState);
    return initialGameState;
  }

  private getRandomColor(): string {
    const colors = ['#FFD700', '#32CD32', '#1E90FF', '#FF69B4', '#FF4500', '#9370DB', '#00CED1'];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  private generateFood(count: number): any[] {
    const food = [];
    for (let i = 0; i < count; i++) {
      food.push({
        id: `food_${i}`,
        position: {
          x: Math.random() * 2000,
          y: Math.random() * 2000
        },
        value: Math.floor(Math.random() * 3) + 1,
        color: this.getRandomColor()
      });
    }
    return food;
  }

  async updateGameState(gameId: string, state: GameState): Promise<void> {
    await db
      .insert(gameStates)
      .values({
        id: gameId,
        data: state as any
      })
      .onConflictDoUpdate({
        target: gameStates.id,
        set: {
          data: state as any,
          lastUpdated: new Date()
        }
      });
  }

  async removeGameState(gameId: string): Promise<void> {
    await db.delete(gameStates).where(eq(gameStates.id, gameId));
  }
}

export const storage = new DatabaseStorage();