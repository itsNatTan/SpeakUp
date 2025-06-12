import { Context } from 'hono';
import { BadRequestError } from '../internal/errors';

const parseJsonBody = async (c: Context) => {
  const body = await c.req.text();
  if (!body) {
    throw new BadRequestError('Body must not be empty');
  }
  try {
    const json = await c.req.json();
    if (typeof json !== 'object') {
      throw new BadRequestError('Body must be a valid JSON');
    }
    return json;
  } catch (error) {
    throw new BadRequestError('Body must be a valid JSON');
  }
};

export default {
  parseJsonBody,
};
