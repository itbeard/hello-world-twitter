import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const allowedMessage = 'Hello World';

function publicXError(error) {
  switch (error?.code) {
    case 401:
      return { status: 401, message: 'X rejected the credentials.' };
    case 403:
      return { status: 403, message: 'X refused the post. Check write access or duplicate-content rules.' };
    case 429:
      return { status: 429, message: 'The X API rate limit has been reached. Try again later.' };
    default:
      return { status: 502, message: 'The X API could not create the post.' };
  }
}

export function createApp({ publisher = null, logger = console } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1kb' }));
  app.use(express.static(publicDirectory));

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.get('/api/status', (_request, response) => {
    response.json({ configured: publisher !== null });
  });

  app.post('/api/posts', async (request, response) => {
    if (request.body?.message !== allowedMessage) {
      return response.status(400).json({ error: `Message must be exactly “${allowedMessage}”.` });
    }

    if (!publisher) {
      return response.status(503).json({ error: 'X credentials are not configured.' });
    }

    try {
      const post = await publisher.publish(allowedMessage);
      return response.status(201).json({ post });
    } catch (error) {
      logger.error('X API post failed', error);
      const publicError = publicXError(error);
      return response.status(publicError.status).json({ error: publicError.message });
    }
  });

  return app;
}