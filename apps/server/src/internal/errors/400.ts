import { BaseClientError } from './base';

export class BadRequestError extends BaseClientError {
  constructor(message?: string) {
    super(message ?? 'Bad request');
    this.name = 'BadRequestError';
  }
  statusCode = 400;
}
