import express, { type Request, Response, NextFunction } from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { registerRoutes } from "./simple-routes";
import { storage } from "./storage";
import type { PlayerState, PlayerUpdate, GameStateSnapshot } from "./multiplayer-types";

const app = express();
const httpServer = createServer(app);

// Detect production environment
const isProduction = process.env.NODE_ENV === "production";

// Setup Socket.IO with default path (`/socket.io`)
const io = new Server(httpServer, {
  path: "/socket.io", // default, matches socket.io-client
  cors: {
    origin: isProduction
      ? [
          process.env.FRONTEND_URL || "https://harmonious-boba-11ae9e.netlify.app",
          "https://harmonious-boba-11ae9e.netlify.app",
          "http://localhost:5173",
          "http://127.0.0.1:5173",
        ]
      : ["http://localhost:5173", "http://localhost:3000", "*"],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Map to track online users allowing multiple sockets per username
const onlineUsers = new Map<string, Set<string>>();
// Store pending friend requests
const friendRequests = new Map<string, Array<{ id: string; from: string; timestamp: string }>>();
// Store user's friends list
const userFriends = new Map<string, Set<string>>();

// ============================================================================
// MULTIPLAYER GAME STATE MANAGEMENT
// ============================================================================

/**
 * Global game state - stores all active players across all rooms
 * Structure: Map<roomId, Map<playerId, PlayerState>>
 */
const gameRooms = new Map<string, Map<string, PlayerState>>();

/**
 * Helper: Get or create a game room
 */
function getOrCreateRoom(roomId: string): Map<string, PlayerState> {
  if (!gameRooms.has(roomId)) {
    gameRooms.set(roomId, new Map());
    console.log(`🎮 Created new game room: ${roomId}`);
  }
  return gameRooms.get(roomId)!;
}

/**
 * Helper: Generate random spawn position for new player
 * TODO: Implement smarter spawning away from other players
 */
function generateSpawnPosition(): { x: number; y: number } {
  const arenaSize = 5000; // Match client arena size
  const centerX = arenaSize / 2;
  const centerY = arenaSize / 2;
  const maxRadius = arenaSize * 0.4; // Spawn within 80% of arena
  
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.random() * maxRadius;
  
  return {
    x: centerX + Math.cos(angle) * radius,
    y: centerY + Math.sin(angle) * radius
  };
}

/**
 * Helper: Generate random snake color
 * Expanded color palette to ensure different players get different colors
 */
function generatePlayerColor(): string {
  const colors = [
    // Vibrant colors for better distinction
    '#00ff00', // Bright green
    '#ff00ff', // Magenta
    '#00ffff', // Cyan
    '#ffff00', // Yellow
    '#ff6b6b', // Red
    '#4ecdc4', // Teal
    '#45b7d1', // Light blue
    '#f9ca24', // Orange
    '#6c5ce7', // Purple
    '#fd79a8', // Pink
    '#fdcb6e', // Light orange
    '#55efc4', // Mint
    '#74b9ff', // Sky blue
    '#a29bfe', // Lavender
    '#ff7675', // Coral
    '#00b894', // Sea green
    '#e17055', // Terra cotta
    '#0984e3', // Ocean blue
    '#6c5ce7', // Deep purple
    '#ffeaa7', // Light yellow
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

// ============================================================================
// AUTOMATIC STALE PLAYER CLEANUP - AGGRESSIVE FOR PRODUCTION
// ============================================================================
/**
 * Clean up players who haven't sent updates in a while (disconnected but stuck)
 * Production: More aggressive cleanup to prevent accumulation
 */
const cleanupInterval = isProduction ? 15000 : 30000; // 15s in prod, 30s in dev
const staleThreshold = isProduction ? 30000 : 60000;  // 30s in prod, 60s in dev

console.log(`🧹 Auto-cleanup configured: interval=${cleanupInterval/1000}s, threshold=${staleThreshold/1000}s`);

setInterval(() => {
  const now = Date.now();
  let totalCleaned = 0;
  let totalPlayers = 0;
  
  for (const [roomId, room] of gameRooms.entries()) {
    const playersToRemove: string[] = [];
    totalPlayers += room.size;
    
    for (const [playerId, player] of room.entries()) {
      const timeSinceUpdate = now - player.lastUpdate;
      if (timeSinceUpdate > staleThreshold) {
        playersToRemove.push(playerId);
      }
    }
    
    // Remove stale players
    for (const playerId of playersToRemove) {
      const player = room.get(playerId);
      room.delete(playerId);
      totalCleaned++;
      
      console.log(`🧹 Auto-cleaned stale player ${player?.username} from ${roomId} (inactive for ${Math.floor((now - player!.lastUpdate) / 1000)}s)`);
      
      // Broadcast removal
      io.to(roomId).emit('playerLeft', {
        playerId: playerId,
        timestamp: now
      });
    }
    
    // Clean up empty rooms
    if (room.size === 0) {
      gameRooms.delete(roomId);
      console.log(`🧹 Auto-cleaned empty room ${roomId}`);
    }
  }
  
  if (totalCleaned > 0) {
    console.log(`✨ Auto-cleanup complete: Removed ${totalCleaned} stale players (${totalPlayers - totalCleaned} remaining)`);
  }
  
  // Warning if any room has too many players
  for (const [roomId, room] of gameRooms.entries()) {
    if (room.size > 80) {
      console.log(`⚠️ WARNING: Room ${roomId} has ${room.size} players (exceeds limit of 80)`);
    }
  }
}, cleanupInterval);

// ============================================================================
// TODO: SERVER-SIDE FOOD MANAGEMENT
// ============================================================================
/**
 * TODO: Implement server-authoritative food system
 * 
 * Benefits:
 * - Prevents cheating (client can't fake food collection)
 * - Ensures all players see the same food
 * - Server decides who gets food if multiple players are near
 * 
 * Implementation steps:
 * 1. Create food spawn system on server
 * 2. Track food state per room (Map<roomId, Food[]>)
 * 3. Broadcast food positions to all clients on join
 * 4. Handle 'eatFood' events from clients
 * 5. Validate distance before giving points
 * 6. Broadcast food removal to all clients
 * 7. Respawn food at regular intervals
 * 
 * Example events:
 * - socket.on('eatFood', (foodId) => { ... validate and broadcast ... })
 * - socket.emit('foodSpawned', { food: [...] })
 * - socket.emit('foodEaten', { foodId, playerId })
 */

// ============================================================================
// TODO: SERVER-SIDE COLLISION DETECTION
// ============================================================================
/**
 * TODO: Implement server-authoritative collision detection
 * 
 * Benefits:
 * - Prevents fake deaths/kills
 * - Fair gameplay across network latency
 * - Server is source of truth for game outcomes
 * 
 * Implementation steps:
 * 1. Track all player segments on server
 * 2. Check collisions each update tick
 * 3. Detect head-to-body collisions
 * 4. Detect head-to-head collisions (bigger snake wins)
 * 5. Generate food particles from dead snakes
 * 6. Broadcast death events to all clients
 * 7. Update leaderboard
 * 
 * Example collision check:
 * function checkCollisions(room: Map<string, PlayerState>) {
 *   for (const [id1, player1] of room) {
 *     for (const [id2, player2] of room) {
 *       if (id1 === id2) continue;
 *       // Check if player1 head hits player2 body
 *       for (const segment of player2.segments) {
 *         const dist = distance(player1.head, segment);
 *         if (dist < collisionRadius) {
 *           handleCollision(player1, player2);
 *         }
 *       }
 *     }
 *   }
 * }
 */

// ============================================================================
// TODO: REAL-TIME LEADERBOARD
// ============================================================================
/**
 * REAL-TIME LEADERBOARD SYSTEM
 * 
 * Tracks top players by balance and broadcasts updates every 5 seconds
 */

// Helper function to get leaderboard for a room
function getLeaderboard(roomId: string): Array<{
  username: string;
  balance: number;
  kills: number;
  length: number;
}> {
  const room = gameRooms.get(roomId);
  if (!room) return [];
  
  return Array.from(room.values())
    .filter(p => !p.id.startsWith('bot-')) // Exclude bots from leaderboard
    .map(p => ({ 
      username: p.username, 
      balance: p.money, 
      kills: p.kills, 
      length: p.length 
    }))
    .sort((a, b) => b.balance - a.balance) // Sort by balance (money)
    .slice(0, 10); // Top 10 players
}

// Broadcast leaderboard updates every 5 seconds
setInterval(() => {
  for (const [roomId, room] of gameRooms) {
    if (room.size > 0) {
      const leaderboard = getLeaderboard(roomId);
      io.to(roomId).emit('leaderboardUpdate', leaderboard);
      console.log(`📊 Broadcasted leaderboard for room ${roomId}: ${leaderboard.length} players`);
    }
  }
}, 5000); // Every 5 seconds

// Helper function to notify a user
function notifyUser(username: string, event: string, data: any) {
  const userSockets = onlineUsers.get(username);
  if (userSockets) {
    userSockets.forEach(socketId => {
      io.to(socketId).emit(event, data);
    });
  }
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);
  
  // Extract room information from query parameters
  const roomId = socket.handshake.query.room;
  const region = socket.handshake.query.region;
  const mode = socket.handshake.query.mode;
  
  // Ensure username is never undefined or empty
  let username = socket.handshake.query.username as string;
  if (!username || username === 'undefined' || username === 'null' || username.trim() === '') {
    username = `Player${Math.floor(Math.random() * 9999)}`;
  }
  
  let currentRoomId: string | null = null;
  let isPlayerInGame = false; // Track if player is actually in game
  
  // ============================================================================
  // MULTIPLAYER: JOIN GAME EVENT (EXPLICIT)
  // ============================================================================
  /**
   * Player explicitly joins the game (not automatic on connection!)
   * This is called when player actually starts playing, not just connecting
   */
  socket.on('joinGame', ({ roomId: joinRoomId, region: joinRegion, username: joinUsername }) => {
    if (isPlayerInGame) {
      console.log(`⚠️ Player ${socket.id} already in game, ignoring duplicate join`);
      return;
    }
    
    const roomName = `${joinRegion}:${joinRoomId}`;
    currentRoomId = roomName;
    
    // Update username if provided
    if (joinUsername && joinUsername !== 'undefined') {
      username = joinUsername;
    }
    
    socket.join(roomName);
    console.log(`🎮 User ${socket.id} (${username}) EXPLICITLY joined game in room ${roomName} (mode: ${mode})`);
    
    // ============================================================================
    // ROOM CAPACITY CHECK - MAX 80 PLAYERS PER ROOM
    // ============================================================================
    const room = getOrCreateRoom(roomName);
    
    // Check if room is full (max 80 players)
    if (room.size >= 80) {
      console.log(`❌ Room ${roomName} is FULL (${room.size}/80 players). Rejecting ${username}`);
      socket.emit('roomFull', {
        message: 'This room is full. Please try another room.',
        currentPlayers: room.size,
        maxPlayers: 80
      });
      socket.disconnect();
      return;
    }
    
    const spawnPos = generateSpawnPosition();
    const newPlayer: PlayerState = {
      id: socket.id,
      username: username,
      head: spawnPos,
      direction: Math.random() * Math.PI * 2,
      speed: 2.5,
      length: 10,
      color: generatePlayerColor(),
      segments: [spawnPos],
      isBoosting: false,
      score: 0,
      money: 1.00,
      kills: 0,
      lastUpdate: Date.now()
    };
    
    // Add player to room
    room.set(socket.id, newPlayer);
    isPlayerInGame = true;
    
    // Send current game state to the new player (EXCLUDING themselves)
    const otherPlayers = new Map(room);
    otherPlayers.delete(socket.id); // Remove self from the list
    
    const gameState: GameStateSnapshot = {
      players: Object.fromEntries(otherPlayers),
      timestamp: Date.now()
    };
    socket.emit('gameState', gameState);
    console.log(`📤 Sent game state with ${otherPlayers.size} existing players to ${username} (excluding self)`);
    
    // Broadcast new player to all OTHER players in the room
    socket.to(roomName).emit('playerJoined', {
      player: newPlayer,
      timestamp: Date.now()
    });
    console.log(`📢 Broadcasted new player ${username} to room ${roomName}`);
  });

  // Listen for user joining
  socket.on("join", async (username: string) => {
    if (!username) {
      console.log('Join event received with empty username');
      return;
    }

    if (!onlineUsers.has(username)) {
      onlineUsers.set(username, new Set());
    }
    onlineUsers.get(username)?.add(socket.id);

    const onlineUsersList = Array.from(onlineUsers.keys());
    console.log(`User joined: ${username} with socket ${socket.id}`);
    console.log(`Current online users:`, onlineUsersList);
    io.emit("online-users", onlineUsersList);

    // Send any pending friend requests to this user from database
    try {
      const user = await storage.getUserByUsername(username);
      if (user) {
        const pendingRequests = await storage.getFriendRequests(user.id);
        if (pendingRequests.length > 0) {
          console.log(`Sending ${pendingRequests.length} pending friend requests to ${username}`);
          for (const request of pendingRequests) {
            const fromUser = await storage.getUser(request.fromUserId);
            if (fromUser) {
              socket.emit("friend-request", { 
                id: request.id, 
                username: fromUser.username, 
                timestamp: request.createdAt.toISOString() 
              });
            }
          }
        }

        // Send friends list to user from database
        const friends = await storage.getUserFriends(user.id);
        const friendsList = await Promise.all(
          friends.map(async (friend) => {
            const friendUser = await storage.getUser(friend.friendId);
            return {
              id: friend.friendId,
              username: friendUser?.username || 'Unknown',
              isOnline: onlineUsers.has(friendUser?.username || ''),
              isPlaying: false
            };
          })
        );
        socket.emit("friends-list", friendsList);
      }
    } catch (error) {
      console.error('Error loading user data:', error);
    }
  });

  // Listen for game invites
  socket.on("invite", ({ from, to, roomId, region, mode }) => {
    const toSockets = onlineUsers.get(to);
    if (toSockets) {
      toSockets.forEach((socketId) => {
        io.to(socketId).emit("game-invite", { from, roomId, region, mode });
      });
    }
  });

  // Listen for friend game invites
  socket.on("invite-friend", ({ from, to, roomId, region }) => {
    console.log(`🎮 Friend game invite: ${from} -> ${to} in room ${roomId}`);
    const toSockets = onlineUsers.get(to);
    if (toSockets) {
      toSockets.forEach((socketId) => {
        console.log(`🎮 Sending game invite to socket ${socketId} for user ${to}`);
        io.to(socketId).emit("game-invite", { from, roomId, region, mode: 'friends' });
      });
    } else {
      console.log(`❌ User ${to} not found in online users`);
    }
  });

  // Listen for invite acceptance
  socket.on("accept-invite", ({ from, to, roomId, region, mode }) => {
    console.log(`🎮 Invite accepted: ${to} accepted ${from}'s invite to room ${roomId}`);
    const fromSockets = onlineUsers.get(from);
    if (fromSockets) {
      fromSockets.forEach((socketId) => {
        console.log(`🎮 Sending invite accepted to socket ${socketId} for user ${from}`);
        io.to(socketId).emit("invite-accepted", { to, roomId, region, mode });
      });
    } else {
      console.log(`❌ User ${from} not found in online users`);
    }
  });

  // Handle friend requests with acknowledgment
  socket.on("send-friend-request", async ({ from, to }, acknowledgment) => {
    if (!from || !to || from === to) {
      if (typeof acknowledgment === 'function') {
        acknowledgment({ success: false, message: "Invalid friend request" });
      }
      return;
    }
    
    console.log(`Friend request attempt: ${from} -> ${to}`);
    
    try {
      // Get or create users
      let fromUser = await storage.getUserByUsername(from);
      let toUser = await storage.getUserByUsername(to);

      // Create users if they don't exist
      if (!fromUser) {
        console.log(`Creating user: ${from}`);
        fromUser = await storage.createUser({
          username: from,
          password: 'auto_generated', // Auto-generated password for friend system
          balance: '1.05' // Starting balance
        });
      }

      if (!toUser) {
        console.log(`Creating user: ${to}`);
        toUser = await storage.createUser({
          username: to,
          password: 'auto_generated', // Auto-generated password for friend system
          balance: '1.05' // Starting balance
        });
      }

      const request = await storage.sendFriendRequest(fromUser.id, toUser.id);
      
      const toSockets = onlineUsers.get(to);
      if (toSockets && toSockets.size > 0) {
        toSockets.forEach((socketId) => {
          console.log(`Sending friend request to socket ${socketId} for user ${to}`);
          const requestData = { 
            id: request.id, 
            username: from, 
            timestamp: request.createdAt.toISOString() 
          };
          io.to(socketId).emit("friend-request", requestData);
        });
        if (typeof acknowledgment === 'function') {
          acknowledgment({ success: true, message: "Friend request sent" });
        }
      } else {
        if (typeof acknowledgment === 'function') {
          acknowledgment({ success: true, message: "Friend request saved - will be delivered when user is online" });
        }
      }
      
      console.log(`Friend request sent from ${from} to ${to}`);
    } catch (error) {
      console.error('Error sending friend request:', error);
      if (typeof acknowledgment === 'function') {
        acknowledgment({ success: false, message: "Error sending friend request" });
      }
    }
  });

  // Handle friend request acceptance
  socket.on("accept-friend-request", async ({ from, to }) => {
    if (!from || !to) return;
    
    console.log(`Friend request accepted: ${from} accepted ${to}'s request`);
    
    try {
      // Get or create users
      let fromUser = await storage.getUserByUsername(from);
      let toUser = await storage.getUserByUsername(to);

      // Create users if they don't exist
      if (!fromUser) {
        console.log(`Creating user: ${from}`);
        fromUser = await storage.createUser({
          username: from,
          password: 'auto_generated',
          balance: '1.05'
        });
      }

      if (!toUser) {
        console.log(`Creating user: ${to}`);
        toUser = await storage.createUser({
          username: to,
          password: 'auto_generated',
          balance: '1.05'
        });
      }

      // Find the pending friend request from toUser to fromUser
      const friendRequests = await storage.getFriendRequests(fromUser.id);
      const pendingRequest = friendRequests.find(req => 
        req.fromUserId === toUser.id && req.status === 'pending'
      );

      if (!pendingRequest) {
        console.log('No pending friend request found');
        return;
      }

      // Accept friend request in database (this also adds both users as friends)
      await storage.acceptFriendRequest(pendingRequest.id);
      
      notifyUser(from, "friend-added", { username: to });
      notifyUser(to, "friend-added", { username: from });
      
      const fromFriends = await storage.getUserFriends(fromUser.id);
      const fromFriendsList = await Promise.all(
        fromFriends.map(async (friend) => {
          const friendUser = await storage.getUser(friend.friendId);
          return {
            id: friend.friendId,
            username: friendUser?.username || 'Unknown',
            isOnline: onlineUsers.has(friendUser?.username || ''),
            isPlaying: false
          };
        })
      );
      notifyUser(from, "friends-list", fromFriendsList);
      
      const toFriends = await storage.getUserFriends(toUser.id);
      const toFriendsList = await Promise.all(
        toFriends.map(async (friend) => {
          const friendUser = await storage.getUser(friend.friendId);
          return {
            id: friend.friendId,
            username: friendUser?.username || 'Unknown',
            isOnline: onlineUsers.has(friendUser?.username || ''),
            isPlaying: false
          };
        })
      );
      notifyUser(to, "friends-list", toFriendsList);
      
      console.log(`Friendship established between ${from} and ${to}`);
      
      const roomId = `${Math.floor(Math.random() * 100000)}`;
      const region = "us";
      
      notifyUser(from, "auto-game-start", { roomId, region, friend: to, mode: 'friends' });
      notifyUser(to, "auto-game-start", { roomId, region, friend: from, mode: 'friends' });
    } catch (error) {
      console.error('Error accepting friend request:', error);
    }
  });

  // Handle friend request decline
  socket.on("decline-friend-request", async ({ from, to }) => {
    if (!from || !to) return;
    
    try {
      // Get or create users
      let fromUser = await storage.getUserByUsername(from);
      let toUser = await storage.getUserByUsername(to);

      // Create users if they don't exist
      if (!fromUser) {
        console.log(`Creating user: ${from}`);
        fromUser = await storage.createUser({
          username: from,
          password: 'auto_generated',
          balance: '1.05'
        });
      }

      if (!toUser) {
        console.log(`Creating user: ${to}`);
        toUser = await storage.createUser({
          username: to,
          password: 'auto_generated',
          balance: '1.05'
        });
      }

      // Find the pending friend request from toUser to fromUser
      const friendRequests = await storage.getFriendRequests(fromUser.id);
      const pendingRequest = friendRequests.find(req => 
        req.fromUserId === toUser.id && req.status === 'pending'
      );

      if (!pendingRequest) {
        console.log('No pending friend request found');
        return;
      }

      // Decline friend request in database
      await storage.declineFriendRequest(pendingRequest.id);
      
      console.log(`Friend request declined from ${to} to ${from}`);
    } catch (error) {
      console.error('Error declining friend request:', error);
    }
  });

  // Get user's friends list
  socket.on("get-friends", async (username) => {
    try {
      let user = await storage.getUserByUsername(username);
      
      // Create user if they don't exist
      if (!user) {
        console.log(`Creating user: ${username}`);
        user = await storage.createUser({
          username: username,
          password: 'auto_generated',
          balance: '1.05'
        });
      }

      const friends = await storage.getUserFriends(user.id);
      const friendsList = await Promise.all(
        friends.map(async (friend) => {
          const friendUser = await storage.getUser(friend.friendId);
          return {
            id: friend.friendId,
            username: friendUser?.username || 'Unknown',
            isOnline: onlineUsers.has(friendUser?.username || ''),
            isPlaying: false
          };
        })
      );
      
      socket.emit("friends-list", friendsList);
    } catch (error) {
      console.error('Error getting friends list:', error);
    }
  });

  // Get user's pending friend requests
  socket.on("get-friend-requests", async (username) => {
    try {
      let user = await storage.getUserByUsername(username);
      
      // Create user if they don't exist
      if (!user) {
        console.log(`Creating user: ${username}`);
        user = await storage.createUser({
          username: username,
          password: 'auto_generated',
          balance: '1.05'
        });
      }

      const requests = await storage.getFriendRequests(user.id);
      const requestsList = await Promise.all(
        requests.map(async (request) => {
          const fromUser = await storage.getUser(request.fromUserId);
          return {
            id: request.id,
            username: fromUser?.username || 'Unknown',
            timestamp: request.createdAt.toISOString()
          };
        })
      );
      
      socket.emit("friend-requests", requestsList);
    } catch (error) {
      console.error('Error getting friend requests:', error);
    }
  });

  // Auto-start game when both users become friends
  socket.on("start-game-with-friend", ({ from, to, region }) => {
    const fromSockets = onlineUsers.get(from);
    const toSockets = onlineUsers.get(to);
    
    if (fromSockets && toSockets) {
      const roomId = `${Math.floor(Math.random() * 100000)}`;
      const gameRegion = region || 'us';
      
      fromSockets.forEach((socketId) => {
        io.to(socketId).emit("auto-game-start", { roomId, region: gameRegion, friend: to, mode: 'friends' });
      });
      toSockets.forEach((socketId) => {
        io.to(socketId).emit("auto-game-start", { roomId, region: gameRegion, friend: from, mode: 'friends' });
      });
      
      console.log(`Auto-starting friend game between ${from} and ${to} in room ${roomId}`);
    }
  });

  // Handle friend game invitations
  socket.on("invite-friend", ({ from, to, roomId, region }) => {
    const toSockets = onlineUsers.get(to);
    if (toSockets) {
      toSockets.forEach((socketId) => {
        io.to(socketId).emit("game-invite", { from, roomId, region, mode: 'friends' });
      });
    }
  });

  // Handle friend requests with acknowledgment (fallback for non-database mode)
  socket.on("send-friend-request-fallback", ({ from, to }, acknowledgment) => {
    if (!from || !to || from === to) {
      if (typeof acknowledgment === 'function') {
        acknowledgment({ success: false, message: "Invalid friend request" });
      }
      return;
    }
    
    const requestId = `${from}_${to}_${Date.now()}`;
    const timestamp = new Date().toISOString();
    
    console.log(`Friend request attempt (fallback): ${from} -> ${to}`);
    
    // Add to recipient's pending requests
    if (!friendRequests.has(to)) {
      friendRequests.set(to, []);
    }
    friendRequests.get(to)?.push({ id: requestId, from, timestamp });
    
    // Notify recipient if online
    const toSockets = onlineUsers.get(to);
    if (toSockets && toSockets.size > 0) {
      toSockets.forEach((socketId) => {
        console.log(`Sending friend request to socket ${socketId} for user ${to}`);
        const requestData = { id: requestId, username: from, timestamp };
        io.to(socketId).emit("friend-request", requestData);
      });
      if (typeof acknowledgment === 'function') {
        acknowledgment({ success: true, message: "Friend request sent" });
      }
    } else {
      if (typeof acknowledgment === 'function') {
        acknowledgment({ success: true, message: "Friend request saved - will be delivered when user is online" });
      }
    }
    
    console.log(`Friend request sent from ${from} to ${to}`);
  });

  // Handle friend request acceptance (fallback for non-database mode)
  socket.on("accept-friend-request-fallback", ({ from, to }: { from: string; to: string }) => {
    if (!from || !to) return;
    
    console.log(`Friend request accepted (fallback): ${from} accepted ${to}'s request`);
    
    // Add to both users' friends lists
    if (!userFriends.has(from)) {
      userFriends.set(from, new Set());
    }
    if (!userFriends.has(to)) {
      userFriends.set(to, new Set());
    }
    userFriends.get(from)?.add(to);
    userFriends.get(to)?.add(from);
    
    // Remove from pending requests
    if (friendRequests.has(from)) {
      const requests = friendRequests.get(from)?.filter(req => req.from !== to) || [];
      friendRequests.set(from, requests);
    }
    
    // Notify both users
    notifyUser(from, "friend-added", { username: to });
    notifyUser(to, "friend-added", { username: from });
    
    // Send updated friends lists
    const fromFriendsSet = userFriends.get(from) || new Set<string>();
    const fromFriends = Array.from(fromFriendsSet).map((friend) => ({
      id: friend,
      username: friend,
      isOnline: onlineUsers.has(friend),
      isPlaying: false
    }));
    notifyUser(from, "friends-list", fromFriends);
    
    const toFriendsSet = userFriends.get(to) || new Set<string>();
    const toFriends = Array.from(toFriendsSet).map((friend) => ({
      id: friend,
      username: friend,
      isOnline: onlineUsers.has(friend),
      isPlaying: false
    }));
    notifyUser(to, "friends-list", toFriends);
    
    console.log(`Friendship established between ${from} and ${to}`);
    
    // Auto-create game room
    const roomId = `${Math.floor(Math.random() * 100000)}`;
    const region = "us";
    
    notifyUser(from, "auto-game-start", { roomId, region, friend: to, mode: 'friends' });
    notifyUser(to, "auto-game-start", { roomId, region, friend: from, mode: 'friends' });
  });

  // Handle friend request decline (fallback for non-database mode)
  socket.on("decline-friend-request-fallback", ({ from, to }: { from: string; to: string }) => {
    if (!from || !to) return;
    
    // Remove from pending requests
    if (friendRequests.has(from)) {
      const requests = friendRequests.get(from)?.filter(req => req.from !== to) || [];
      friendRequests.set(from, requests);
    }
    
    console.log(`Friend request declined from ${to} to ${from}`);
  });

  // Get user's friends list (fallback for non-database mode)
  socket.on("get-friends-fallback", (username: string) => {
    const friends = userFriends.get(username) || new Set();
    const friendsList = Array.from(friends).map(friend => ({
      id: friend,
      username: friend,
      isOnline: onlineUsers.has(friend),
      isPlaying: false
    }));
    
    socket.emit("friends-list", friendsList);
  });

  // Get user's pending friend requests (fallback for non-database mode)
  socket.on("get-friend-requests-fallback", (username: string) => {
    const requests = friendRequests.get(username) || [];
    socket.emit("friend-requests", requests);
  });

  // ============================================================================
  // MULTIPLAYER: PLAYER POSITION UPDATES
  // ============================================================================
  
  /**
   * Handle player position/state updates
   * - Update player state in server memory
   * - Broadcast to all other players in the room
   * 
   * This is called frequently (e.g., every 50ms) from each client
   * IMPORTANT: Only processes updates for players who are actually in game
   */
  socket.on('playerUpdate', (updateData: PlayerUpdate) => {
    // Ignore updates from players not in game
    if (!isPlayerInGame || !currentRoomId) return;
    
    const room = gameRooms.get(currentRoomId);
    if (!room) return;
    
    const player = room.get(socket.id);
    if (!player) return;
    
    // Validate update data before processing
    if (!updateData.head || typeof updateData.head.x !== 'number' || typeof updateData.head.y !== 'number') {
      console.warn(`⚠️ Invalid playerUpdate data from ${socket.id}, skipping update`);
      return;
    }
    
    // Update player state with new data
    player.head = updateData.head;
    player.direction = updateData.direction;
    player.speed = updateData.speed;
    player.length = updateData.length;
    player.isBoosting = updateData.isBoosting;
    player.lastUpdate = Date.now();
    
    // Note: segments are updated separately for performance
    // Full segment data is only sent when necessary (e.g., on growth)
    
    // Broadcast update to all OTHER players in the room
    // We only send the essential data to reduce bandwidth
    socket.to(currentRoomId).emit('playerUpdate', {
      id: socket.id,
      head: player.head,
      direction: player.direction,
      speed: player.speed,
      length: player.length,
      isBoosting: player.isBoosting
    });
  });
  
  /**
   * Handle full player state updates (includes segments)
   * Used less frequently when player grows or needs full sync
   * IMPORTANT: Only processes updates for players who are actually in game
   */
  socket.on('playerStateUpdate', (stateData: Partial<PlayerState>) => {
    // Ignore updates from players not in game
    if (!isPlayerInGame || !currentRoomId) return;
    
    const room = gameRooms.get(currentRoomId);
    if (!room) return;
    
    const player = room.get(socket.id);
    if (!player) return;
    
    // Update full player state
    Object.assign(player, stateData, { lastUpdate: Date.now() });
    
    // Broadcast full state to other players
    socket.to(currentRoomId).emit('playerStateUpdate', {
      id: socket.id,
      ...stateData
    });
  });

  // ============================================================================
  // MULTIPLAYER: PLAYER RESPAWN HANDLER
  // ============================================================================
  
  /**
   * Handle player respawn events
   * When a player respawns:
   * 1. Reset their balance to default ($1.00)
   * 2. Reset their position to a new spawn location
   * 3. Reset their stats (length, kills, etc.)
   * 4. Broadcast respawn event to all players
   * IMPORTANT: Only processes respawns for players who are actually in game
   */
  socket.on('playerRespawn', () => {
    // Ignore respawns from players not in game
    if (!isPlayerInGame || !currentRoomId) return;
    
    const room = gameRooms.get(currentRoomId);
    if (!room) return;
    
    const player = room.get(socket.id);
    if (!player) {
      console.log(`❌ Respawn event error: player not found`);
      return;
    }
    
    // Check if this is a real player (not a bot)
    const isPlayerBot = player.id.startsWith('bot-');
    
    if (!isPlayerBot) {
      // Reset player state for real players
      const spawnPos = generateSpawnPosition();
      const previousBalance = player.money;
      
      player.head = spawnPos;
      player.direction = Math.random() * Math.PI * 2;
      player.speed = 2.5;
      player.length = 10;
      player.segments = [spawnPos];
      player.isBoosting = false;
      player.score = 0;
      player.money = 1.00; // Reset balance to default
      player.kills = 0;
      player.lastUpdate = Date.now();
      
      console.log(`🔄 ${player.username} respawned with balance reset: $${previousBalance.toFixed(2)} → $${player.money.toFixed(2)}`);
      
      // Emit balance update to respawned player
      socket.emit('balanceUpdate', {
        playerId: player.id,
        newBalance: player.money,
        moneyGained: 0,
        source: 'respawn',
        timestamp: Date.now()
      });
      
      // Broadcast respawn event to all players in room
      io.to(currentRoomId).emit('playerRespawned', {
        playerId: player.id,
        username: player.username,
        newPosition: spawnPos,
        newBalance: player.money,
        timestamp: Date.now()
      });
      
      // Emit balance update to all players for leaderboard/HUD updates
      io.to(currentRoomId).emit('balanceUpdate', {
        playerId: player.id,
        newBalance: player.money,
        moneyGained: 0,
        source: 'respawn',
        timestamp: Date.now()
      });
    }
  });

  // ============================================================================
  // MULTIPLAYER: KILL EVENT HANDLER
  // ============================================================================
  
  /**
   * Handle player kill events
   * When a player kills another:
   * 1. Transfer victim's money to killer
   * 2. Increment killer's kill count
   * 3. Remove victim from game
   * 4. Broadcast kill event to all players
   * IMPORTANT: Only processes kills for players who are actually in game
   */
  socket.on('playerKilled', ({ victimId }: { victimId: string }) => {
    // Ignore kills from players not in game
    if (!isPlayerInGame || !currentRoomId) return;
    
    const room = gameRooms.get(currentRoomId);
    if (!room) return;
    
    const killer = room.get(socket.id);
    const victim = room.get(victimId);
    
    if (!killer || !victim) {
      console.log(`❌ Kill event error: killer or victim not found`);
      return;
    }
    
    // Check if this is a bot kill (exclude from money system)
    const isKillerBot = killer.id.startsWith('bot-');
    const isVictimBot = victim.id.startsWith('bot-');
    
    // Only process money transfers for real player kills
    if (!isKillerBot && !isVictimBot) {
      // Transfer money from victim to killer
      const moneyGained = victim.money;
      killer.money += moneyGained;
      killer.kills += 1;
      
      console.log(`💀 ${killer.username} killed ${victim.username} and gained $${moneyGained.toFixed(2)}`);
      console.log(`💰 ${killer.username} now has $${killer.money.toFixed(2)} (${killer.kills} kills)`);
      
      // Emit balance update to killer
      socket.emit('balanceUpdate', {
        playerId: killer.id,
        newBalance: killer.money,
        moneyGained: moneyGained,
        source: 'kill',
        timestamp: Date.now()
      });
      
      // Broadcast kill event to all players in room
      io.to(currentRoomId).emit('playerKilled', {
        killerId: killer.id,
        killerUsername: killer.username,
        victimId: victim.id,
        victimUsername: victim.username,
        moneyGained: moneyGained,
        newKillerMoney: killer.money,
        newKillerKills: killer.kills,
        timestamp: Date.now()
      });
      
      // Emit balance update to all players for leaderboard/HUD updates
      io.to(currentRoomId).emit('balanceUpdate', {
        playerId: killer.id,
        newBalance: killer.money,
        moneyGained: moneyGained,
        source: 'kill',
        timestamp: Date.now()
      });
      
    } else {
      // Bot kill - no money transfer, just increment kills for killer if real player
      if (!isKillerBot) {
        killer.kills += 1;
        console.log(`🤖 ${killer.username} killed bot ${victim.username} (no money transfer)`);
        
        // Still broadcast kill event for UI updates (but no money)
        io.to(currentRoomId).emit('playerKilled', {
          killerId: killer.id,
          killerUsername: killer.username,
          victimId: victim.id,
          victimUsername: victim.username,
          moneyGained: 0, // No money for bot kills
          newKillerMoney: killer.money,
          newKillerKills: killer.kills,
          timestamp: Date.now()
        });
      }
    }
    
    // Remove victim from room
    room.delete(victimId);
    
    // Send playerLeft event so clients remove the victim
    io.to(currentRoomId).emit('playerLeft', {
      playerId: victimId,
      timestamp: Date.now()
    });
  });

  // Game-related event handlers (LEGACY - keeping for compatibility)
  socket.on('playerUpdate_legacy', (data) => {
    // Get the room from the socket's query parameters
    const roomId = socket.handshake.query.room;
    const region = socket.handshake.query.region;
    const mode = socket.handshake.query.mode;
    
    if (roomId && region) {
      const roomName = `${region}:${roomId}`;
      console.log(`🎮 Player update from room ${roomName} (mode: ${mode})`);
      
      // Broadcast player update to all other clients in the same room
      socket.to(roomName).emit('message', {
        type: 'players',
        players: [data],
        roomId: roomId,
        region: region,
        mode: mode
      });
    } else {
      console.log(`❌ Player update without room info: roomId=${roomId}, region=${region}`);
    }
  });

  socket.on('boostFood', (data) => {
    // Broadcast boost food to all other clients
    socket.broadcast.emit('message', data);
  });

  socket.on('moneyCrate', (data) => {
    // Broadcast money crate to all other clients
    socket.broadcast.emit('message', data);
  });

  socket.on('gameOver', (data) => {
    // Broadcast game over to all other clients
    socket.broadcast.emit('message', data);
  });

  socket.on('ghostModeEnd', (data) => {
    // Broadcast ghost mode end to all other clients
    socket.broadcast.emit('message', data);
  });

  socket.on('cashOutCancelled', (data) => {
    // Broadcast cash out cancellation to all other clients
    socket.broadcast.emit('message', data);
  });

  socket.on('cashingOut', (data) => {
    // Broadcast cash out progress to all other clients
    socket.broadcast.emit('message', data);
  });

  socket.on('cashOutComplete', (data) => {
    // Broadcast cash out completion to all other clients
    socket.broadcast.emit('message', data);
  });

  socket.on('moneyCrateCollected', (data) => {
    // Broadcast money crate collection to all other clients
    socket.broadcast.emit('message', data);
  });

  socket.on('ping', (data) => {
    // Respond to ping with pong
    socket.emit('pong', { timestamp: Date.now() });
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    // ============================================================================
    // MULTIPLAYER: PLAYER DISCONNECT - ROBUST CLEANUP
    // ============================================================================
    
    /**
     * Remove player from game room and notify other players
     * IMPORTANT: Search ALL rooms to ensure cleanup (fixes stuck players bug)
     */
    let playerRemoved = false;
    
    // Try current room first (fast path)
    if (currentRoomId) {
      const room = gameRooms.get(currentRoomId);
      if (room && room.has(socket.id)) {
        const player = room.get(socket.id);
        room.delete(socket.id);
        playerRemoved = true;
        
        console.log(`🎮 Player ${player?.username} left room ${currentRoomId} (${room.size} remaining)`);
        
        // Broadcast player leave event to remaining players
        socket.to(currentRoomId).emit('playerLeft', {
          playerId: socket.id,
          timestamp: Date.now()
        });
        
        // Clean up empty rooms
        if (room.size === 0) {
          gameRooms.delete(currentRoomId);
          console.log(`🧹 Cleaned up empty room ${currentRoomId}`);
        }
      }
    }
    
    // Fallback: Search all rooms (in case currentRoomId wasn't set or is stale)
    // Note: This is NORMAL for users who just connected but didn't join a game
    if (!playerRemoved) {
      for (const [roomId, room] of gameRooms.entries()) {
        if (room.has(socket.id)) {
          const player = room.get(socket.id);
          room.delete(socket.id);
          playerRemoved = true;
          
          console.log(`🔍 Found and removed ${player?.username} from room ${roomId} (${room.size} remaining)`);
          
          // Broadcast player leave event
          io.to(roomId).emit('playerLeft', {
            playerId: socket.id,
            timestamp: Date.now()
          });
          
          // Clean up empty rooms
          if (room.size === 0) {
            gameRooms.delete(roomId);
            console.log(`🧹 Cleaned up empty room ${roomId}`);
          }
          
          break; // Player can only be in one room
        }
      }
    }

    // Clean up online users tracking
    for (const [username, sockets] of onlineUsers.entries()) {
      if (sockets.has(socket.id)) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(username);
        }
      }
    }

    const onlineUsersList = Array.from(onlineUsers.keys());
    io.emit("online-users", onlineUsersList);
  });
});

// CORS & security headers middleware
app.use((req, res, next) => {
  const allowedOrigins = isProduction
    ? [
        process.env.FRONTEND_URL || "https://harmonious-boba-11ae9e.netlify.app",
        "https://harmonious-boba-11ae9e.netlify.app",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
      ]
    : ["*"];

  const origin = req.get("origin");
  if (allowedOrigins.includes("*") || (origin && allowedOrigins.includes(origin))) {
    res.header("Access-Control-Allow-Origin", origin || "*");
  }

  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control, Pragma"
  );
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("X-Content-Type-Options", "nosniff");
  res.header("X-Frame-Options", "DENY");
  res.header("X-XSS-Protection", "1; mode=block");
  res.header("Referrer-Policy", "strict-origin-when-cross-origin");
  res.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false, limit: "10mb" }));

