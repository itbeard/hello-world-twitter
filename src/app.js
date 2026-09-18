import express from 'express';
import multer from 'multer';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeXConnection } from './fakeX.js';
import { createMemoryStateStore } from './stateStore.js';
import { maxWeightedLength, measureText } from './textRules.js';
import {
  LaunchpadAuthError,
  MediaProcessingError,
  hashFile,
  isUncertainOutcome,
  postUrl,
  summarizeError
} from './xConnection.js';

const publicDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
export const maxVideoSize = 512 * 1024 * 1024;
const allowedVideoTypes = new Set(['video/mp4', 'video/quicktime']);
const authorizationTtl = 10 * 60_000;
const mediaReuseLeeway = 5 * 60_000;

export function publicXError(error, context = 'request') {
  if (error instanceof LaunchpadAuthError) {
    if (error.kind === 'not-configured') {
      return { status: 503, message: 'X credentials are not configured.' };
    }

    if (error.kind === 'client-missing') {
      return { status: 503, message: 'Set X_OAUTH2_CLIENT_ID (and X_OAUTH2_CLIENT_SECRET) to connect X with OAuth 2.0.' };
    }

    return { status: 401, message: 'The OAuth 2.0 connection is not usable. Use Connect / Reconnect X.' };
  }

  if (error instanceof MediaProcessingError) {
    return { status: 502, message: `X could not process the video: ${error.message}` };
  }

  const detail = error?.data?.detail || error?.data?.title;

  switch (error?.code) {
    case 400:
      return { status: 502, message: `X rejected the ${context} (400)${detail ? `: ${detail}` : '.'}` };
    case 401:
      return { status: 401, message: 'X rejected the credentials (401). Check the configured tokens or use Connect / Reconnect X.' };
    case 403:
      return {
        status: 403,
        message: context === 'upload'
          ? 'X refused the upload (403). The token probably lacks media.write — use Connect / Reconnect X to grant it.'
          : `X refused the ${context} (403). Check that the token has tweet.write and that the text is not a duplicate.${detail ? ` X said: ${detail}` : ''}`
      };
    case 429:
      return { status: 429, message: 'The X API rate limit has been reached (429). Wait and try again later.' };
    default:
      if (isUncertainOutcome(error)) {
        return { status: 502, message: 'X did not confirm the result. Check the account on X before trying again.' };
      }

      if (error?.type === 'request') {
        return { status: 502, message: 'Could not reach the X API. Check the network connection and try again.' };
      }

      if (Number(error?.code) >= 500) {
        return { status: 502, message: `The X API is unavailable right now (${error.code}). Try again later.` };
      }

      return { status: 502, message: `The X API could not complete the ${context}.` };
  }
}

function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : value;
}

function extractPostId(value) {
  const match = typeof value === 'string' ? value.match(/(\d{8,})/) : null;
  return match ? match[1] : null;
}

function without(state, key) {
  const { [key]: removed, ...rest } = state;
  return rest;
}

function publicMedia(media) {
  return media
    ? { id: media.id, fileName: media.fileName, size: media.size, uploadedAt: media.uploadedAt, expiresAt: media.expiresAt }
    : null;
}

