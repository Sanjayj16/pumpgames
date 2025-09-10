import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
// Removed database dependencies for simple auth
import { registerUser, loginUser } from "./simple-auth";

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);



  // Simple Auth routes
  app.post("/api/auth/register", (req, res) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ message: "Username and password required" });
      }

      const result = registerUser(username, password);
      
      if (result.success) {
        res.json({ 
          user: result.user,
          message: result.message 
        });
      } else {
        res.status(400).json({ message: result.message });
      }
    } catch (error) {
      console.error('Registration error:', error);
      res.status(400).json({ message: "Registration failed" });
    }
  });

  app.post("/api/auth/login", (req, res) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ message: "Username and password required" });
      }

      const result = loginUser(username, password);
      
      if (result.success) {
        res.json({ 
          user: result.user,
          message: result.message 
        });
      } else {
        res.status(401).json({ message: result.message });
      }
    } catch (error) {
      console.error('Login error:', error);
      res.status(401).json({ message: "Login failed" });
    }
  });

  // Simple logout
  app.post("/api/auth/logout", (req, res) => {
    res.json({ message: "Logged out successfully" });
  });

  // User routes
  app.get("/api/users/:id", async (req, res) => {
    const user = await storage.getUser(req.params.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json({ ...user, password: undefined });
  });

  app.post("/api/users/:id/update-balance", async (req, res) => {
    try {
      const { amount } = z.object({ amount: z.number() }).parse(req.body);
      const user = await storage.updateUserBalance(req.params.id, amount);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      res.json({ ...user, password: undefined });
    } catch (error) {
      res.status(400).json({ message: "Invalid amount" });
    }
  });



  // Game routes
  app.get("/api/games/active", async (req, res) => {
    const games = await storage.getActiveGames();
    res.json(games);
  });

  app.post("/api/games/create", async (req, res) => {
    try {
      const gameData = insertGameSchema.parse(req.body);
      const game = await storage.createGame(gameData);
      res.json(game);
    } catch (error) {
      res.status(400).json({ message: "Invalid game data" });
    }
  });

  app.post("/api/games/:gameId/join", async (req, res) => {
    try {
      const { userId } = z.object({ userId: z.string() }).parse(req.body);
      const game = await storage.getGame(req.params.gameId);
      
      if (!game) {
        return res.status(404).json({ message: "Game not found" });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      const betAmount = parseFloat(game.betAmount);
      const userBalance = parseFloat(user.balance);

      // For testing - give unlimited balance
      if (userBalance < betAmount) {
        // Auto-add funds for testing instead of rejecting
        await storage.updateUserBalance(userId, betAmount * 10);
      }

      // Deduct bet amount
      await storage.updateUserBalance(userId, -betAmount);
      
      // Join game
      const participant = await storage.joinGame(game.id, userId);
      
      // Update game player count
      const participants = await storage.getGameParticipants(game.id);
      await storage.updateGame(game.id, { playersCount: participants.length });

      res.json(participant);
    } catch (error) {
      res.status(400).json({ message: "Failed to join game" });
    }
  });



  // Daily crate route
  app.post("/api/users/:id/claim-daily-crate", async (req, res) => {
    const lastCrate = await storage.getLastDailyCrate(req.params.id);
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    if (lastCrate && lastCrate.claimedAt > yesterday) {
      return res.status(400).json({ message: "Daily crate already claimed today" });
    }

    const reward = Math.random() * 5 + 0.5; // Random reward between $0.50 and $5.50
    const crate = await storage.claimDailyCrate(req.params.id, reward);
    await storage.updateUserBalance(req.params.id, reward);

    res.json(crate);
  });

  // WebSocket handling now managed by NewGameServer

  // Simple health check for multiplayer
  app.get("/api/multiplayer/status", (req, res) => {
    res.json({ 
      status: 'active',
      timestamp: Date.now()
    });
  });

  // Room management system with regional support
  interface GameRoom {
    id: number;
    region: string;
    players: Map<string, any>;
    bots: any[];
    maxPlayers: number;
    initialized: boolean;
    lastActivity: number;
  }

  const gameRooms = new Map<string, GameRoom>(); // Key format: "region:roomId"
  const playerToRoom = new Map<string, string>(); // Maps playerId to "region:roomId"

  // Initialize room with region support
  function createRoom(region: string, roomId: number): GameRoom {
    const room: GameRoom = {
      id: roomId,
      region: region,
      players: new Map(),
      bots: [],
      maxPlayers: 8,
      initialized: true,
      lastActivity: Date.now()
    };
    const roomKey = `${region}:${roomId}`;
    gameRooms.set(roomKey, room);
    console.log(`Created room ${region}/${roomId}`);
    return room;
  }

  // Find best available room in specified region (sequential filling - only create higher rooms when lower ones are full)
  function findBestRoom(region: string = 'us'): GameRoom {
    // Get rooms for this region only, sorted by room ID
    const regionRooms = Array.from(gameRooms.entries())
      .filter(([key, room]) => room.region === region)
      .sort((a, b) => a[1].id - b[1].id); // Sort by room ID
    
    // Always try to fill the lowest numbered room first
    for (const [roomKey, room] of regionRooms) {
      if (room.players.size < room.maxPlayers) {
        console.log(`Found available space in room ${region}/${room.id} (${room.players.size}/${room.maxPlayers})`);
        return room;
      }
    }
    
    // Only create a new room if ALL existing rooms are completely full
    const newRoomId = regionRooms.length + 1;
    console.log(`All ${region} rooms (${regionRooms.length}) are full, creating new room ${region}/${newRoomId}`);
    return createRoom(region, newRoomId);
  }

  // API endpoint to get best available room with region support
  app.get("/api/room/join", (req, res) => {
    const region = (req.query.region as string) || 'us';
    
    // Validate region
    if (region !== 'us' && region !== 'eu') {
      return res.status(400).json({ error: 'Invalid region. Must be "us" or "eu"' });
    }
    
    const room = findBestRoom(region);
    res.json({ 
      roomId: room.id,
      region: room.region,
      currentPlayers: room.players.size,
      maxPlayers: room.maxPlayers
    });
  });

  // WebSocket server for multiplayer on /ws path
  const wss = new WebSocketServer({ 
    server: httpServer,
    path: '/ws'
  });

  // Create initial rooms for both regions if none exist
  if (gameRooms.size === 0) {
    createRoom('us', 1);
    createRoom('eu', 1);
  }

  wss.on("connection", function connection(ws: any, req: any) {
    const playerId = `player_${Date.now()}_${Math.random()}`;
    console.log(`Player ${playerId} attempting to join. Total WebSocket connections: ${wss.clients.size}`);
    
    // Extract room ID and region from query parameters
    const url = new URL(req.url, `http://${req.headers.host}`);
    const requestedRoomId = parseInt(url.searchParams.get('room') || '1');
    const requestedRegion = url.searchParams.get('region') || 'us';
    
    // Validate region
    if (requestedRegion !== 'us' && requestedRegion !== 'eu') {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid region'
      }));
      ws.close();
      return;
    }
    
    // Always find the best available room (ignore requested room ID for sequential filling)
    let targetRoom = findBestRoom(requestedRegion);
    
    // Check if room is full
    if (targetRoom.players.size >= targetRoom.maxPlayers) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Room is full'
      }));
      ws.close();
      return;
    }
    
    (ws as any).playerId = playerId;
    (ws as any).roomId = targetRoom.id;
    (ws as any).region = targetRoom.region;
    const finalRoomKey = `${targetRoom.region}:${targetRoom.id}`;
    playerToRoom.set(playerId, finalRoomKey);
    
    console.log(`Player ${playerId} joined room ${targetRoom.region}/${targetRoom.id}. Room players: ${targetRoom.players.size + 1}/${targetRoom.maxPlayers}`);
    console.log(`WebSocket readyState: ${ws.readyState}`);
    
    // Assign different colors to different players
    const colors = ['#d55400', '#4ecdc4', '#ff6b6b', '#45b7d1', '#96ceb4', '#feca57', '#ff9ff3', '#54a0ff'];
    const playerColor = colors[targetRoom.players.size % colors.length];
    
    const player = {
      id: playerId,
      segments: [],
      color: playerColor,
      money: 1.00,
      lastUpdate: Date.now(),
      roomId: targetRoom.id
    };
    
    // Add player to room
    targetRoom.players.set(playerId, player);
    targetRoom.lastActivity = Date.now();

    // Send welcome message with player ID, room, and region info
    ws.send(JSON.stringify({
      type: 'welcome',
      playerId: playerId,
      roomId: targetRoom.id,
      region: targetRoom.region,
      currentPlayers: targetRoom.players.size,
      maxPlayers: targetRoom.maxPlayers
    }));
    
    // Send current players to new player
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: 'players',
        players: Array.from(targetRoom.players.values())
      }));
      
      // Send shared game world state including all players in this room
      ws.send(JSON.stringify({
        type: 'gameWorld',
        bots: targetRoom.bots,
        players: Array.from(targetRoom.players.values())
      }));
    }, 100);

    ws.on("message", function incoming(message: any) {
      try {
        const data = JSON.parse(message.toString());
        if (data.type === 'update') {
          // Get player's room
          const roomKey = playerToRoom.get(playerId);
          const room = gameRooms.get(roomKey!);
          if (!room) return;
          
          // Update player data in room
          const existingPlayer = room.players.get(playerId);
          // Enforce 100-segment and 100-mass limits on server side
          const MAX_SEGMENTS = 100;
          const MAX_MASS = 100;
          const segments = data.segments || [];
          // Send ALL segments up to the limit - don't truncate visible segments
          const limitedSegments = segments.length > MAX_SEGMENTS ? segments.slice(0, MAX_SEGMENTS) : segments;
          const limitedMass = Math.min(data.totalMass || 6, MAX_MASS); // Cap mass at 100
          
          const updatedPlayer = {
            id: playerId,
            segments: limitedSegments,
            color: existingPlayer?.color || '#d55400',
            money: data.money || 1.00,
            totalMass: limitedMass, // Cap mass at 100
            segmentRadius: data.segmentRadius || 8,
            visibleSegmentCount: Math.min(data.visibleSegmentCount || 0, MAX_SEGMENTS),
            lastUpdate: Date.now(),
            roomId: room.id
          };
          // Reduce server logging frequency for performance at 30 FPS
          if (Math.random() < 0.01) { // Only log 1% of updates for better performance
            console.log(`Room ${room.region}/${room.id}: Server received update from ${playerId}: ${limitedSegments.length} segments (was ${segments.length}), mass: ${limitedMass.toFixed(1)} (was ${data.totalMass?.toFixed(1)}), radius: ${data.segmentRadius?.toFixed(1) || 'unknown'}`);
          }
          
          // Check for collisions with other players BEFORE updating position
          const currentPlayerHead = data.segments && data.segments.length > 0 ? data.segments[0] : null;
          if (currentPlayerHead && data.segmentRadius) {
            let collisionDetected = false;
            
            // Check collision with all other players in same room
            for (const [otherPlayerId, otherPlayer] of Array.from(room.players)) {
              if (otherPlayerId === playerId) continue; // Skip self
              if (!otherPlayer.segments || otherPlayer.segments.length === 0) continue;
              
              // Check collision with all segments of other player
              for (const segment of otherPlayer.segments) {
                const dist = Math.sqrt(
                  (currentPlayerHead.x - segment.x) ** 2 + 
                  (currentPlayerHead.y - segment.y) ** 2
                );
                const collisionRadius = data.segmentRadius + (otherPlayer.segmentRadius || 10);
                
                if (dist < collisionRadius) {
                  console.log(`💀 SERVER Room ${room.region}/${room.id}: Player ${playerId} crashed into ${otherPlayerId}!`);
                  collisionDetected = true;
                  
                  // Get crashed player data for money crate calculation
                  const crashedPlayer = room.players.get(playerId);
                  const crashedPlayerMoney = crashedPlayer?.money || 1.0;
                  const crashedPlayerMass = crashedPlayer?.totalMass || 6;
                  
                  // Create money crates (1 crate per mass unit) at player's death location
                  const numCrates = Math.floor(crashedPlayerMass) || 1; // At least 1 crate
                  const moneyPerCrate = crashedPlayerMoney / numCrates;
                  
                  console.log(`💰 SERVER: Creating ${numCrates} money crates worth $${moneyPerCrate.toFixed(2)} each at death location`);
                  
                  // Drop money crates in a spread pattern around death location
                  for (let i = 0; i < numCrates; i++) {
                    const angle = (i / numCrates) * Math.PI * 2;
                    const spreadRadius = 20 + (i * 8); // Spread crates in expanding circle
                    const crateX = currentPlayerHead.x + Math.cos(angle) * spreadRadius;
                    const crateY = currentPlayerHead.y + Math.sin(angle) * spreadRadius;
                    
                    const moneyCrate = {
                      id: `money_crate_${Date.now()}_${i}`,
                      x: crateX,
                      y: crateY,
                      radius: 6,
                      mass: 0,
                      color: '#ffd700',
                      vx: 0,
                      vy: 0,
                      wobbleOffset: Math.random() * Math.PI * 2,
                      isMoneyCrate: true,
                      moneyValue: parseFloat(moneyPerCrate.toFixed(2))
                    };
                    
                    // Broadcast money crate to all players in the room
                    const crateMessage = JSON.stringify({
                      type: 'moneyCrate',
                      playerId: playerId,
                      crate: moneyCrate
                    });
                    
                    let broadcastCount = 0;
                    room.players.forEach((player, id) => {
                      wss.clients.forEach(client => {
                        if ((client as any).playerId === id && client.readyState === WebSocket.OPEN) {
                          client.send(crateMessage);
                          broadcastCount++;
                        }
                      });
                    });
                    
                    console.log(`💰 Player ${playerId} dropped money crate in room ${room.region}/${room.id}: ${JSON.stringify(moneyCrate)}`);
                  }
                  
                  // Remove crashed player from room
                  room.players.delete(playerId);
                  playerToRoom.delete(playerId);
                  
                  // Send death notification to crashed player
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                      type: 'death',
                      reason: 'collision',
                      crashedInto: otherPlayerId
                    }));
                  }
                  
                  console.log(`💀 Player ${playerId} removed from room ${room.region}/${room.id}`);
                  break;
                }
              }
              if (collisionDetected) break;
            }
            
            // Only update player if no collision detected
            if (!collisionDetected) {
              room.players.set(playerId, updatedPlayer);
              room.lastActivity = Date.now();
            }
          } else {
            // No collision check needed if no head position
            room.players.set(playerId, updatedPlayer);
            room.lastActivity = Date.now();
          }
        } else if (data.type === 'boostFood') {
          // Handle boost food drops - broadcast to all players in room
          const roomKey = playerToRoom.get(playerId);
          const room = gameRooms.get(roomKey!);
          if (!room) return;
          
          console.log(`🍕 Player ${playerId} dropped boost food in room ${room.region}/${room.id}:`, data.food);
          
          // Broadcast boost food to all other players in room
          const boostFoodMessage = JSON.stringify({
            type: 'boostFood',
            food: data.food,
            playerId: playerId
          });
          
          let broadcastCount = 0;
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && 
                client.roomId === room.id && 
                client.region === room.region &&
                client.playerId !== playerId) { // Don't send back to the sender
              try {
                client.send(boostFoodMessage);
                broadcastCount++;
              } catch (error) {
                console.error(`Error broadcasting boost food to room ${room.region}/${room.id}:`, error);
              }
            }
          });
          
          console.log(`🍕 Boost food broadcast to ${broadcastCount} players in room ${room.region}/${room.id}`);
        } else if (data.type === 'moneyCrate') {
          // Handle money crate drops - broadcast to all players in room
          const roomKey = playerToRoom.get(playerId);
          const room = gameRooms.get(roomKey!);
          if (!room) return;
          
          console.log(`💰 Player ${playerId} dropped money crate in room ${room.region}/${room.id}:`, data.crate);
          
          // Broadcast money crate to all other players in room
          const moneyCrateMessage = JSON.stringify({
            type: 'moneyCrate',
            crate: data.crate,
            playerId: playerId
          });
          
          let broadcastCount = 0;
          wss.clients.forEach((client: any) => {
            if (client.readyState === WebSocket.OPEN && 
                client.roomId === room.id && 
                client.region === room.region &&
                client.playerId !== playerId) { // Don't send back to the sender
              try {
                client.send(moneyCrateMessage);
                broadcastCount++;
              } catch (error) {
                console.error(`Error broadcasting money crate to room ${room.region}/${room.id}:`, error);
              }
            }
          });
          
          console.log(`💰 Money crate broadcast to ${broadcastCount} players in room ${room.region}/${room.id}`);
        } else if (data.type === 'moneyCrateCollected') {
          // Handle money crate collection - broadcast removal to all players
          const roomKey = playerToRoom.get(playerId);
          const room = gameRooms.get(roomKey!);
          if (!room) return;
          
          console.log(`💰 Player ${playerId} collected money crate ${data.crateId} in room ${room.region}/${room.id}`);
          
          // Broadcast crate removal to all players in room
          const crateRemovalMessage = JSON.stringify({
            type: 'moneyCrateRemoved',
            crateId: data.crateId,
            collectedBy: playerId
          });
          
          let broadcastCount = 0;
          wss.clients.forEach((client: any) => {
            if (client.readyState === WebSocket.OPEN && 
                client.roomId === room.id && 
                client.region === room.region) {
              try {
                client.send(crateRemovalMessage);
                broadcastCount++;
              } catch (error) {
                console.error(`Error broadcasting crate removal to room ${room.region}/${room.id}:`, error);
              }
            }
          });
          
          console.log(`💰 Money crate removal broadcast to ${broadcastCount} players in room ${room.region}/${room.id}`);
        } // Food system completely removed from multiplayer
      } catch (error) {
        console.error("WebSocket message error:", error);
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      const roomKey = playerToRoom.get(playerId);
      const room = gameRooms.get(roomKey!);
      console.log(`Player ${playerId} left room ${roomKey}. Code: ${code}, Reason: ${reason.toString()}`);
      
      if (room) {
        room.players.delete(playerId);
        console.log(`Room ${room.region}/${room.id} now has ${room.players.size}/${room.maxPlayers} players`);
      }
      playerToRoom.delete(playerId);
    });

    ws.on("error", (error: any) => {
      const roomKey = playerToRoom.get(playerId);
      const room = gameRooms.get(roomKey!);
      console.error(`WebSocket error for player ${playerId} in room ${roomKey}:`, error);
      
      if (room) {
        room.players.delete(playerId);
      }
      playerToRoom.delete(playerId);
    });
  });

  // Broadcast game state every 33ms for smooth 30 FPS multiplayer
  setInterval(() => {
    if (wss.clients.size > 0) {
      // Broadcast to each room separately
      for (const [roomKey, room] of gameRooms) {
        if (room.players.size === 0) continue;
        
        // Only send essential player data to reduce bandwidth
        const playersData = Array.from(room.players.values()).map(player => ({
          id: player.id,
          segments: player.segments,
          color: player.color,
          totalMass: player.totalMass,
          segmentRadius: player.segmentRadius,
          visibleSegmentCount: player.visibleSegmentCount,
          money: player.money,
          roomId: player.roomId
        }));
        
        const worldMessage = JSON.stringify({
          type: 'gameWorld',
          bots: room.bots,
          players: playersData,
          roomId: room.id,
          region: room.region
        });
        
        // Find clients in this room and broadcast to them
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && 
              (client as any).roomId === room.id && 
              (client as any).region === room.region) {
            try {
              client.send(worldMessage);
            } catch (error) {
              console.error(`Broadcast error to room ${room.region}/${room.id}:`, error);
              client.terminate();
            }
          }
        });
      }
    }
  }, 33); // Optimized 30 FPS server broadcasts for smooth performance

  return httpServer;
}