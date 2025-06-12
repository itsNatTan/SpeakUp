import { serve } from '@hono/node-server';
import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { registerRoutes } from './controllers';
import { combineErrorHandlers } from './internal/errorHandlers';
import {
  handleClientErrors,
  handlePathNotFoundErrors,
} from './internal/errorHandlers/handlers';
import { registerWebsocketForServer } from './ws/server';

const app = new Hono();
app.use(cors());
app.notFound(handlePathNotFoundErrors);
app.onError(combineErrorHandlers([handleClientErrors]));

app.get('/', (c) => {
  return c.text('Hello from server!');
});
registerRoutes(app);

const HOST = process.env.SERVER_HOST || 'localhost';
const PORT = process.env.SERVER_PORT || 8000;
const serverOptions = {
  fetch: app.fetch,
  // Safe to cast, incorrect downstream type definition
  port: PORT as number,
  hostname: HOST,
};

const server = serve(serverOptions, ({ address, port }) => {
  console.log(`Server running on ${address}:${port}`);
});

// Safe to cast, incompatible type definitions
registerWebsocketForServer(server as any);
