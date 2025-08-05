import { Server as HttpServer } from 'http';
import { Server as HttpsServer } from 'https';
import { WebSocketServer } from 'ws';
import roomService from '../services/room.service';

const ROOM_PATH_REGEX = /^[A-Z]{3}\d{3}$/;

export const registerWebsocketForServer = (server: HttpServer | HttpsServer) => {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const roomCode = req.url?.slice(1);
    console.log(`Client connected to ${req.url}`);

    if (!roomCode || !ROOM_PATH_REGEX.test(roomCode)) {
      ws.send('Invalid room code');
      ws.close();
      return;
    }

    const wsHandler = roomService.getWsHandler(roomCode);
    if (!wsHandler) {
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

    ws.send('Hello from WebSocket!');
  });

  return wss;
};