// Performance logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    if (req.path.startsWith("/api")) {
      const duration = Date.now() - start;
      console.log(`${req.method} ${req.path} ${res.statusCode} in ${duration}ms`);
    }
  });
  next();
});

// Health check
app.get("/health", (_req, res) => {
  // Calculate total players across all game rooms
  let totalPlayers = 0;
  for (const room of gameRooms.values()) {
    totalPlayers += room.size;
  }
  
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "production",
    onlineUsers: Array.from(onlineUsers.keys()).length,
    friendRequests: Array.from(friendRequests.keys()).reduce((acc, key) => acc + (friendRequests.get(key)?.length || 0), 0),
    userFriends: Array.from(userFriends.keys()).length,
    socketConnections: io.sockets.sockets.size,
    // Multiplayer stats
    multiplayer: {
      activeRooms: gameRooms.size,
      totalPlayersInGame: totalPlayers,
      roomDetails: Array.from(gameRooms.entries()).map(([roomId, players]) => ({
        roomId,
        playerCount: players.size
      }))
    },
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: process.env.npm_package_version || "1.0.0"
  });
});

// Emergency cleanup endpoint for stuck players
app.post("/api/cleanup-stale-players", (_req, res) => {
  const now = Date.now();
  const staleThreshold = 30000; // 30 seconds for manual cleanup
  let totalCleaned = 0;
  let roomsCleaned = 0;
  
  console.log('🚨 Manual cleanup triggered!');
  
  for (const [roomId, room] of gameRooms.entries()) {
    const initialSize = room.size;
    const playersToRemove: string[] = [];
    
    for (const [playerId, player] of room.entries()) {
      const timeSinceUpdate = now - player.lastUpdate;
      if (timeSinceUpdate > staleThreshold) {
        playersToRemove.push(playerId);
      }
    }
    
    // Remove stale players
    for (const playerId of playersToRemove) {
      const player = room.get(playerId);
      room.delete(playerId);
      totalCleaned++;
      
      console.log(`🧹 Manual cleanup: Removed ${player?.username} from ${roomId}`);
      
      // Broadcast removal
      io.to(roomId).emit('playerLeft', {
        playerId: playerId,
        timestamp: now
      });
    }
    
    if (playersToRemove.length > 0) {
      roomsCleaned++;
      console.log(`🧹 Room ${roomId}: ${initialSize} → ${room.size} players`);
    }
    
    // Clean up empty rooms
    if (room.size === 0) {
      gameRooms.delete(roomId);
      console.log(`🧹 Manual cleanup: Removed empty room ${roomId}`);
    }
  }
  
  const remainingPlayers = Array.from(gameRooms.values()).reduce((acc, room) => acc + room.size, 0);
  
  res.status(200).json({
    success: true,
    message: `Cleaned up ${totalCleaned} stale players from ${roomsCleaned} rooms`,
    totalCleaned,
    roomsCleaned,
    remainingPlayers,
    remainingRooms: gameRooms.size,
    roomDetails: Array.from(gameRooms.entries()).map(([roomId, room]) => ({
      roomId,
      playerCount: room.size
    }))
  });
  
  console.log(`✨ Manual cleanup complete: Removed ${totalCleaned} stale players, ${remainingPlayers} remaining`);
});

