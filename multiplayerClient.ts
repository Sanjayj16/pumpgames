/**
 * MULTIPLAYER CLIENT UTILITIES
 * 
 * This module handles Socket.IO communication between the game client and server.
 * It provides clean interfaces for sending/receiving multiplayer updates.
 */

import type { Socket } from 'socket.io-client';
import type { PlayerState, PlayerUpdate, GameStateSnapshot } from '../../../shared/multiplayer-types';

/**
 * Other Player - represents a remote player's snake that we render
 */
export interface OtherPlayer {
  id: string;
  username: string;
  head: { x: number; y: number };
  direction: number;
  speed: number;
  length: number;
  color: string;
  segments: Array<{ x: number; y: number }>;
  isBoosting: boolean;
  score: number;
  money: number;        // Player's bounty/money (starts at $1, increases with kills)
  kills: number;        // Number of kills
  lastUpdate: number;
  foodsEaten?: number;  // Number of foods eaten (for segment calculation)
  totalMass?: number;   // Total mass of the snake
  segmentRadius?: number; // Radius of each segment
  
  // Client-side interpolation for smooth rendering
  displayHead: { x: number; y: number };
  displayDirection: number;
  
  // ===== SMOOTH TRAILING SYSTEM =====
  // Local trail buffer of previous head positions for smooth body following
  // This creates the natural "snake following its head" effect like Slither.io
  trailBuffer: Array<{ x: number; y: number }>;
  
  // Legacy properties for backward compatibility
  cashingOut?: boolean;
  cashOutProgress?: number;
}

/**
 * Multiplayer Manager - handles all multiplayer communication
 */
export class MultiplayerManager {
  private socket: Socket;
  private otherPlayers: Map<string, OtherPlayer> = new Map();
  private updateInterval: number | null = null;
  
  // Callbacks for game to respond to events
  public onPlayerJoined?: (player: OtherPlayer) => void;
  public onPlayerLeft?: (playerId: string) => void;
  public onGameStateReceived?: (players: OtherPlayer[]) => void;
  public onPlayerKilled?: (event: {
    killerId: string;
    killerUsername: string;
    victimId: string;
    victimUsername: string;
    moneyGained: number;
    newKillerMoney: number;
    newKillerKills: number;
  }) => void;
  public onPlayerCollision?: (event: any) => void;
  public onPlayerDeath?: (event: any) => void;

  constructor(socket: Socket) {
    this.socket = socket;
    this.setupEventListeners();
  }

