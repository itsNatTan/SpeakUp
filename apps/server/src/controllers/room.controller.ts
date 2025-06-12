import { Hono } from 'hono';
import { NotFoundError, UnprocessableEntityError } from '../internal/errors';
import roomService from '../services/room.service';
import server from '../utils/server';

const r = new Hono().basePath('/api/v1/rooms');

r.post('/', async (c) => {
  const { enableCloudRecording } = await server.parseJsonBody(c);
  if (typeof enableCloudRecording !== 'boolean') {
    throw new UnprocessableEntityError(
      '`enableCloudRecording` must be a boolean',
    );
  }
  const room = roomService.create(enableCloudRecording);
  return c.json(room, 201);
});
r.post('/:code/join', (c) => {
  const roomCode = c.req.param('code');
  const room = roomService.find(roomCode);
  if (!room) {
    throw new NotFoundError('Room', roomCode);
  }
  return c.json(room);
});
r.get('/:code/ttl', (c) => {
  const roomCode = c.req.param('code');
  const ttl = roomService.getTtl(roomCode);
  return c.json({ code: roomCode, ttl });
});
r.get('/:code/cooldown', (c) => {
  const roomCode = c.req.param('code');
  const cooldown = roomService.getCooldown(roomCode);
  return c.json({ code: roomCode, cooldown });
});

export default r;
