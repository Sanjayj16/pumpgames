import express, { type Request, Response, NextFunction } from "express";
import path from "path";
import { registerRoutes } from "./simple-routes";
import { setupVite, serveStatic as defaultServeStatic, log } from "./vite";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { createServer } from "http";
import { Server } from "socket.io";

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
const friendRequests = new Map<string, Array<{ id: string, from: string, timestamp: string }>>();
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
  socket.on("join", (username: string) => {
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

    // Send any pending friend requests to this user
    const pendingRequests = friendRequests.get(username) || [];
    if (pendingRequests.length > 0) {
      console.log(`Sending ${pendingRequests.length} pending friend requests to ${username}`);
      pendingRequests.forEach(request => {
        socket.emit("friend-request", { id: request.id, username: request.from, timestamp: request.timestamp });
      });
    }

    // Send friends list to user
    const friends = userFriends.get(username) || new Set();
    const friendsList = Array.from(friends).map(friend => ({
      id: friend,
      username: friend,
      isOnline: onlineUsers.has(friend),
      isPlaying: false
    }));
    socket.emit("friends-list", friendsList);
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

  // Listen for invite acceptance
  socket.on("accept-invite", ({ from, to, roomId, region }) => {
    const fromSockets = onlineUsers.get(from);
    if (fromSockets) {
      fromSockets.forEach((socketId) => {
        io.to(socketId).emit("invite-accepted", { to, roomId, region });
      });
    }
  });

  // Handle friend requests with acknowledgment
  socket.on("send-friend-request", ({ from, to }, acknowledgment) => {
    if (!from || !to || from === to) {
      // Only call acknowledgment if it's provided
      if (typeof acknowledgment === 'function') {
        acknowledgment({ success: false, message: "Invalid friend request" });
      }
      return;
    }

    const requestId = `${from}_${to}_${Date.now()}`;
    const timestamp = new Date().toISOString();

    console.log(`Friend request attempt: ${from} -> ${to}`);

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

  // Handle friend request acceptance
  socket.on("accept-friend-request", ({ from, to }) => {
    if (!from || !to) return;

    console.log(`Friend request accepted: ${from} accepted ${to}'s request`);

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
    const fromFriends = Array.from(userFriends.get(from) || new Set<string>()).map((friend: string) => ({
      id: friend,
      username: friend,
      isOnline: onlineUsers.has(friend),
      isPlaying: false
    }));
    notifyUser(from, "friends-list", fromFriends);

    const toFriends = Array.from(userFriends.get(to) || new Set<string>()).map((friend: string) => ({
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

    notifyUser(from, "auto-game-start", { roomId, region, friend: to });
    notifyUser(to, "auto-game-start", { roomId, region, friend: from });
  });

  // Handle friend request decline
  socket.on("decline-friend-request", ({ from, to }) => {
    if (!from || !to) return;

    // Remove from pending requests
    if (friendRequests.has(from)) {
      const requests = friendRequests.get(from)?.filter(req => req.from !== to) || [];
      friendRequests.set(from, requests);
    }

    console.log(`Friend request declined from ${to} to ${from}`);
  });

  // Get user's friends list
  socket.on("get-friends", (username) => {
    const friends = userFriends.get(username) || new Set();
    const friendsList = Array.from(friends).map(friend => ({
      id: friend,
      username: friend,
      isOnline: onlineUsers.has(friend),
      isPlaying: false
    }));

    socket.emit("friends-list", friendsList);
  });

  // Get user's pending friend requests
  socket.on("get-friend-requests", (username) => {
    const requests = friendRequests.get(username) || [];
    socket.emit("friend-requests", requests);
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
        io.to(socketId).emit("auto-game-start", { roomId, region: gameRegion, friend: to });
      });
      toSockets.forEach((socketId) => {
        io.to(socketId).emit("auto-game-start", { roomId, region: gameRegion, friend: from });
      });

      console.log(`Auto-starting game between ${from} and ${to} in room ${roomId}`);
    }
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
    ? [process.env.FRONTEND_URL || "https://harmonious-boba-11ae9e.netlify.app"]
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
  const server = await registerRoutes(app);

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
    await setupVite(app, server);
  } else {
    const clientDistPath = path.join(__dirname, "../client/dist");
    app.use(express.static(clientDistPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(clientDistPath, "index.html"));
    });
    log(`📦 Serving static files from: ${clientDistPath}`);
  }

  const port = parseInt(process.env.PORT || "5174", 10);
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