  /**
   * Setup Socket.IO event listeners for multiplayer
   */
  private setupEventListeners() {
    // Receive initial game state (all existing players)
    this.socket.on('gameState', (snapshot: GameStateSnapshot) => {
      console.log(`🎮 Received game state with ${Object.keys(snapshot.players).length} other players (excluding self)`);
      
      // FIXED: Clear existing players to prevent duplicates on rejoin
      this.otherPlayers.clear();
      
      for (const [id, playerState] of Object.entries(snapshot.players)) {
        // Double-check: Don't add ourselves to other players (server should already exclude us)
        if (id === this.socket.id) {
          console.log(`⚠️ Received own player in gameState, skipping (server should exclude this)`);
          continue;
        }
        
        // Ensure all required properties exist to prevent undefined errors
        const otherPlayer: OtherPlayer = {
          ...playerState,
          displayHead: playerState.head ? { ...playerState.head } : { x: 0, y: 0 },
          displayDirection: playerState.direction || 0,
          money: playerState.money || 1.00,
          kills: playerState.kills || 0,
          // Initialize trail buffer with starting head position
          trailBuffer: playerState.head ? [{ ...playerState.head }] : [{ x: 0, y: 0 }]
        };
        this.otherPlayers.set(id, otherPlayer);
      }
      
      console.log(`✅ Loaded ${this.otherPlayers.size} other players into game`);
      
      if (this.onGameStateReceived) {
        this.onGameStateReceived(Array.from(this.otherPlayers.values()));
      }
    });

    // New player joined
    this.socket.on('playerJoined', (data: { player: PlayerState; timestamp: number }) => {
      // Don't add ourselves (in case server accidentally sends it)
      if (data.player.id === this.socket.id) {
        console.log(`⚠️ Received own player in playerJoined event, skipping`);
        return;
      }
      
      console.log(`👋 Player joined: ${data.player.username}`);
      
      // Ensure all required properties exist to prevent undefined errors
      const otherPlayer: OtherPlayer = {
        ...data.player,
        displayHead: data.player.head ? { ...data.player.head } : { x: 0, y: 0 },
        displayDirection: data.player.direction || 0,
        money: data.player.money || 1.00,
        kills: data.player.kills || 0,
        // Initialize trail buffer with starting head position
        trailBuffer: data.player.head ? [{ ...data.player.head }] : [{ x: 0, y: 0 }]
      };
      this.otherPlayers.set(data.player.id, otherPlayer);
      
      if (this.onPlayerJoined) {
        this.onPlayerJoined(otherPlayer);
      }
    });

    // Player left
    this.socket.on('playerLeft', (data: { playerId: string; timestamp: number }) => {
      console.log(`👋 Player left: ${data.playerId}`);
      
      this.otherPlayers.delete(data.playerId);
      
      if (this.onPlayerLeft) {
        this.onPlayerLeft(data.playerId);
      }
    });

    // Player position update (now includes full segments data)
    this.socket.on('playerUpdate', (update: any) => {
      const player = this.otherPlayers.get(update.id);
      if (!player) return;
      
      // ===== HANDLE NEW SERVER FORMAT =====
      // Server now sends: { id, segments: [...], money, totalMass, segmentRadius, color, username }
      
      if (update.segments && update.segments.length > 0) {
        // Update player with full segments data
        player.segments = update.segments;
        player.head = update.segments[0]; // Head is first segment
        player.displayHead = { ...update.segments[0] };
        player.length = update.segments.length;
        player.money = update.money || player.money;
        player.totalMass = update.totalMass || player.totalMass;
        player.segmentRadius = update.segmentRadius || player.segmentRadius;
        player.color = update.color || player.color;
        player.username = update.username || player.username;
        player.lastUpdate = Date.now();
        
        // Debug logging (reduced frequency)
        if (Math.random() < 0.01) { // 1% of updates
          console.log(`🔄 Received update for ${player.username}: ${update.segments.length} segments, $${update.money?.toFixed(2) || 'N/A'}`);
        }
      } else if (update.head) {
        // Fallback for old format (lightweight updates)
        player.head = update.head;
        player.direction = update.direction || player.direction;
        player.speed = update.speed || player.speed;
        player.length = update.length || player.length;
        player.isBoosting = update.isBoosting || false;
        player.lastUpdate = Date.now();
      }
    });

    // Full player state update (less frequent, includes segments)
    this.socket.on('playerStateUpdate', (update: Partial<PlayerState> & { id: string }) => {
      const player = this.otherPlayers.get(update.id);
      if (!player) return;
      
      // Update player with new data, ensuring segments are updated
      if (update.segments) {
        player.segments = update.segments;
      }
      if (update.head) {
        player.head = update.head;
      }
      if (update.direction !== undefined) {
        player.direction = update.direction;
      }
      if (update.length !== undefined) {
        player.length = update.length;
      }
      if (update.speed !== undefined) {
        player.speed = update.speed;
      }
      if (update.isBoosting !== undefined) {
        player.isBoosting = update.isBoosting;
      }
      
      player.lastUpdate = Date.now();
      
      console.log(`🔄 Updated ${player.username} full state (${player.segments?.length || 0} segments)`);
    });

    // Player killed event (money transfer)
    this.socket.on('playerKilled', (event: {
      killerId: string;
      killerUsername: string;
      victimId: string;
      victimUsername: string;
      moneyGained: number;
      newKillerMoney: number;
      newKillerKills: number;
      timestamp: number;
    }) => {
      console.log(`💀 ${event.killerUsername} killed ${event.victimUsername} and gained $${event.moneyGained.toFixed(2)}`);
      
      // Update killer's money and kills
      const killer = this.otherPlayers.get(event.killerId);
      if (killer) {
        killer.money = event.newKillerMoney;
        killer.kills = event.newKillerKills;
      }
      
      // Remove victim (playerLeft event will be sent separately)
      this.otherPlayers.delete(event.victimId);
      
      // Callback for UI notifications
      if (this.onPlayerKilled) {
        this.onPlayerKilled(event);
      }
    });
    
    // Server-side collision detection
    this.socket.on('playerCollision', (event: {
      crashedPlayerId: string;
      crashedPlayerName: string;
      killerId: string;
      killerName: string;
      moneyTransfer: number;
      newKillerMoney: number;
      newKillerKills: number;
      timestamp: number;
    }) => {
      console.log(`💥 SERVER COLLISION: ${event.crashedPlayerName} crashed into ${event.killerName}!`);
      
      // Update killer's money and kills
      const killer = this.otherPlayers.get(event.killerId);
      if (killer) {
        killer.money = event.newKillerMoney;
        killer.kills = event.newKillerKills;
      }
      
      // Remove crashed player
      this.otherPlayers.delete(event.crashedPlayerId);
      
      // Callback for UI notifications
      if (this.onPlayerCollision) {
        this.onPlayerCollision(event);
      }
    });
    
    // Death notification from server
    this.socket.on('death', (event: {
      reason: string;
      crashedInto: string;
      killerName: string;
    }) => {
      console.log(`💀 Received death notification from server:`, event);
      console.log(`💀 You died! Crashed into ${event.killerName}`);
      
      if (this.onPlayerDeath) {
        console.log(`💀 Calling onPlayerDeath callback`);
        this.onPlayerDeath(event);
      } else {
        console.log(`⚠️ No onPlayerDeath callback registered`);
      }
    });
  }

