import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { TwitterApi } from 'twitter-api-v2';

export const requiredScopes = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'];
export const textScopes = ['tweet.read', 'tweet.write', 'users.read'];
export const videoScopes = ['tweet.read', 'tweet.write', 'users.read', 'media.write'];
export const defaultCallbackUrl = 'http://127.0.0.1:3000/auth/x/callback';

const oauth1Names = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];
const userFields = ['name', 'username', 'profile_image_url'];
const requestTimeout = 30_000;
const appendTimeout = 120_000;
const chunkSize = 4 * 1024 * 1024;
const processingDeadline = 15 * 60_000;
const refreshLeeway = 60_000;
const definiteNetworkFailures = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

export class LaunchpadAuthError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'LaunchpadAuthError';
    this.kind = kind;
  }
}

export class MediaProcessingError extends Error {
  constructor(message, { code = null } = {}) {
    super(message);
    this.name = 'MediaProcessingError';
    this.processingCode = code;
  }
}

export function isUncertainOutcome(error) {
  if (error?.type === 'partial-response') {
    return true;
  }

  if (error?.type === 'request') {
    return !definiteNetworkFailures.has(error.requestError?.code);
  }

  return false;
}

export function summarizeError(error) {
  if (!error) {
    return { message: 'Unknown error' };
  }

  const data = error.data && typeof error.data === 'object' ? error.data : {};
  return {
    name: error.name,
    kind: error.kind,
    type: error.type,
    code: error.code ?? error.requestError?.code,
    message: error.message,
    detail: data.detail ?? data.title ?? data.error_description ?? data.error,
    errors: Array.isArray(data.errors)
      ? data.errors.slice(0, 3).map((entry) => entry?.message ?? entry?.detail ?? entry?.title)
      : undefined
  };
}

export function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export function toAccount(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    avatarUrl: user.profile_image_url?.replace('_normal.', '_400x400.') || null
  };
}

export function postUrl(id, username) {
  return username ? `https://x.com/${username}/status/${id}` : `https://x.com/i/web/status/${id}`;
}

