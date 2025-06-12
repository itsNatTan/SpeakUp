import { BaseClientError } from './base';

export class NotFoundError extends BaseClientError {
  constructor(entityName: string, entityId?: string) {
    const prefix = entityId ? `${entityName} with id ${entityId}` : entityName;
    super(`${prefix} not found`);
    this.name = 'NotFoundError';
  }
  statusCode = 404;
}