  /**
   * Send player position update to server
   * Call this frequently (e.g., every 50ms) from your game loop
   */
  sendPositionUpdate(
    head: { x: number; y: number },
    direction: number,
    speed: number,
    length: number,
    isBoosting: boolean
  ) {
    const update: PlayerUpdate = {
      id: this.socket.id!,
      head,
      direction,
      speed,
      length,
      isBoosting
    };
    
    this.socket.emit('playerUpdate', update);
  }

  /**
   * Send full state update (includes segments)
   * Call this less frequently or when major changes happen (growth, etc.)
   */
  sendFullStateUpdate(state: Partial<PlayerState>) {
    this.socket.emit('playerStateUpdate', state);
  }

  /**
   * Send kill event to server
   * Call this when your snake kills another player
   * @param victimId - The ID of the player that was killed
   */
  sendKillEvent(victimId: string) {
    this.socket.emit('playerKilled', { victimId });
    console.log(`💀 Sent kill event for victim ${victimId}`);
  }

  /**
   * Start sending position updates at regular intervals
   * @param intervalMs - How often to send updates (e.g., 50ms = 20 updates/sec)
   */
  startAutoUpdates(
    intervalMs: number,
    getPlayerData: () => {
      head: { x: number; y: number };
      direction: number;
      speed: number;
      length: number;
      isBoosting: boolean;
      segments?: Array<{ x: number; y: number }>; // Add segments
      foodsEaten?: number; // Add foods eaten for segment calculation
    }
  ) {
    if (this.updateInterval !== null) {
      this.stopAutoUpdates();
    }

    let updateCounter = 0;

    this.updateInterval = window.setInterval(() => {
      const data = getPlayerData();
      
      // Send lightweight position update every frame
      this.sendPositionUpdate(
        data.head,
        data.direction,
        data.speed,
        data.length,
        data.isBoosting
      );
      
      // Send full state (including segments and foodsEaten) every 10 updates (~500ms)
      // This ensures other players see your full snake body with accurate segment count
      updateCounter++;
      if (updateCounter >= 10 && data.segments) {
        this.sendFullStateUpdate({
          segments: data.segments,
          length: data.length,
          foodsEaten: data.foodsEaten  // Include foods eaten in full state updates
        });
        updateCounter = 0;
      }
    }, intervalMs);

    console.log(`🔄 Started auto-updates every ${intervalMs}ms (full state every ${intervalMs * 10}ms)`);
  }

