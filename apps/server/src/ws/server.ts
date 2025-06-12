import { Server } from 'http';
import { WebSocketServer } from 'ws';
import roomService from '../services/room.service';

// Three uppercase letters followed by three numbers
const ROOM_PATH_REGEX = /^[A-Z]{3}\d{3}$/;

export const registerWebsocketForServer = (server: Server) => {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    console.log(`Client connected to ${req.url}`);

    // Remove leading slash
    const roomCode = req.url?.slice(1);

    if (!roomCode || !ROOM_PATH_REGEX.test(roomCode)) {
      console.log('Invalid room code');
      ws.send('Invalid room code');
      ws.close();
      return;
    }

    const wsHandler = roomService.getWsHandler(roomCode);
    if (!wsHandler) {
      console.log('Room not found');
      ws.send('Room not found');
      ws.close();
      return;
    }

    ws.on('message', (data) => {
      const handler = wsHandler.getMessageHandler(data).bind(wsHandler);
      handler(ws, data);
    });

    ws.on('close', () => {
      console.log('Client disconnected');
      wsHandler.handleSTOP(ws);
    });

    // Send welcome message
    ws.send('Hello from server!');
  });

  return wss;
};