// EMERGENCY: Clear ALL game rooms (use carefully!)
app.post("/api/emergency-clear-all-rooms", (_req, res) => {
  console.log('🚨🚨🚨 EMERGENCY CLEAR ALL ROOMS TRIGGERED!');
  
  let totalPlayersRemoved = 0;
  let totalRoomsRemoved = 0;
  
  for (const [roomId, room] of gameRooms.entries()) {
    totalPlayersRemoved += room.size;
    totalRoomsRemoved++;
    
    // Notify all players in room that it's being cleared
    io.to(roomId).emit('serverRestart', {
      message: 'Server is restarting. Please reconnect.',
      timestamp: Date.now()
    });
    
    console.log(`🧹 Emergency clear: Removed room ${roomId} (${room.size} players)`);
  }
  
  // Clear all rooms
  gameRooms.clear();
  
  res.status(200).json({
    success: true,
    message: 'All game rooms cleared',
    playersRemoved: totalPlayersRemoved,
    roomsRemoved: totalRoomsRemoved,
    remainingPlayers: 0,
    remainingRooms: 0
  });
  
  console.log(`✨ Emergency clear complete: Removed ${totalRoomsRemoved} rooms with ${totalPlayersRemoved} players`);
});

// WebSocket health check
app.get("/ws-health", (_req, res) => {
  res.status(200).json({
    websocket: "active",
    path: "/ws",
    server: "running",
    timestamp: new Date().toISOString()
  });
});

