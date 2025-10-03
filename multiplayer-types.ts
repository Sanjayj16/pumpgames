/**
 * MULTIPLAYER TYPES AND INTERFACES
 * 
 * Shared types between client and server for real-time multiplayer snake game.
 * These types define the structure of data exchanged via Socket.IO.
 */

/**
 * Position interface - represents x,y coordinates in the game world
 */
export interface Position {
  x: number;
  y: number;
}

/**
 * Player State - Complete state of a player's snake
 * This is broadcast to all clients for rendering
 */
export interface PlayerState {
  id: string;                    // Unique player ID (socket.id)
  username: string;              // Player's display name
  head: Position;                // Current head position
  direction: number;             // Current angle/direction (in radians)
  speed: number;                 // Current movement speed
  length: number;                // Snake length/mass
  color: string;                 // Snake color (hex)
  segments: Position[];          // Array of body segment positions (for rendering)
  isBoosting: boolean;           // Whether player is currently boosting
  score: number;                 // Player's current score
  money: number;                 // Player's money/bounty (starts at $1, increases with kills)
  kills: number;                 // Number of kills
  lastUpdate: number;            // Timestamp of last update
  foodsEaten?: number;           // Number of foods eaten (for segment calculation)
}

/**
 * Player Update - Lightweight update sent frequently from client to server
 * Contains only the essential data that changes each frame
 */
export interface PlayerUpdate {
  id: string;
  head: Position;
  direction: number;
  speed: number;
  length: number;
  isBoosting: boolean;
}

/**
 * Player Join Event - Sent when a new player connects
 */
export interface PlayerJoinEvent {
  player: PlayerState;
  timestamp: number;
}

/**
 * Player Leave Event - Sent when a player disconnects
 */
export interface PlayerLeaveEvent {
  playerId: string;
  timestamp: number;
}

/**
 * Game State Snapshot - Complete game state sent to new players
 */
export interface GameStateSnapshot {
  players: Record<string, PlayerState>;  // All active players
  timestamp: number;
  // TODO: Add food positions when implementing server-side food
  // food: Food[];
  // TODO: Add server-managed obstacles/power-ups
  // obstacles: Obstacle[];
}

/**
 * Food Item (for future server-side food management)
 * TODO: Implement server-side food spawning and synchronization
 */
export interface ServerFood {
  id: string;
  position: Position;
  type: 'normal' | 'super' | 'boost';
  value: number;  // Mass/score value
}

/**
 * Collision Event - When a player is killed
 */
export interface CollisionEvent {
  victimId: string;
  victimUsername: string;
  killerId?: string;  // undefined if hit wall/boundary
  killerUsername?: string;
  moneyTransferred: number; // Amount of money transferred to killer
  timestamp: number;
  position: Position;
}

/**
 * Kill Event - Sent when a player kills another
 */
export interface KillEvent {
  killerId: string;
  killerUsername: string;
  victimId: string;
  victimUsername: string;
  moneyGained: number;
  newKillerMoney: number;
  newKillerKills: number;
  timestamp: number;
}

/**
 * Leaderboard Entry (for real-time leaderboard)
 * TODO: Implement real-time leaderboard updates
 */
export interface LeaderboardEntry {
  username: string;
  score: number;
  length: number;
}