function trimmed(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function missingFrom(scopes, wanted) {
  return wanted.filter((scope) => !scopes.includes(scope));
}

function seedFingerprint(accessToken, refreshToken) {
  return createHash('sha256').update(`${accessToken || ''}\n${refreshToken || ''}`).digest('hex').slice(0, 16);
}

function isoAfter(now, seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? new Date(now + seconds * 1000).toISOString() : null;
}

export function createXConnection({
  env = process.env,
  tokenStore = null,
  clientFactory = (auth) => new TwitterApi(auth),
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console
} = {}) {
  const oauth1 = oauth1Names.every((name) => trimmed(env[name]))
    ? {
      appKey: env.X_API_KEY.trim(),
      appSecret: env.X_API_SECRET.trim(),
      accessToken: env.X_ACCESS_TOKEN.trim(),
      accessSecret: env.X_ACCESS_TOKEN_SECRET.trim()
    }
    : null;
  const clientId = trimmed(env.X_OAUTH2_CLIENT_ID);
  const clientSecret = trimmed(env.X_OAUTH2_CLIENT_SECRET);
  const callbackUrl = trimmed(env.X_OAUTH2_CALLBACK_URL) || defaultCallbackUrl;
  const seedAccessToken = trimmed(env.X_OAUTH2_ACCESS_TOKEN);
  const seedRefreshToken = trimmed(env.X_OAUTH2_REFRESH_TOKEN);
  const seed = seedAccessToken || seedRefreshToken
    ? { accessToken: seedAccessToken || null, refreshToken: seedRefreshToken || null, fingerprint: seedFingerprint(seedAccessToken, seedRefreshToken) }
    : null;

  let tokensPromise = null;
  let refreshPromise = null;
  let scopeCheckDone = false;
  const accountCache = new Map();

  function timestamp() {
    return new Date(now()).toISOString();
  }

  function appClient() {
    if (!clientId) {
      throw new LaunchpadAuthError('client-missing', 'Set X_OAUTH2_CLIENT_ID to use OAuth 2.0.');
    }

    return clientFactory({ clientId, clientSecret });
  }

  async function saveTokens(tokens) {
    tokensPromise = Promise.resolve(tokens);
    if (tokenStore) {
      await tokenStore.write(tokens || {});
    }
  }

  function loadTokens() {
    if (!tokensPromise) {
      tokensPromise = (async () => {
        const stored = tokenStore ? await tokenStore.read() : {};
        const current = stored?.accessToken || stored?.refreshToken ? stored : null;
        const seedChanged = current?.seedFingerprint && current.seedFingerprint !== seed?.fingerprint;

        if (seed && (!current || seedChanged)) {
          const seeded = {
            accessToken: seed.accessToken,
            refreshToken: seed.refreshToken,
            expiresAt: null,
            scope: null,
            source: 'environment',
            seedFingerprint: seed.fingerprint,
            updatedAt: timestamp()
          };
          await saveTokens(seeded);
          return seeded;
        }

        return current;
      })().catch((error) => {
        tokensPromise = null;
        throw error;
      });
    }

    return tokensPromise;
  }

  function oauth2Usable(tokens) {
    return Boolean(tokens && !tokens.invalidReason && (tokens.accessToken || (tokens.refreshToken && clientId)));
  }

  function scopesCover(tokens, wanted) {
    return !Array.isArray(tokens?.scope) || missingFrom(tokens.scope, wanted).length === 0;
  }

  async function modeFor(purpose = 'text') {
    const tokens = await loadTokens();

    if (oauth2Usable(tokens) && (purpose === 'video' || scopesCover(tokens, textScopes))) {
      return 'oauth2';
    }

    if (purpose === 'text' && oauth1) {
      return 'oauth1';
    }

    return null;
  }

  function refresh(tokens) {
    if (!refreshPromise) {
      const promise = (async () => {
        if (!tokens?.refreshToken) {
          throw new LaunchpadAuthError('reconnect-required', 'No OAuth 2.0 refresh token is available.');
        }

        try {
          const result = await appClient().refreshOAuth2Token(tokens.refreshToken);
          const next = {
            ...tokens,
            accessToken: result.accessToken,
            refreshToken: result.refreshToken || tokens.refreshToken,
            expiresAt: isoAfter(now(), result.expiresIn),
            scope: Array.isArray(result.scope) && result.scope.length > 0 ? result.scope : tokens.scope || null,
            refreshedAt: timestamp(),
            updatedAt: timestamp()
          };
          await saveTokens(next);
          return next;
        } catch (error) {
          if (error?.code === 400 || error?.code === 401) {
            await saveTokens({ ...tokens, invalidReason: 'refresh-rejected', invalidatedAt: timestamp() });
            accountCache.clear();
            throw new LaunchpadAuthError('reconnect-required', 'X rejected the OAuth 2.0 refresh token.');
          }

          throw error;
        }
      })();

      refreshPromise = promise;
      promise.then(() => {}, () => {}).then(() => {
        if (refreshPromise === promise) {
          refreshPromise = null;
        }
      });
    }

    return refreshPromise;
  }

  function accessTokenStale(tokens) {
    return !tokens.accessToken || (tokens.expiresAt && Date.parse(tokens.expiresAt) - now() < refreshLeeway);
  }

  async function withOAuth2(run) {
    let tokens = await loadTokens();

    if (!oauth2Usable(tokens)) {
      throw new LaunchpadAuthError('reconnect-required', 'X is not connected with OAuth 2.0.');
    }

    if (accessTokenStale(tokens)) {
      if (tokens.refreshToken && clientId) {
        tokens = await refresh(tokens);
      } else if (!tokens.accessToken) {
        throw new LaunchpadAuthError('reconnect-required', 'The OAuth 2.0 access token is missing.');
      }
    }

    try {
      return await run(clientFactory(tokens.accessToken));
    } catch (error) {
      if (error?.code === 401 && tokens.refreshToken && clientId) {
        const refreshed = await refresh(tokens);
        return run(clientFactory(refreshed.accessToken));
      }

      throw error;
    }
  }

  async function withClient(purpose, run) {
    const mode = await modeFor(purpose);

    if (mode === 'oauth2') {
      return withOAuth2(run);
    }

    if (mode === 'oauth1') {
      return run(clientFactory(oauth1));
    }

    throw new LaunchpadAuthError(
      purpose === 'video' ? 'reconnect-required' : 'not-configured',
      purpose === 'video' ? 'Video uploads need an OAuth 2.0 connection.' : 'X credentials are not configured.'
    );
  }

  async function fetchAccount(client) {
    const { data } = await client.v2.me({ 'user.fields': userFields });
    return toAccount(data);
  }

  async function getAccount({ purpose = 'text', force = false } = {}) {
    const mode = await modeFor(purpose);

    if (!mode) {
      throw new LaunchpadAuthError('not-configured', 'X credentials are not configured.');
    }

    if (force || !accountCache.has(mode)) {
      const promise = withClient(purpose, fetchAccount).catch((error) => {
        accountCache.delete(mode);
        throw error;
      });
      accountCache.set(mode, promise);
    }

    return accountCache.get(mode);
  }

  async function verifyConnection() {
    const tokens = await loadTokens();

    if (!scopeCheckDone && oauth2Usable(tokens) && !tokens.scope && tokens.refreshToken && clientId) {
      scopeCheckDone = true;
      try {
        await refresh(tokens);
      } catch (error) {
        logger.error('OAuth 2.0 scope check failed', summarizeError(error));
      }
    }

    return getAccount();
  }

  function readinessFor(mode, tokens, wanted, unavailableReason) {
    if (!mode) {
      return { state: 'unavailable', reason: unavailableReason };
    }

    if (mode === 'oauth1') {
      return { state: 'ready', reason: null, auth: 'oauth1' };
    }

    if (!Array.isArray(tokens.scope)) {
      return { state: 'unverified', reason: 'Granted scopes are not verified yet. Use Connect / Reconnect X to confirm them.', auth: 'oauth2' };
    }

    const missing = missingFrom(tokens.scope, wanted);
    if (missing.length > 0) {
      return { state: 'unavailable', reason: `The OAuth 2.0 token lacks ${missing.join(', ')}. Use Connect / Reconnect X.`, auth: 'oauth2' };
    }

    return { state: 'ready', reason: null, auth: 'oauth2' };
  }

  async function describe() {
    const tokens = await loadTokens();
    const textMode = await modeFor('text');
    const videoMode = await modeFor('video');
    const connected = oauth2Usable(tokens);

    return {
      auth: textMode,
      oauth1: { configured: Boolean(oauth1) },
      oauth2: {
        clientConfigured: Boolean(clientId),
        connected,
        source: tokens?.source || null,
        scopes: Array.isArray(tokens?.scope) ? tokens.scope : null,
        missingScopes: Array.isArray(tokens?.scope) ? missingFrom(tokens.scope, requiredScopes) : null,
        refreshable: Boolean(tokens?.refreshToken && clientId),
        expiresAt: tokens?.expiresAt || null,
        invalidReason: tokens?.invalidReason || null,
        reconnectRequired: Boolean(clientId) && (!connected || (Array.isArray(tokens?.scope) && missingFrom(tokens.scope, requiredScopes).length > 0)),
        callbackUrl,
        requiredScopes
      },
      readiness: {
        text: readinessFor(textMode, tokens, textScopes, 'No X credentials are configured. Add OAuth 2.0 tokens or the OAuth 1.0a keys.'),
        video: readinessFor(videoMode, tokens, videoScopes, 'Video uploads need an OAuth 2.0 connection with media.write. Use Connect / Reconnect X.')
      }
    };
  }

  async function publish(text) {
    const response = await withClient('text', (client) => client.v2.post('tweets', { text }, { timeout: requestTimeout }));
    return { id: response.data.id, text: response.data.text };
  }

  async function publishReply({ text, postId, mediaId }) {
    const response = await withClient('video', (client) => client.v2.post('tweets', {
      text,
      reply: { in_reply_to_tweet_id: postId },
      media: { media_ids: [mediaId] }
    }, { timeout: requestTimeout }));
    return { id: response.data.id, text: response.data.text };
  }

  async function uploadVideo({ path, mimeType, size, onPhase = () => {} }) {
    return withClient('video', async (client) => {
      onPhase('uploading', { uploadedBytes: 0, totalBytes: size });
      const init = await client.v2.post('media/upload/initialize', {
        media_type: mimeType,
        total_bytes: size,
        media_category: 'tweet_video'
      }, { timeout: requestTimeout });
      const mediaId = init.data.id;
      let expiresAt = isoAfter(now(), init.data.expires_after_secs);

      const handle = await open(path, 'r');
      try {
        let uploaded = 0;
        let segment = 0;
        while (uploaded < size) {
          const length = Math.min(chunkSize, size - uploaded);
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, uploaded);
          if (bytesRead === 0) {
            break;
          }

          await client.v2.post(`media/upload/${mediaId}/append`, {
            segment_index: segment,
            media: bytesRead === length ? buffer : buffer.subarray(0, bytesRead)
          }, { forceBodyMode: 'form-data', timeout: appendTimeout });
          uploaded += bytesRead;
          segment += 1;
          onPhase('uploading', { uploadedBytes: uploaded, totalBytes: size });
        }
      } finally {
        await handle.close();
      }

      const finalize = await client.v2.post(`media/upload/${mediaId}/finalize`, undefined, { timeout: requestTimeout });
      expiresAt = isoAfter(now(), finalize.data.expires_after_secs) || expiresAt;
      let info = finalize.data.processing_info;
      const deadline = now() + processingDeadline;

      while (info && info.state !== 'succeeded') {
        if (info.state === 'failed') {
          throw new MediaProcessingError(info.error?.message || 'X could not process the video.', { code: info.error?.code ?? null });
        }

        onPhase('processing', { progressPercent: info.progress_percent ?? null });
        if (now() > deadline) {
          throw new MediaProcessingError('X did not finish processing the video in time.');
        }

        await sleep(Math.min(Math.max(info.check_after_secs || 2, 1), 15) * 1000);
        const status = await client.v2.get('media/upload', { command: 'STATUS', media_id: mediaId }, { timeout: requestTimeout });
        info = status.data.processing_info;
        expiresAt = isoAfter(now(), status.data.expires_after_secs) || expiresAt;
      }

      return { mediaId, expiresAt };
    });
  }

  function beginAuthorization() {
    const { url, codeVerifier, state } = appClient().generateOAuth2AuthLink(callbackUrl, { scope: requiredScopes });
    return { url, codeVerifier, state };
  }

  async function exchangeAuthorizationCode({ code, codeVerifier }) {
    const result = await appClient().loginWithOAuth2({ code, codeVerifier, redirectUri: callbackUrl });
    const account = await fetchAccount(result.client);
    const scopes = Array.isArray(result.scope) ? result.scope : [];
    const tokens = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken || null,
      expiresAt: isoAfter(now(), result.expiresIn),
      scope: scopes,
      source: 'authorization',
      accountId: account.id,
      username: account.username,
      authorizedAt: timestamp(),
      updatedAt: timestamp()
    };

    return { tokens, account, scopes, missingScopes: missingFrom(scopes, requiredScopes) };
  }

  async function adoptTokens(tokens) {
    await saveTokens(tokens);
    accountCache.clear();
    scopeCheckDone = true;
  }

  return {
    callbackUrl,
    describe,
    verifyConnection,
    getAccount,
    publish,
    publishReply,
    uploadVideo,
    beginAuthorization,
    exchangeAuthorizationCode,
    adoptTokens
  };
}
