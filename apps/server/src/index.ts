import fs from 'node:fs';
import https from 'node:https';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Readable } from 'stream';
import 'dotenv/config';

import { registerRoutes } from './controllers';
import { combineErrorHandlers } from './internal/errorHandlers';
import {
  handleClientErrors,
  handlePathNotFoundErrors,
} from './internal/errorHandlers/handlers';
import { registerWebsocketForServer } from './ws/server';

const app = new Hono();

app.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['Content-Type'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
  })
);
app.notFound(handlePathNotFoundErrors);
app.onError(combineErrorHandlers([handleClientErrors]));
app.get('/', (c) => c.text('Hello from secure server!'));
registerRoutes(app);

// HTTPS options
const key = fs.readFileSync('./key.pem');
const cert = fs.readFileSync('./cert.pem');

const server = https.createServer({ key, cert }, async (req, res) => {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req);
  const request = new Request(`https://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: req.headers as any,
    body,
    duplex: 'half',
  });

  const response = await app.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body) Readable.fromWeb(response.body as any).pipe(res);
  else res.end();
});

registerWebsocketForServer(server);

const PORT = parseInt(process.env.SERVER_PORT || '8443', 10);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🔐 HTTPS + WS server running at https://0.0.0.0:${PORT}`);
});

