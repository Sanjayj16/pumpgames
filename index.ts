import express, { type Request, Response, NextFunction } from "express";
import path from "path";
import { registerRoutes } from "./simple-routes";
import { setupVite, serveStatic as defaultServeStatic, log } from "./vite";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { createServer } from "http";
import { Server } from "socket.io";
import { storage } from "./storage";

const app = express();

// Environment flags
const isProduction = process.env.NODE_ENV === "production";
const isDevelopment = process.env.NODE_ENV === "development";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create HTTP server for Socket.IO
const httpServer = createServer(app);

// Setup Socket.IO
const io = new Server(httpServer, {
  path: "/socket.io",
  cors: {
    origin: isProduction
      ? [process.env.FRONTEND_URL || "https://your-app.netlify.app"]
      : ["http://localhost:5173", "http://localhost:3000", "*"],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Map to track online users allowing multiple sockets per username
const onlineUsers = new Map<string, Set<string>>();

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
  
  if (roomId && region) {
    const roomName = `${region}:${roomId}`;
    socket.join(roomName);
    console.log(`🎮 User ${socket.id} joined room ${roomName} (mode: ${mode})`);
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
  socket.on("invite", ({ from, to, roomId, region }) => {
    const toSockets = onlineUsers.get(to);
    if (toSockets) {
      toSockets.forEach((socketId) => {
        io.to(socketId).emit("game-invite", { from, roomId, region });
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
      // Only call acknowledgment if it's provided
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

      // Create friend request in database
      const request = await storage.sendFriendRequest(fromUser.id, toUser.id);
      
      // Notify recipient if online
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
      
      // Notify both users
      notifyUser(from, "friend-added", { username: to });
      notifyUser(to, "friend-added", { username: from });
      
      // Send updated friends lists
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
      
      // Auto-create game room for friend mode
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
      console.log(`🔍 Getting friends for user: ${username}`);
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
      console.log(`✅ User ${username} found with ID: ${user.id}`);

      const friends = await storage.getUserFriends(user.id);
      console.log(`📋 Found ${friends.length} friends for user ${username}`);
      
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
      
      console.log(`📤 Sending friends list to ${username}:`, friendsList);
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
      
      // Notify both users to join the game
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

  // Game-related event handlers
  socket.on('playerUpdate', (data) => {
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

    for (const [username, sockets] of onlineUsers.entries()) {
      if (sockets.has(socket.id)) {
        sockets.delete(socket.id);
        console.log(`Removed socket ${socket.id} from ${username}`);

        if (sockets.size === 0) {
          onlineUsers.delete(username);
          console.log(`${username} is now offline`);
        }
        break;
      }
    }

    const onlineUsersList = Array.from(onlineUsers.keys());
    console.log(`Online users after disconnect:`, onlineUsersList);
    io.emit("online-users", onlineUsersList);
  });
});

// CORS middleware
app.use((req, res, next) => {
  const allowedOrigins = isProduction
    ? [process.env.FRONTEND_URL || "http://localhost:3000"]
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
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false, limit: "10mb" }));

if (isDevelopment) {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });
}

// Performance logging
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse && isDevelopment) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 80) logLine = logLine.slice(0, 79) + "…";
      log(logLine);
    }
  });

  next();
});

// Health check
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
  });
});

(async () => {
  // Register routes and WebSocket server FIRST, before any other middleware
  const server = await registerRoutes(app);
  
  log('🔌 WebSocket server registered before other middleware');

  // Error handling
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    if (isProduction) console.error("Production error:", err);

    res.status(status).json({
      message: isProduction ? "Internal Server Error" : message,
      ...(isDevelopment && { stack: err.stack }),
    });

    if (isDevelopment) throw err;
  });

  if (isDevelopment) {
    // Setup Vite middleware AFTER WebSocket server is registered
    log('🔧 Setting up Vite middleware with WebSocket bypass');
    await setupVite(app, server);
  } else {
    const clientDistPath = path.join(__dirname, "../client/dist");
    app.use(express.static(clientDistPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(clientDistPath, "index.html"));
    });
    log(`📦 Serving static files from: ${clientDistPath}`);
  }

  const port = parseInt(process.env.PORT || "3000", 10);
  const host = isProduction ? "0.0.0.0" : "localhost";

  httpServer.listen(port, host, () => {
    log(`🚀 Server running in ${isProduction ? "PRODUCTION" : "DEVELOPMENT"} mode`);
    log(`🌐 Server listening on ${host}:${port}`);
    log(`🔗 Environment: ${process.env.NODE_ENV || "development"}`);
    if (isProduction) {
      log(`📊 Health check available at: http://localhost:${port}/health`);
    }
  });
})();
