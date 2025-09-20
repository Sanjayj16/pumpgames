import express, { type Request, Response, NextFunction } from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { registerRoutes } from "./simple-routes";
import { storage } from "./storage";

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

  // Listen for invite acceptance
  socket.on("accept-invite", ({ from, to, roomId, region, mode }) => {
    const fromSockets = onlineUsers.get(from);
    if (fromSockets) {
      fromSockets.forEach((socketId) => {
        io.to(socketId).emit("invite-accepted", { to, roomId, region, mode });
      });
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
      const fromUser = await storage.getUserByUsername(from);
      const toUser = await storage.getUserByUsername(to);

      if (!fromUser || !toUser) {
        console.log('One or both users not found');
        if (typeof acknowledgment === 'function') {
          acknowledgment({ success: false, message: "User not found" });
        }
        return;
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
      const fromUser = await storage.getUserByUsername(from);
      const toUser = await storage.getUserByUsername(to);

      if (!fromUser || !toUser) {
        console.log('One or both users not found');
        return;
      }

      await storage.acceptFriendRequest(toUser.id);
      
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
      const fromUser = await storage.getUserByUsername(from);
      const toUser = await storage.getUserByUsername(to);

      if (!fromUser || !toUser) {
        console.log('One or both users not found');
        return;
      }

      await storage.declineFriendRequest(toUser.id);
      
      console.log(`Friend request declined from ${to} to ${from}`);
    } catch (error) {
      console.error('Error declining friend request:', error);
    }
  });

  // Get user's friends list
  socket.on("get-friends", async (username) => {
    try {
      const user = await storage.getUserByUsername(username);
      if (!user) return;

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
      const user = await storage.getUserByUsername(username);
      if (!user) return;

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

  // Game-related event handlers
  socket.on('playerUpdate', (data) => {
    // Broadcast player update to all other clients in the same room
    socket.broadcast.emit('message', {
      type: 'players',
      players: [data]
    });
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
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "production",
    onlineUsers: Array.from(onlineUsers.keys()).length,
    friendRequests: Array.from(friendRequests.keys()).reduce((acc, key) => acc + (friendRequests.get(key)?.length || 0), 0),
    userFriends: Array.from(userFriends.keys()).length,
    socketConnections: io.sockets.sockets.size,
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
