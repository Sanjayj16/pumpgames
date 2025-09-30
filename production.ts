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
 * TODO: Implement live leaderboard updates
 * 
 * Implementation steps:
 * 1. Track scores per room
 * 2. Update leaderboard on player actions (eat food, kill, etc.)
 * 3. Broadcast top 10 players every few seconds
 * 4. Send full leaderboard on request
 * 
 * Example:
 * function getLeaderboard(roomId: string): LeaderboardEntry[] {
 *   const room = gameRooms.get(roomId);
 *   if (!room) return [];
 *   
 *   return Array.from(room.values())
 *     .map(p => ({ username: p.username, score: p.score, length: p.length }))
 *     .sort((a, b) => b.score - a.score)
 *     .slice(0, 10);
 * }
 * 
 * setInterval(() => {
 *   for (const [roomId, room] of gameRooms) {
 *     io.to(roomId).emit('leaderboardUpdate', getLeaderboard(roomId));
 *   }
 * }, 5000); // Every 5 seconds
 */

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
  
  if (roomId && region) {
    const roomName = `${region}:${roomId}`;
    currentRoomId = roomName;
    socket.join(roomName);
    console.log(`🎮 User ${socket.id} (${username}) joined room ${roomName} (mode: ${mode})`);
    
    // ============================================================================
    // MULTIPLAYER: NEW PLAYER JOINS
    // ============================================================================
    
    /**
     * Initialize new player in the game room
     * - Assign spawn position and initial state
     * - Send current game state to the new player
     * - Broadcast new player to existing players
     */
    const spawnPos = generateSpawnPosition();
    const newPlayer: PlayerState = {
      id: socket.id,
      username: username, // Already validated above
      head: spawnPos,
      direction: Math.random() * Math.PI * 2, // Random initial direction
      speed: 2.5,
      length: 10, // Starting length
      color: generatePlayerColor(),
      segments: [spawnPos], // Start with just head position
      isBoosting: false,
      score: 0,
      money: 1.00, // Everyone starts with $1.00
      kills: 0,    // No kills yet
      lastUpdate: Date.now()
    };
    
    // Add player to room
    const room = getOrCreateRoom(roomName);
    room.set(socket.id, newPlayer);
    
    // Send current game state to the new player (so they see existing players)
    const gameState: GameStateSnapshot = {
      players: Object.fromEntries(room),
      timestamp: Date.now()
    };
    socket.emit('gameState', gameState);
    console.log(`📤 Sent game state with ${room.size - 1} existing players to ${username}`);
    
    // Broadcast new player to all OTHER players in the room
    socket.to(roomName).emit('playerJoined', {
      player: newPlayer,
      timestamp: Date.now()
    });
    console.log(`📢 Broadcasted new player ${username} to room ${roomName}`);
  }

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
   */
  socket.on('playerUpdate', (updateData: PlayerUpdate) => {
    if (!currentRoomId) return;
    
    const room = gameRooms.get(currentRoomId);
    if (!room) return;
    
    const player = room.get(socket.id);
    if (!player) return;
    
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
   */
  socket.on('playerStateUpdate', (stateData: Partial<PlayerState>) => {
    if (!currentRoomId) return;
    
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
  // MULTIPLAYER: KILL EVENT HANDLER
  // ============================================================================
  
  /**
   * Handle player kill events
   * When a player kills another:
   * 1. Transfer victim's money to killer
   * 2. Increment killer's kill count
   * 3. Remove victim from game
   * 4. Broadcast kill event to all players
   */
  socket.on('playerKilled', ({ victimId }: { victimId: string }) => {
    if (!currentRoomId) return;
    
    const room = gameRooms.get(currentRoomId);
    if (!room) return;
    
    const killer = room.get(socket.id);
    const victim = room.get(victimId);
    
    if (!killer || !victim) {
      console.log(`❌ Kill event error: killer or victim not found`);
      return;
    }
    
    // Transfer money from victim to killer
    const moneyGained = victim.money;
    killer.money += moneyGained;
    killer.kills += 1;
    
    console.log(`💀 ${killer.username} killed ${victim.username} and gained $${moneyGained.toFixed(2)}`);
    console.log(`💰 ${killer.username} now has $${killer.money.toFixed(2)} (${killer.kills} kills)`);
    
    // Remove victim from room
    room.delete(victimId);
    
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
    
    // Also send playerLeft event so clients remove the victim
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
    // MULTIPLAYER: PLAYER DISCONNECT
    // ============================================================================
    
    /**
     * Remove player from game room and notify other players
     */
    if (currentRoomId) {
      const room = gameRooms.get(currentRoomId);
      if (room && room.has(socket.id)) {
        const player = room.get(socket.id);
        room.delete(socket.id);
        
        console.log(`🎮 Player ${player?.username} left room ${currentRoomId}`);
        
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
