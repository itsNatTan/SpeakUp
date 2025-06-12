import { ErrorHandler } from 'hono';
import { defaultErrorHandler } from './helpers';
import { ApplicationErrorHandler } from './types';

// Overload definitions

export function combineErrorHandlers(
  errorHandlers: ApplicationErrorHandler[],
): ErrorHandler;

export function combineErrorHandlers(
  fn: (defaultErrorHandler: ErrorHandler) => ErrorHandler,
): ErrorHandler;

export function combineErrorHandlers(...args: any[]): ErrorHandler {
  if (typeof args[0] === 'function') {
    return args[0](defaultErrorHandler);
  }

  const errorHandlers = args[0] as ApplicationErrorHandler[];
  return (err, c) => {
    for (const errorHandler of errorHandlers) {
      const response = errorHandler(err, c);
      if (response) {
        return response;
      }
    }
    return defaultErrorHandler(err, c)!;
  };
}
