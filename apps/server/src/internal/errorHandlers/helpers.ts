import { Context } from 'hono';
import { StatusCode } from 'hono/utils/http-status';
import { ApplicationErrorHandler } from './types';

export const defaultErrorHandler: ApplicationErrorHandler = (err, c) => {
  // We avoid leaking potential internal implementation errors
  console.error(err);
  return buildErrorResponse(c, 'Internal Server Error', 500);
};

export const buildErrorResponse = (
  c: Context,
  message: string,
  status: number,
): Response => {
  return c.json(
    { timestamp: new Date().toISOString(), message, status },
    status as StatusCode,
  );
};
