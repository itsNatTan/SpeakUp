import { NotFoundHandler } from 'hono';
import { BaseClientError } from '../errors';
import { buildErrorResponse } from './helpers';
import { ApplicationErrorHandler } from './types';

export const handleClientErrors: ApplicationErrorHandler = (err, c) => {
  if (err instanceof BaseClientError) {
    return buildErrorResponse(c, err.message, err.statusCode);
  }
};

export const handlePathNotFoundErrors: NotFoundHandler = (c) => {
  const errMessage = `Path: ${c.req.path} not found`;
  return buildErrorResponse(c, errMessage, 404);
};
