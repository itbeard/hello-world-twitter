import express from 'express';
import multer from 'multer';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStateStore } from './stateStore.js';

const publicDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const maxMessageLength = 280;
const maxVideoSize = 512 * 1024 * 1024;
const allowedVideoTypes = new Set(['video/mp4', 'video/quicktime']);

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

export function createApp({
  publisher = null,
  logger = console,
  store = createMemoryStateStore(),
  uploadDirectory = tmpdir()
} = {}) {
  const app = express();
  const upload = multer({
    dest: uploadDirectory,
    limits: { fileSize: maxVideoSize, files: 1 }
  });
  let publishing = false;
  let publishingReply = false;

  app.disable('x-powered-by');
  app.use(express.json({ limit: '4kb' }));
  app.use(express.static(publicDirectory));

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.get('/api/status', async (_request, response) => {
    try {
      const state = await store.read();
      const account = publisher?.getAccount ? await publisher.getAccount() : null;
      response.json({
        configured: publisher !== null,
        account,
        post: state.post || null,
        reply: state.reply || null
      });
    } catch (error) {
      logger.error('Launchpad status failed', error);
      response.status(502).json({ error: 'Launchpad could not load the X account or saved post.' });
    }
  });

  app.post('/api/posts', async (request, response) => {
    const message = request.body?.message;
    if (typeof message !== 'string' || !message.trim() || [...message].length > maxMessageLength) {
      return response.status(400).json({ error: 'Message must contain between 1 and 280 characters.' });
    }

    if (!publisher) {
      return response.status(503).json({ error: 'X credentials are not configured.' });
    }

    const state = await store.read();
    if (state.post) {
      return response.status(409).json({ error: 'This launch has already been published.', post: state.post });
    }

    if (publishing) {
      return response.status(409).json({ error: 'Publication is already in progress.' });
    }

    publishing = true;
    try {
      const post = await publisher.publish(message);
      await store.write({ ...state, post });
      return response.status(201).json({ post });
    } catch (error) {
      logger.error('X API post failed', error);
      const publicError = publicXError(error);
      return response.status(publicError.status).json({ error: publicError.message });
    } finally {
      publishing = false;
    }
  });

  app.post('/api/replies', upload.single('video'), async (request, response) => {
    try {
      if (!publisher) {
        return response.status(503).json({ error: 'X credentials are not configured.' });
      }

      const message = request.body?.message;
      if (typeof message !== 'string' || !message.trim() || [...message].length > maxMessageLength) {
        return response.status(400).json({ error: 'Reply must contain between 1 and 280 characters.' });
      }

      const state = await store.read();
      if (!state.post) {
        return response.status(409).json({ error: 'Publish the original post before adding its video reply.' });
      }

      if (state.reply) {
        return response.status(409).json({ error: 'The video reply has already been published.', reply: state.reply });
      }

      if (!request.file || !allowedVideoTypes.has(request.file.mimetype)) {
        return response.status(400).json({ error: 'Choose an MP4 or MOV video.' });
      }

      if (publishingReply) {
        return response.status(409).json({ error: 'Video upload is already in progress.' });
      }

      publishingReply = true;
      try {
        const reply = await publisher.publishReply({
          message,
          postId: state.post.id,
          videoPath: request.file.path,
          mediaType: request.file.mimetype
        });
        await store.write({ ...state, reply });
        return response.status(201).json({ reply });
      } catch (error) {
        logger.error('X API video reply failed', error);
        const publicError = publicXError(error);
        return response.status(publicError.status).json({ error: publicError.message });
      } finally {
        publishingReply = false;
      }
    } finally {
      if (request.file) {
        await unlink(request.file.path).catch((error) => logger.error('Temporary video cleanup failed', error));
      }
    }
  });

  app.use((error, _request, response, next) => {
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'The video must be no larger than 512 MB.'
        : 'The video upload could not be read.';
      return response.status(400).json({ error: message });
    }

    return next(error);
  });

  return app;
}