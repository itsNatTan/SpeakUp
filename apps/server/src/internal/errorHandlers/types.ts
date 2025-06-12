import { ErrorHandler } from 'hono';

export type ApplicationErrorHandler = (
  ...args: Parameters<ErrorHandler>
) => ReturnType<ErrorHandler> | undefined;
