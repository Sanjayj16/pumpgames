// Standalone WebSocket server for the game
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

const server = createServer();
const wss = new WebSocketServer({ 
  server, 
  path: '/ws' 
});

console.log('🎮 Game WebSocket Server');
console.log('========================');

// Game rooms and players (simplified version)
const gameRooms = new Map();
const playerToRoom = new Map();

function createRoom(region, id, gameMode = 'normal') {
  const roomKey = `${region}:${id}`;
  const room = {
    id,
    region,
    gameMode,
    players: new Map(),
    gameState: {
      players: new Map(),
      bots: new Map()
    },
    maxPlayers: 80,
    lastUpdate: Date.now()
  };
  
  gameRooms.set(roomKey, room);
  console.log(`🏠 Created room ${roomKey} with mode: ${gameMode}`);
  return room;
}

function findBestRoom(region, gameMode = 'normal') {
  for (const [key, room] of gameRooms.entries()) {
    if (room.region === region && room.gameMode === gameMode && room.players.size < room.maxPlayers) {
      return room;
    }
  }
  
  // Create new room if none available
  const newRoomId = gameRooms.size + 1;
  return createRoom(region, newRoomId, gameMode);
}

// Create initial rooms
createRoom('us', 1, 'normal');
createRoom('eu', 1, 'normal');

wss.on('connection', (ws, req) => {
  const playerId = `player_${Date.now()}_${Math.random()}`;
  console.log(`🔌 New WebSocket connection established. Player: ${playerId}, Total connections: ${wss.clients.size}`);
  console.log(`🔌 Connection from: ${req.headers.origin || 'unknown origin'}`);
  console.log(`🔌 Request URL: ${req.url}`);
  
  // Extract room ID, region, and mode from query parameters 
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch (error) {
    console.error(`❌ Invalid WebSocket URL: ${req.url}`, error);
    ws.close(1002, 'Invalid URL');
    return;
  }
  
  const requestedRoomId = parseInt(url.searchParams.get('room') || '1');
  const requestedRegion = url.searchParams.get('region') || 'us';
  const gameMode = url.searchParams.get('mode') || 'normal';
  
  console.log(`🎮 Player ${playerId} connecting - Mode: ${gameMode}, Region: ${requestedRegion}, Room: ${requestedRoomId}`);
  
  // Find or create room
  let targetRoom = findBestRoom(requestedRegion, gameMode);
  const finalRoomKey = `${targetRoom.region}:${targetRoom.id}`;
  
  // Check if room is full
  if (targetRoom.players.size >= targetRoom.maxPlayers) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Room is full'
    }));
    ws.close();
    return;
  }
  
  // Assign player to room
  playerToRoom.set(playerId, finalRoomKey);
  
  const player = {
    id: playerId,
    segments: [],
    color: '#7ED321',
    money: 1.00,
    lastUpdate: Date.now(),
    roomId: targetRoom.id,
    ws: ws
  };
  
  // Add player to room
  targetRoom.players.set(playerId, player);
  targetRoom.gameState.players.set(playerId, player);
  
  console.log(`Player ${playerId} joined room ${finalRoomKey}. Room players: ${targetRoom.players.size}/${targetRoom.maxPlayers}`);
  
  // Send welcome message
  ws.send(JSON.stringify({
    type: 'welcome',
    playerId: playerId,
    roomId: targetRoom.id,
    region: targetRoom.region
  }));
  
  // Handle messages
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log(`📨 Received from ${playerId}:`, message.type);
      
      if (message.type === 'ping') {
        // Respond to ping with pong
        ws.send(JSON.stringify({
          type: 'pong',
          timestamp: message.timestamp,
          serverTime: Date.now()
        }));
        return;
      } else if (message.type === 'update') {
        // Update player position and data
        const player = targetRoom.players.get(playerId);
        if (player) {
          player.segments = message.segments || [];
          player.color = message.color || player.color;
          player.money = message.money || player.money;
          player.totalMass = message.totalMass || player.totalMass;
          player.segmentRadius = message.segmentRadius || player.segmentRadius;
          player.visibleSegmentCount = message.visibleSegmentCount || player.segments.length;
          player.lastUpdate = Date.now();
          
          // Update game state
          const gameStatePlayer = targetRoom.gameState.players.get(playerId);
          if (gameStatePlayer) {
            Object.assign(gameStatePlayer, player);
          }
        }
      }
    } catch (error) {
      console.error('❌ Error processing message:', error);
    }
  });
  
  // Handle disconnect
  ws.on('close', (code, reason) => {
    const reasonStr = reason ? reason.toString() : 'No reason provided';
    console.log(`❌ Player ${playerId} left room ${finalRoomKey}. Code: ${code}, Reason: ${reasonStr}`);
    
    // Remove player from room
    if (targetRoom.players.has(playerId)) {
      targetRoom.players.delete(playerId);
      targetRoom.gameState.players.delete(playerId);
    }
    
    playerToRoom.delete(playerId);
    console.log(`🏠 Room ${finalRoomKey} now has ${targetRoom.players.size}/${targetRoom.maxPlayers} players`);
  });
  
  // Handle errors
  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for player ${playerId} in room ${finalRoomKey}:`, error);
    
    // Clean up on error
    if (targetRoom.players.has(playerId)) {
      targetRoom.players.delete(playerId);
      targetRoom.gameState.players.delete(playerId);
    }
    playerToRoom.delete(playerId);
  });
});

// Send game state updates
setInterval(() => {
  gameRooms.forEach((room, roomKey) => {
    const players = Array.from(room.gameState.players.values());
    
    // Send updates to all players in the room
    room.players.forEach((player, playerId) => {
      if (player.ws && player.ws.readyState === 1) { // WebSocket.OPEN
        try {
          player.ws.send(JSON.stringify({
            type: 'players',
            players: players
          }));
        } catch (error) {
          console.error(`❌ Error sending game state to player ${playerId}:`, error);
        }
      }
    });
  });
}, 50); // 20 FPS

// DISABLED: This standalone server is no longer needed
// The main server (index.ts/production.ts) now handles both Socket.io and WebSocket
// server.listen(3002, () => {
//   console.log('🚀 Game WebSocket server running on port 3002');
//   console.log('🔌 WebSocket available at: ws://localhost:3002/ws');
//   console.log('🎮 Ready for game connections!');
// });
