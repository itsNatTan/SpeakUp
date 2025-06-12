import { Hono } from 'hono';
import storageService from '../services/storage.service';

const r = new Hono().basePath('/api/v1/storage');

r.get('/:roomCode/download', (c) => {
  const roomCode = c.req.param('roomCode');
  const zipFile = storageService.zipAll(roomCode);
  c.header('Content-Disposition', `attachment; filename="${roomCode}.zip"`);
  c.header('Content-Type', 'application/zip');
  return c.body(zipFile, 200);
});

export default r;