// Serve static files
app.use(express.static("public"));

// Register routes & error handling
(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    if (isProduction) console.error("Production error:", err);
    res.status(status).json({ 
      message: isProduction ? "Internal Server Error" : message,
      ...(!isProduction && { stack: err.stack })
    });
  });

  const port = parseInt(process.env.PORT || "5174", 10);
  const host = "0.0.0.0";

  httpServer.listen(port, host, () => {
    console.log(`🚀 Server running in ${isProduction ? "PRODUCTION" : "DEVELOPMENT"} mode`);
    console.log(`🌐 Listening on ${host}:${port}`);
    console.log(`📊 Health check: http://localhost:${port}/health`);
    console.log(`🔌 WebSocket health check: http://localhost:${port}/ws-health`);
    console.log(`🔌 Socket.IO path: /socket.io`);
    console.log(`🔌 WebSocket path: /ws`);
    console.log(`🌍 CORS allowed origins:`, isProduction ? [
      process.env.FRONTEND_URL || "https://harmonious-boba-11ae9e.netlify.app",
      "https://harmonious-boba-11ae9e.netlify.app",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ] : ["*"]);
    console.log(`🔧 Environment: ${process.env.NODE_ENV || "production"}`);
    console.log(`💾 Database: ${storage ? "Connected" : "Not connected"}`);
  });
})();