  /**
   * Stop sending automatic position updates
   */
  stopAutoUpdates() {
    if (this.updateInterval !== null) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      console.log('🛑 Stopped auto-updates');
    }
  }

  /**
   * Get all other players (for rendering)
   */
  getOtherPlayers(): OtherPlayer[] {
    return Array.from(this.otherPlayers.values());
  }

  /**
   * Get a specific player by ID
   */
  getPlayer(id: string): OtherPlayer | undefined {
    return this.otherPlayers.get(id);
  }

  /**
   * Interpolate player positions for smooth rendering
   * Call this in your render loop before drawing
   * 
   * ===== SMOOTH TRAILING SYSTEM CONFIGURATION =====
   * Adjust these constants to customize smoothness and appearance:
   */
  interpolatePlayers(deltaTime: number) {
    // === TUNING PARAMETERS ===
    // Higher = faster head movement, lower = smoother/more delayed (0.1 - 0.5 recommended)
    // Increased for more responsive movement that better tracks server updates
    const HEAD_INTERPOLATION_SPEED = 0.35;
    
    // Maximum trail buffer length - more = smoother body but more memory (30-60 recommended)
    // Increased to ensure enough trail points for longer snakes
    const MAX_TRAIL_LENGTH = 50;
    
    // Minimum distance head must move before adding to trail (prevents overcrowding)
    // Lowered slightly for more granular trail points = smoother curves
    const MIN_TRAIL_DISTANCE = 2;
    
    for (const player of this.otherPlayers.values()) {
      // Safety check: Ensure required properties exist
      if (!player.head || !player.displayHead) {
        console.warn(`⚠️ Player ${player.id} missing head data, skipping interpolation`);
        continue;
      }
      
      // Initialize trail buffer if it doesn't exist
      if (!player.trailBuffer) {
        player.trailBuffer = [{ ...player.displayHead }];
      }
      
      // === STEP 1: Smoothly interpolate head toward server position ===
      player.displayHead.x += (player.head.x - player.displayHead.x) * HEAD_INTERPOLATION_SPEED;
      player.displayHead.y += (player.head.y - player.displayHead.y) * HEAD_INTERPOLATION_SPEED;
      
      // === STEP 2: Add current head position to trail buffer ===
      // Only add if head has moved enough (prevents overcrowding trail)
      const lastTrailPoint = player.trailBuffer[0];
      const distanceMoved = Math.sqrt(
        Math.pow(player.displayHead.x - lastTrailPoint.x, 2) +
        Math.pow(player.displayHead.y - lastTrailPoint.y, 2)
      );
      
      if (distanceMoved >= MIN_TRAIL_DISTANCE) {
        // Add new position to front of trail
        player.trailBuffer.unshift({ 
          x: player.displayHead.x, 
          y: player.displayHead.y 
        });
        
        // Keep trail at maximum length
        if (player.trailBuffer.length > MAX_TRAIL_LENGTH) {
          player.trailBuffer.pop();
        }
      }
      
      // === STEP 3: Smoothly interpolate direction ===
      const direction = player.direction || 0;
      const displayDirection = player.displayDirection || 0;
      let dirDiff = direction - displayDirection;
      // Handle wrapping around -PI to PI
      while (dirDiff > Math.PI) dirDiff -= 2 * Math.PI;
      while (dirDiff < -Math.PI) dirDiff += 2 * Math.PI;
      player.displayDirection += dirDiff * HEAD_INTERPOLATION_SPEED;
    }
  }

  /**
   * Clean up (call when leaving game)
   */
  destroy() {
    this.stopAutoUpdates();
    this.otherPlayers.clear();
  }
}

/**
 * ===== SMOOTH TRAILING SYSTEM - SEGMENT GENERATOR =====
 * 
 * Generate smooth, naturally-following body segments from a trail buffer.
 * This creates the "snake body follows head" effect like Slither.io.
 * 
 * === HOW IT WORKS ===
 * 1. The trail buffer contains recent head positions (maintained by interpolatePlayers)
 * 2. We sample positions along the trail at regular intervals (BODY_SEGMENT_SPACING)
 * 3. Each body segment is placed at an earlier point in the trail
 * 4. Result: Smooth, continuous snake body that naturally follows the head's path
 * 
 * === TUNING PARAMETERS ===
 * - BODY_SEGMENT_SPACING: Distance between segments (lower = tighter body, higher = looser)
 *   Recommended: 8-12 for natural snake appearance
 * - segmentCount: Based on foods eaten - same as player snake
 */
