// index.ts — SpeakUp backend (HTTP behind Nginx on 127.0.0.1:8080)

import http from 'node:http';
import { Readable } from 'node:stream';
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

// --- App setup ---------------------------------------------------------------

const app = new Hono();

// CORS: keep permissive for now; tighten to specific origins when ready
app.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['Content-Type'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
  })
);

// Basic routes
app.get('/', (c) => c.text('Hello from secure server!')); // text can stay the same
app.get('/health', (c) => c.json({ ok: true }));

// Register your API routes and error handlers
registerRoutes(app);
app.notFound(handlePathNotFoundErrors);
app.onError(combineErrorHandlers([handleClientErrors]));

// --- HTTP server (no TLS here; Nginx terminates HTTPS) ----------------------

const server = http.createServer(async (req, res) => {
  try {
    const body =
      req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : Readable.toWeb(req);

    // Internal scheme is http (external https is handled by Nginx)
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers as any,
      body,
      // Node's fetch-compatible streams need duplex for request bodies
      duplex: 'half',
    });

    const response = await app.fetch(request);

    // Relay response
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      Readable.fromWeb(response.body as any).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    // Fallback error handling
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Internal Server Error');
    // eslint-disable-next-line no-console
    console.error(err);
  }
});

// Attach WebSocket handlers (upgrade happens through Nginx with Upgrade headers)
registerWebsocketForServer(server);

// Bind internally; Nginx proxies from 443 -> 127.0.0.1:8080
const PORT = parseInt(process.env.SERVER_PORT || '8080', 10);
const HOST = process.env.SERVER_HOST_BIND || '127.0.0.1';

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`HTTP server on http://${HOST}:${PORT}`);
});
