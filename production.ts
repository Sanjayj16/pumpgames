import express, { type Request, Response, NextFunction } from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { registerRoutes } from "./simple-routes";

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

// Map to store online users
const onlineUsers = new Map<string, string>();

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // Join with username
  socket.on("join", (username: string) => {
    if (!username) return;
    onlineUsers.set(username, socket.id);
    io.emit("online-users", Array.from(onlineUsers.keys()));
  });

  // Send friend/game invite (include room and region)
  socket.on("invite", ({ from, to, roomId, region }) => {
    const toSocketId = onlineUsers.get(to);
    if (toSocketId) {
      io.to(toSocketId).emit("game-invite", { from, roomId, region });
    }
  });

  // Accept game invite
  socket.on("accept-invite", ({ from, to, roomId, region }) => {
    const fromSocketId = onlineUsers.get(from);
    if (fromSocketId) {
      io.to(fromSocketId).emit("invite-accepted", { to, roomId, region });
    }
  });

  // Disconnect handling
  socket.on("disconnect", () => {
    onlineUsers.forEach((id, username) => {
      if (id === socket.id) onlineUsers.delete(username);
    });
    io.emit("online-users", Array.from(onlineUsers.keys()));
    console.log("User disconnected:", socket.id);
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
    res.status(status).json({ message: isProduction ? "Internal Server Error" : message });
  });

  const port = parseInt(process.env.PORT || "5174", 10);
  const host = "0.0.0.0";

  httpServer.listen(port, host, () => {
    console.log(`🚀 Server running in ${isProduction ? "PRODUCTION" : "DEVELOPMENT"} mode`);
    console.log(`🌐 Listening on ${host}:${port}`);
    console.log(`📊 Health check: http://localhost:${port}/health`);
  });
})();