export function generateSegmentsFromTrail(
  trailBuffer: Array<{ x: number; y: number }>,
  length: number,
  displayHead: { x: number; y: number },
  foodsEaten?: number  // NEW: Foods eaten count for accurate segment calculation
): Array<{ x: number; y: number }> {
  // === BODY SPACING CONFIGURATION ===
  // FIXED: Match player snake spacing exactly (6 pixels)
  // This ensures opponent snakes look identical to player snake
  const BODY_SEGMENT_SPACING = 6;
  
  const segments: Array<{ x: number; y: number }> = [];
  
  // Always add the head first (current display position)
  segments.push({ x: displayHead.x, y: displayHead.y });
  
  // === FOOD-BASED SEGMENT CALCULATION (same as player snake) ===
  // Rule: Start with 10 segments, +1 segment per 3 foods eaten
  // This ensures ALL snakes grow the same way
  let segmentCount: number;
  
  if (foodsEaten !== undefined && foodsEaten !== null) {
    // Use food-based calculation (same as player snake)
    const segmentsFromFoods = Math.floor(foodsEaten / 3);
    segmentCount = 10 + segmentsFromFoods; // Start at 10, +1 per 3 foods
  } else {
    // Fallback if foodsEaten not available
    segmentCount = Math.max(10, Math.min(20, Math.floor(length / 5)));
  }
  
  // If trail is too short, use fallback generation
  if (trailBuffer.length < 2) {
    // Not enough trail data yet, return just the head
    return segments;
  }
  
  // === SAMPLE POSITIONS FROM TRAIL ===
  // Walk along the trail, placing segments at regular intervals
  // Strategy: For each body segment, walk along the trail until we've covered enough distance
  for (let segmentIndex = 1; segmentIndex < segmentCount; segmentIndex++) {
    const targetDistance = segmentIndex * BODY_SEGMENT_SPACING;
    let accumulatedDistance = 0;
    let foundSegment = false;
    
    // Walk through trail points until we reach the target distance
    for (let i = 0; i < trailBuffer.length - 1; i++) {
      const pointA = trailBuffer[i];
      const pointB = trailBuffer[i + 1];
      
      const dx = pointB.x - pointA.x;
      const dy = pointB.y - pointA.y;
      const segmentDistance = Math.sqrt(dx * dx + dy * dy);
      
      // Check if target distance falls within this trail segment
      if (accumulatedDistance + segmentDistance >= targetDistance) {
        // Interpolate exact position within this segment
        const remainingDistance = targetDistance - accumulatedDistance;
        const t = segmentDistance > 0 ? remainingDistance / segmentDistance : 0;
        
        segments.push({
          x: pointA.x + dx * t,
          y: pointA.y + dy * t
        });
        
        foundSegment = true;
        break;
      }
      
      accumulatedDistance += segmentDistance;
    }
    
    // If trail ran out, extend from last known direction
    if (!foundSegment && trailBuffer.length >= 2) {
      const lastPoint = trailBuffer[trailBuffer.length - 1];
      const secondLastPoint = trailBuffer[trailBuffer.length - 2];
      const dx = lastPoint.x - secondLastPoint.x;
      const dy = lastPoint.y - secondLastPoint.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance > 0) {
        const extendDistance = targetDistance - accumulatedDistance;
        segments.push({
          x: lastPoint.x + (dx / distance) * extendDistance,
          y: lastPoint.y + (dy / distance) * extendDistance
        });
      } else {
        // Fallback: just repeat the last point
        segments.push({ ...lastPoint });
      }
    }
  }
  
  return segments;
}

/**
 * Helper: Create segment positions for rendering a snake
 * Use this to generate approximate segments for other players when full segments aren't available
 * Creates a curved, natural-looking snake trail
 * 
 * NOTE: This is the OLD fallback method. Prefer generateSegmentsFromTrail() for smooth trailing.
 */
export function generateSnakeSegments(
  head: { x: number; y: number },
  direction: number,
  length: number,
  segmentSpacing: number = 6,  // FIXED: Match player snake spacing
  foodsEaten?: number  // NEW: Foods eaten for accurate segment count
): Array<{ x: number; y: number }> {
  const segments: Array<{ x: number; y: number }> = [];
  
  // === FOOD-BASED SEGMENT CALCULATION (same as player snake) ===
  let segmentCount: number;
  
  if (foodsEaten !== undefined && foodsEaten !== null) {
    // Use food-based calculation (same as player snake)
    const segmentsFromFoods = Math.floor(foodsEaten / 3);
    segmentCount = 10 + segmentsFromFoods; // Start at 10, +1 per 3 foods
  } else {
    // Fallback if foodsEaten not available
    segmentCount = Math.max(10, Math.min(20, Math.floor(length / 5)));
  }
  
  // Add head
  segments.push({ x: head.x, y: head.y });
  
  // Generate body segments following the direction with slight curve for natural look
  for (let i = 1; i < segmentCount; i++) {
    const distance = i * segmentSpacing;
    // Add slight sine wave for natural curve
    const curveFactor = Math.sin(i * 0.3) * 2;
    const perpendicularDir = direction + Math.PI / 2;
    
    segments.push({
      x: head.x - Math.cos(direction) * distance + Math.cos(perpendicularDir) * curveFactor,
      y: head.y - Math.sin(direction) * distance + Math.sin(perpendicularDir) * curveFactor
    });
  }
  
  return segments;
}
