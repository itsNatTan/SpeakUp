import { BaseClientError } from './base';

export class UnprocessableEntityError extends BaseClientError {
  constructor(message?: string) {
    super(message ?? 'Unprocessable entity');
    this.name = 'UnprocessableEntityError';
  }
  statusCode = 422;
}
