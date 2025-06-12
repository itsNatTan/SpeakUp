export abstract class BaseClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaseClientError';
  }

  abstract statusCode: number;
}