export function createApp({
  connection = null,
  logger = console,
  store = createMemoryStateStore(),
  uploadDirectory = tmpdir(),
  expectedAccountId = null,
  now = () => Date.now()
} = {}) {
  const x = connection ?? createFakeXConnection({ auth: 'none', clientConfigured: false });
  const app = express();
  const upload = multer({
    dest: uploadDirectory,
    limits: { fileSize: maxVideoSize, files: 1, fields: 4, fieldSize: 8 * 1024 }
  });
  const pendingAuthorizations = new Map();
  const expectedId = typeof expectedAccountId === 'string' && expectedAccountId.trim() ? expectedAccountId.trim() : null;
  let publishing = false;
  let replyRunning = false;
  let replyJob = null;

  function timestamp() {
    return new Date(now()).toISOString();
  }

  function guardFor(account) {
    return { expectedAccountId: expectedId, matches: expectedId && account ? account.id === expectedId : null };
  }

  function mismatchMessage(account) {
    return `Connected account @${account.username} (ID ${account.id}) does not match X_EXPECTED_ACCOUNT_ID=${expectedId}. Publishing is blocked.`;
  }

  function differentPublisherMessage(account, post) {
    return `The OAuth 2.0 account @${account.username} is not the account that published the first post (@${post.accountUsername}). Reconnect X with that account.`;
  }

  function removeFile(file) {
    return file ? unlink(file.path).catch((error) => logger.error('Temporary video cleanup failed', summarizeError(error))) : Promise.resolve();
  }

  function pruneAuthorizations() {
    for (const [state, entry] of pendingAuthorizations) {
      if (now() - entry.createdAt > authorizationTtl) {
        pendingAuthorizations.delete(state);
      }
    }
  }

  app.disable('x-powered-by');
  app.use(express.json({ limit: '8kb' }));
  app.use(express.static(publicDirectory));

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.get('/api/status', async (_request, response) => {
    try {
      const state = await store.read();
      let info = await x.describe();
      let account = null;
      let accountError = null;

      if (info.auth) {
        try {
          account = await x.verifyConnection();
        } catch (error) {
          logger.error('X connection check failed', summarizeError(error));
          accountError = publicXError(error, 'connection check').message;
          info = await x.describe();
        }
      }

      const guard = guardFor(account);
      let textBlocker = null;
      if (!info.auth) {
        textBlocker = info.readiness.text.reason;
      } else if (accountError) {
        textBlocker = accountError;
      } else if (guard.matches === false) {
        textBlocker = mismatchMessage(account);
      } else if (info.readiness.text.state === 'unavailable') {
        textBlocker = info.readiness.text.reason;
      }

      let videoBlocker = null;
      if (info.readiness.video.state === 'unavailable') {
        videoBlocker = info.readiness.video.reason;
      } else if (accountError) {
        videoBlocker = accountError;
      } else if (guard.matches === false) {
        videoBlocker = mismatchMessage(account);
      } else if (!state.post) {
        videoBlocker = 'Publish the first post before adding its video reply.';
      } else if (account && state.post.accountId && account.id !== state.post.accountId) {
        videoBlocker = differentPublisherMessage(account, state.post);
      }

      response.json({
        connection: info,
        account,
        accountError,
        guard,
        post: state.post || null,
        pending: state.pending || null,
        media: publicMedia(state.media),
        reply: state.reply || null,
        replyJob,
        blockers: { text: textBlocker, video: videoBlocker },
        limits: { maxWeightedLength, maxVideoSize }
      });
    } catch (error) {
      logger.error('Launchpad status failed', summarizeError(error));
      response.status(500).json({ error: 'Launchpad could not load its saved state.' });
    }
  });

  app.post('/api/posts', async (request, response) => {
    const text = normalizeText(request.body?.text);
    const measured = measureText(text);
    if (!measured.valid) {
      return response.status(400).json({
        error: measured.empty
          ? 'Write something before publishing.'
          : `The post weighs ${measured.weightedLength} of ${maxWeightedLength} characters. Shorten it.`,
        weightedLength: measured.weightedLength
      });
    }

    const info = await x.describe();
    if (!info.auth) {
      return response.status(503).json({ error: 'X credentials are not configured.' });
    }

    if (info.readiness.text.state === 'unavailable') {
      return response.status(403).json({ error: info.readiness.text.reason });
    }

    if (publishing) {
      return response.status(409).json({ error: 'Publication is already in progress.' });
    }

    publishing = true;
    try {
      const state = await store.read();
      if (state.post) {
        return response.status(409).json({ error: 'The first post has already been published.', post: state.post });
      }

      if (state.pending) {
        return response.status(409).json({
          error: 'A previous attempt has an unknown outcome. Check X and resolve it before publishing again.',
          pending: state.pending
        });
      }

      let account;
      try {
        account = await x.getAccount();
      } catch (error) {
        logger.error('X connection check failed', summarizeError(error));
        const publicError = publicXError(error, 'connection check');
        return response.status(publicError.status).json({ error: publicError.message });
      }

      if (expectedId && account.id !== expectedId) {
        return response.status(403).json({ error: mismatchMessage(account) });
      }

      const startedAt = timestamp();
      try {
        const created = await x.publish(text);
        const post = {
          id: created.id,
          text: created.text ?? text,
          url: postUrl(created.id, account.username),
          accountId: account.id,
          accountUsername: account.username,
          accountName: account.name,
          publishedAt: timestamp()
        };
        await store.update((current) => ({ ...current, post }));
        return response.status(201).json({ post });
      } catch (error) {
        logger.error('X API post failed', summarizeError(error));

        if (isUncertainOutcome(error)) {
          const pending = {
            text,
            accountId: account.id,
            accountUsername: account.username,
            startedAt,
            failedAt: timestamp(),
            reason: 'The request to X timed out or was cut off before X answered.'
          };
          await store.update((current) => ({ ...current, pending }));
          return response.status(502).json({
            error: `X did not confirm whether the post was created. Check @${account.username} on X, then resolve the attempt. Nothing is retried automatically.`,
            pending
          });
        }

        const publicError = publicXError(error, 'post');
        return response.status(publicError.status).json({ error: publicError.message });
      }
    } finally {
      publishing = false;
    }
  });

  app.post('/api/posts/pending/resolve', async (request, response) => {
    const state = await store.read();
    if (!state.pending) {
      return response.status(409).json({ error: 'There is no unresolved attempt.' });
    }

    const outcome = request.body?.outcome;
    if (outcome === 'not-published') {
      const next = await store.update((current) => without(current, 'pending'));
      return response.json({ pending: null, post: next.post || null });
    }

    if (outcome === 'published') {
      const id = extractPostId(request.body?.postId);
      if (!id) {
        return response.status(400).json({ error: 'Paste the post link or its numeric ID.' });
      }

      const post = {
        id,
        text: state.pending.text,
        url: postUrl(id, state.pending.accountUsername),
        accountId: state.pending.accountId,
        accountUsername: state.pending.accountUsername,
        publishedAt: state.pending.startedAt,
        confirmedManually: true
      };
      await store.update((current) => ({ ...without(current, 'pending'), post }));
      return response.json({ pending: null, post });
    }

    return response.status(400).json({ error: 'Outcome must be "published" or "not-published".' });
  });

  async function runReplyJob({ text, file, post }) {
    const updateJob = (patch) => {
      replyJob = { ...replyJob, ...patch };
    };
    let media = null;

    try {
      const fingerprint = await hashFile(file.path);
      const state = await store.read();
      const stored = state.media;
      const reusable = stored
        && stored.fingerprint === fingerprint
        && stored.mimeType === file.mimetype
        && (!stored.expiresAt || Date.parse(stored.expiresAt) - now() > mediaReuseLeeway);

      if (reusable) {
        media = stored;
        updateJob({ reusedMedia: true, uploadedBytes: file.size });
      } else {
        if (stored) {
          await store.update((current) => without(current, 'media'));
        }

        const uploaded = await x.uploadVideo({
          path: file.path,
          mimeType: file.mimetype,
          size: file.size,
          onPhase: (phase, progress) => updateJob({ phase, ...progress })
        });
        media = {
          id: uploaded.mediaId,
          fingerprint,
          mimeType: file.mimetype,
          fileName: file.originalname,
          size: file.size,
          uploadedAt: timestamp(),
          expiresAt: uploaded.expiresAt || null
        };
        await store.update((current) => ({ ...current, media }));
      }

      updateJob({ phase: 'publishing' });
      const created = await x.publishReply({ text, postId: post.id, mediaId: media.id });
      const reply = {
        id: created.id,
        text: created.text ?? text,
        url: postUrl(created.id, post.accountUsername),
        postId: post.id,
        mediaId: media.id,
        publishedAt: timestamp()
      };
      await store.update((current) => ({ ...without(current, 'media'), reply }));
      updateJob({ phase: 'published', reply, finishedAt: timestamp() });
    } catch (error) {
      logger.error('X API video reply failed', summarizeError(error));
      const context = replyJob.phase === 'publishing' ? 'reply' : 'upload';
      const mediaRejected = media !== null && context === 'reply' && error?.code === 400;

      if (error instanceof MediaProcessingError || mediaRejected) {
        await store.update((current) => without(current, 'media'));
        media = null;
      }

      updateJob({
        phase: 'failed',
        failedDuring: context,
        error: publicXError(error, context).message,
        uncertain: context === 'reply' && isUncertainOutcome(error),
        mediaPreserved: media !== null,
        finishedAt: timestamp()
      });
    } finally {
      replyRunning = false;
      await removeFile(file);
    }
  }

  app.post('/api/replies', upload.single('video'), async (request, response) => {
    let file = request.file || null;

    try {
      const text = normalizeText(request.body?.text);
      const measured = measureText(text);
      if (!measured.valid) {
        return response.status(400).json({
          error: measured.empty
            ? 'Write the reply text before publishing.'
            : `The reply weighs ${measured.weightedLength} of ${maxWeightedLength} characters. Shorten it.`,
          weightedLength: measured.weightedLength
        });
      }

      const info = await x.describe();
      if (info.readiness.video.state === 'unavailable') {
        return response.status(403).json({ error: info.readiness.video.reason });
      }

      const state = await store.read();
      if (!state.post) {
        return response.status(409).json({ error: 'Publish the first post before adding its video reply.' });
      }

      if (state.reply) {
        return response.status(409).json({ error: 'The video reply has already been published.', reply: state.reply });
      }

      if (!file) {
        return response.status(400).json({ error: 'Choose the MP4 recording first.' });
      }

      if (!allowedVideoTypes.has(file.mimetype)) {
        return response.status(400).json({ error: 'Choose an MP4 or MOV video.' });
      }

      if (file.size === 0) {
        return response.status(400).json({ error: 'The selected video is empty.' });
      }

      if (replyRunning) {
        return response.status(409).json({ error: 'The video reply is already being published.', job: replyJob });
      }

      let account;
      try {
        account = await x.getAccount({ purpose: 'video' });
      } catch (error) {
        logger.error('X connection check failed', summarizeError(error));
        const publicError = publicXError(error, 'connection check');
        return response.status(publicError.status).json({ error: publicError.message });
      }

      if (expectedId && account.id !== expectedId) {
        return response.status(403).json({ error: mismatchMessage(account) });
      }

      if (state.post.accountId && account.id !== state.post.accountId) {
        return response.status(403).json({ error: differentPublisherMessage(account, state.post) });
      }

      replyRunning = true;
      replyJob = {
        phase: 'uploading',
        startedAt: timestamp(),
        fileName: file.originalname,
        totalBytes: file.size,
        uploadedBytes: 0,
        progressPercent: null,
        reusedMedia: false,
        error: null,
        reply: null
      };
      const job = runReplyJob({ text, file, post: state.post });
      file = null;
      job.catch((error) => logger.error('Video reply job crashed', summarizeError(error)));
      return response.status(202).json({ job: replyJob });
    } finally {
      await removeFile(file);
    }
  });

  app.get('/api/replies/progress', async (_request, response) => {
    const state = await store.read();
    response.json({ job: replyJob, reply: state.reply || null, media: publicMedia(state.media) });
  });

  app.get('/auth/x/start', (_request, response) => {
    try {
      const { url, codeVerifier, state } = x.beginAuthorization();
      pruneAuthorizations();
      pendingAuthorizations.set(state, { codeVerifier, createdAt: now() });
      response.redirect(url);
    } catch (error) {
      logger.error('OAuth 2.0 authorization could not start', summarizeError(error));
      const reason = error instanceof LaunchpadAuthError ? error.kind : 'start-failed';
      response.redirect(`/?auth=error&reason=${encodeURIComponent(reason)}`);
    }
  });

  app.get('/auth/x/callback', async (request, response) => {
    const { state, code, error: denied } = request.query;
    const fail = (reason, detail) => {
      const params = new URLSearchParams({ auth: 'error', reason });
      if (detail) {
        params.set('detail', detail);
      }

      return response.redirect(`/?${params}`);
    };

    const entry = typeof state === 'string' ? pendingAuthorizations.get(state) : undefined;
    if (entry) {
      pendingAuthorizations.delete(state);
    }

    if (!entry || now() - entry.createdAt > authorizationTtl) {
      return fail('state');
    }

    if (denied) {
      return fail('denied');
    }

    if (typeof code !== 'string' || !code) {
      return fail('code');
    }

    try {
      const result = await x.exchangeAuthorizationCode({ code, codeVerifier: entry.codeVerifier });
      const saved = await store.read();

      if (expectedId && result.account.id !== expectedId) {
        return fail('mismatch', `@${result.account.username} (ID ${result.account.id}) is not the expected account ${expectedId}. Tokens were not stored.`);
      }

      if (saved.post?.accountId && result.account.id !== saved.post.accountId) {
        return fail('mismatch', `@${result.account.username} is not the account that published the first post (@${saved.post.accountUsername}). Tokens were not stored.`);
      }

      await x.adoptTokens(result.tokens);
      const params = new URLSearchParams({ auth: 'success', account: result.account.username });
      if (result.missingScopes.length > 0) {
        params.set('missing', result.missingScopes.join(' '));
      }

      return response.redirect(`/?${params}`);
    } catch (error) {
      logger.error('OAuth 2.0 authorization failed', summarizeError(error));
      return fail('exchange', publicXError(error, 'authorization').message);
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
