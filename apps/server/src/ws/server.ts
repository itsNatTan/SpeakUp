import { Server as HttpServer } from 'http';
import { Server as HttpsServer } from 'https';
import { WebSocketServer } from 'ws';
import roomService from '../services/room.service';

const ROOM_PATH_REGEX = /^[A-Z]{3}\d{3}$/;
const HEARTBEAT_INTERVAL_MS = 30_000;

export const registerWebsocketForServer = (server: HttpServer | HttpsServer) => {
  const wss = new WebSocketServer({ server });

  // Server-side heartbeat: ping every 30s, terminate unresponsive connections
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if ((ws as any).isAlive === false) {
        console.log('[WS] Terminating unresponsive connection');
        ws.terminate();
        return;
      }
      (ws as any).isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  wss.on('connection', (ws, req) => {
    const roomCode = req.url?.slice(1);
    console.log(`Client connected to ${req.url}`);

    (ws as any).isAlive = true;
    ws.on('pong', () => { (ws as any).isAlive = true; });

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
      (ws as any).isAlive = true;
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

