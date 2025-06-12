import { Hono } from 'hono';
import roomController from './room.controller';
import storageController from './storage.controller';

const controllers: Hono[] = [
  // Controllers and routers are one and the same
  roomController,
  storageController,
] as const;

export const registerRoutes = (app: Hono) => {
  for (const controller of controllers) {
    app.route('/', controller);
  }
};
