import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { test } from 'node:test';
import { xRequestError, xResponseError } from '../src/fakeX.js';
import { createFileStateStore, createMemoryStateStore } from '../src/stateStore.js';
import {
  MediaProcessingError,
  LaunchpadAuthError,
  createXConnection,
  isUncertainOutcome,
  requiredScopes,
  summarizeError
} from '../src/xConnection.js';

const oauth1Env = {
  X_API_KEY: 'key',
  X_API_SECRET: 'secret',
  X_ACCESS_TOKEN: 'token',
  X_ACCESS_TOKEN_SECRET: 'token-secret'
};
const oauth2Env = {
  X_OAUTH2_CLIENT_ID: 'client-id',
  X_OAUTH2_CLIENT_SECRET: 'client-secret',
  X_OAUTH2_ACCESS_TOKEN: 'seed-access',
  X_OAUTH2_REFRESH_TOKEN: 'seed-refresh'
};
const user = { id: '1000000000000000001', name: 'Junie', username: 'junie_ai', profile_image_url: 'https://pbs.twimg.com/junie_normal.png' };

function createFakeTwitterApi(options = {}) {
  const calls = [];
  const state = {
    rejectAccessTokens: new Set(options.rejectAccessTokens || []),
    refresh: options.refresh || { accessToken: 'refreshed-access', refreshToken: 'rotated-refresh', expiresIn: 7200, scope: requiredScopes },
    refreshError: options.refreshError || null,
    processing: options.processing || 'ok',
    statusPolls: 0
  };

  function userClient(auth) {
    const label = typeof auth === 'string' ? `bearer:${auth}` : `oauth1:${auth.accessToken}`;
    const guard = () => {
      if (typeof auth === 'string' && state.rejectAccessTokens.has(auth)) {
        throw xResponseError(401, 'Unauthorized');
      }
    };

    return {
      v2: {
        me: async (params) => {
          calls.push({ client: label, method: 'me', params });
          guard();
          return { data: user };
        },
        post: async (url, body, requestOptions) => {
          calls.push({ client: label, method: 'post', url, body, requestOptions });
          guard();
          if (url === 'tweets') {
            return { data: { id: '1900000000000000123', text: body.text } };
          }
          if (url === 'media/upload/initialize') {
            return { data: { id: '1880028106020515840', media_key: '13_1880028106020515840', expires_after_secs: 86_400 } };
          }
          if (url.endsWith('/append')) {
            return {};
          }
          if (url.endsWith('/finalize')) {
            return { data: { id: '1880028106020515840', expires_after_secs: 3600, processing_info: { state: 'pending', check_after_secs: 1 } } };
          }
          throw new Error(`unexpected post ${url}`);
        },
        get: async (url, params) => {
          calls.push({ client: label, method: 'get', url, params });
          guard();
          state.statusPolls += 1;
          if (state.statusPolls === 1) {
            return { data: { processing_info: { state: 'in_progress', check_after_secs: 1, progress_percent: 50 } } };
          }
          return state.processing === 'failed'
            ? { data: { processing_info: { state: 'failed', error: { code: 3, message: 'InvalidMedia: Unsupported video.' } } } }
            : { data: { processing_info: { state: 'succeeded' }, expires_after_secs: 3000 } };
        }
      }
    };
  }

  function appClient(auth) {
    return {
      generateOAuth2AuthLink: (redirectUri, linkOptions) => {
        calls.push({ client: 'app', method: 'generateOAuth2AuthLink', redirectUri, scope: linkOptions.scope });
        return { url: `https://x.com/i/oauth2/authorize?state=abc&redirect_uri=${encodeURIComponent(redirectUri)}`, codeVerifier: 'verifier', state: 'abc' };
      },
      loginWithOAuth2: async (args) => {
        calls.push({ client: 'app', method: 'loginWithOAuth2', args });
        return { client: userClient('authorized-access'), accessToken: 'authorized-access', refreshToken: 'authorized-refresh', expiresIn: 7200, scope: options.grantScopes || requiredScopes };
      },
      refreshOAuth2Token: async (refreshToken) => {
        calls.push({ client: 'app', method: 'refreshOAuth2Token', refreshToken, clientSecret: auth.clientSecret });
        if (state.refreshError) {
          throw state.refreshError;
        }
        return { ...state.refresh, client: userClient(state.refresh.accessToken) };
      }
    };
  }

  const factory = (auth) => (auth && typeof auth === 'object' && auth.clientId ? appClient(auth) : userClient(auth));
  return { factory, calls, state };
}

function connectionWith(env, fakeOptions = {}, extra = {}) {
  const fake = createFakeTwitterApi(fakeOptions);
  const tokenStore = extra.tokenStore || createMemoryStateStore();
  const connection = createXConnection({
    env,
    tokenStore,
    clientFactory: fake.factory,
    sleep: async () => {},
    logger: { error() {} },
    now: extra.now
  });
  return { connection, fake, tokenStore };
}

test('prefers OAuth 2.0 for text posts when both credential sets exist', async () => {
  const { connection, fake } = connectionWith({ ...oauth1Env, ...oauth2Env });
  const info = await connection.describe();
  assert.equal(info.auth, 'oauth2');
  assert.equal(info.oauth1.configured, true);

  const post = await connection.publish('Hello');
  assert.equal(post.id, '1900000000000000123');
  assert.equal(fake.calls.at(-1).client, 'bearer:seed-access');
  assert.deepEqual(fake.calls.at(-1).requestOptions, { timeout: 30_000 });
});

test('falls back to OAuth 1.0a when only the legacy keys are configured', async () => {
  const { connection, fake } = connectionWith(oauth1Env);
  const info = await connection.describe();
  assert.equal(info.auth, 'oauth1');
  assert.equal(info.readiness.text.state, 'ready');
  assert.equal(info.readiness.video.state, 'unavailable');
  assert.match(info.readiness.video.reason, /OAuth 2.0 connection with media\.write/);

  const account = await connection.getAccount();
  assert.equal(account.username, 'junie_ai');
  assert.equal(account.avatarUrl, 'https://pbs.twimg.com/junie_400x400.png');
  assert.equal(fake.calls[0].client, 'oauth1:token');
  await connection.getAccount();
  assert.equal(fake.calls.filter((call) => call.method === 'me').length, 1, 'account lookups are cached');
});

test('reports nothing configured when no credentials are present', async () => {
  const { connection } = connectionWith({});
  const info = await connection.describe();
  assert.equal(info.auth, null);
  assert.equal(info.readiness.text.state, 'unavailable');
  await assert.rejects(connection.getAccount(), (error) => error instanceof LaunchpadAuthError && error.kind === 'not-configured');
  await assert.rejects(connection.publish('x'), LaunchpadAuthError);
});

test('seeds OAuth 2.0 tokens from the environment into the token store without scope claims', async () => {
  const { connection, tokenStore } = connectionWith(oauth2Env);
  const info = await connection.describe();
  assert.equal(info.oauth2.connected, true);
  assert.equal(info.oauth2.scopes, null);
  assert.equal(info.readiness.text.state, 'unverified');
  assert.equal(info.readiness.video.state, 'unverified');
  assert.equal(info.oauth2.callbackUrl, 'http://127.0.0.1:3000/auth/x/callback');

  const stored = await tokenStore.read();
  assert.equal(stored.accessToken, 'seed-access');
  assert.equal(stored.refreshToken, 'seed-refresh');
  assert.equal(stored.source, 'environment');
  assert.equal(stored.scope, null);
});

test('connection check refreshes seeded tokens once to learn the granted scopes and persists rotation', async () => {
  const { connection, fake, tokenStore } = connectionWith(oauth2Env, {
    refresh: { accessToken: 'refreshed-access', refreshToken: 'rotated-refresh', expiresIn: 7200, scope: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'] }
  });

  const account = await connection.verifyConnection();
  assert.equal(account.id, user.id);
  const refreshCalls = fake.calls.filter((call) => call.method === 'refreshOAuth2Token');
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].refreshToken, 'seed-refresh');
  assert.equal(refreshCalls[0].clientSecret, 'client-secret');
  assert.equal(fake.calls.find((call) => call.method === 'me').client, 'bearer:refreshed-access');

  const stored = await tokenStore.read();
  assert.equal(stored.accessToken, 'refreshed-access');
  assert.equal(stored.refreshToken, 'rotated-refresh');
  assert.deepEqual(stored.scope, ['tweet.read', 'tweet.write', 'users.read', 'offline.access']);
  assert.ok(Date.parse(stored.expiresAt) > Date.now());

  const info = await connection.describe();
  assert.equal(info.readiness.text.state, 'ready');
  assert.equal(info.readiness.video.state, 'unavailable');
  assert.deepEqual(info.oauth2.missingScopes, ['media.write']);
  assert.equal(info.oauth2.reconnectRequired, true);

  await connection.verifyConnection();
  assert.equal(fake.calls.filter((call) => call.method === 'refreshOAuth2Token').length, 1, 'scope check runs once');
});

test('retries once with a refreshed token after X answers 401', async () => {
  const { connection, fake, tokenStore } = connectionWith(
    { ...oauth2Env, X_OAUTH2_REFRESH_TOKEN: 'seed-refresh' },
    { rejectAccessTokens: ['seed-access'] }
  );

  const post = await connection.publish('Hello');
  assert.equal(post.id, '1900000000000000123');
  const tweetCalls = fake.calls.filter((call) => call.method === 'post' && call.url === 'tweets');
  assert.deepEqual(tweetCalls.map((call) => call.client), ['bearer:seed-access', 'bearer:refreshed-access']);
  assert.equal((await tokenStore.read()).refreshToken, 'rotated-refresh');
});

test('refreshes proactively when the stored access token is about to expire', async () => {
  const tokenStore = createMemoryStateStore({
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    scope: requiredScopes,
    source: 'authorization'
  });
  const { connection, fake } = connectionWith({ X_OAUTH2_CLIENT_ID: 'client-id', X_OAUTH2_CLIENT_SECRET: 'client-secret' }, {}, { tokenStore });

  await connection.publish('Hello');
  assert.equal(fake.calls.find((call) => call.method === 'refreshOAuth2Token').refreshToken, 'old-refresh');
  assert.equal(fake.calls.find((call) => call.url === 'tweets').client, 'bearer:refreshed-access');
});

test('a rejected refresh marks the connection for reconnect and falls back to OAuth 1.0a for text', async () => {
  const { connection, fake, tokenStore } = connectionWith(
    { ...oauth1Env, ...oauth2Env },
    { rejectAccessTokens: ['seed-access'], refreshError: xResponseError(400, 'invalid_request') }
  );

  await assert.rejects(connection.publish('Hello'), (error) => error instanceof LaunchpadAuthError && error.kind === 'reconnect-required');
  const stored = await tokenStore.read();
  assert.equal(stored.invalidReason, 'refresh-rejected');

  const info = await connection.describe();
  assert.equal(info.auth, 'oauth1');
  assert.equal(info.oauth2.connected, false);
  assert.equal(info.oauth2.reconnectRequired, true);
  assert.equal(info.readiness.video.state, 'unavailable');

  const post = await connection.publish('Hello again');
  assert.equal(post.id, '1900000000000000123');
  assert.equal(fake.calls.at(-1).client, 'oauth1:token');
});

test('stored tokens win over unchanged environment seeds but a changed seed replaces them', async () => {
  const stored = {
    accessToken: 'stored-access',
    refreshToken: 'stored-refresh',
    scope: requiredScopes,
    source: 'environment',
    seedFingerprint: null
  };
  const first = connectionWith(oauth2Env);
  await first.connection.describe();
  const seeded = await first.tokenStore.read();

  const sameSeed = connectionWith(oauth2Env, {}, { tokenStore: createMemoryStateStore({ ...seeded, ...stored, seedFingerprint: seeded.seedFingerprint }) });
  await sameSeed.connection.publish('Hello');
  assert.equal(sameSeed.fake.calls.at(-1).client, 'bearer:stored-access');

  const changedSeed = connectionWith({ ...oauth2Env, X_OAUTH2_ACCESS_TOKEN: 'brand-new-access' }, {}, { tokenStore: createMemoryStateStore({ ...seeded, ...stored, seedFingerprint: seeded.seedFingerprint }) });
  await changedSeed.connection.publish('Hello');
  assert.equal(changedSeed.fake.calls.at(-1).client, 'bearer:brand-new-access');

  const authorized = connectionWith(oauth2Env, {}, { tokenStore: createMemoryStateStore({ ...stored, source: 'authorization', seedFingerprint: undefined }) });
  await authorized.connection.publish('Hello');
  assert.equal(authorized.fake.calls.at(-1).client, 'bearer:stored-access', 'authorized tokens are never overwritten by seeds');
});

test('uploads video through initialize, append, finalize and status with phase callbacks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'launchpad-video-'));
  const path = join(directory, 'demo.mp4');
  await writeFile(path, Buffer.alloc(5 * 1024 * 1024 + 10, 1));

  try {
    const { connection, fake } = connectionWith(oauth2Env);
    const phases = [];
    const result = await connection.uploadVideo({
      path,
      mimeType: 'video/mp4',
      size: 5 * 1024 * 1024 + 10,
      onPhase: (phase, progress) => phases.push({ phase, ...progress })
    });

    assert.equal(result.mediaId, '1880028106020515840');
    assert.ok(Date.parse(result.expiresAt) > Date.now());

    const init = fake.calls.find((call) => call.url === 'media/upload/initialize');
    assert.deepEqual(init.body, { media_type: 'video/mp4', total_bytes: 5 * 1024 * 1024 + 10, media_category: 'tweet_video' });
    const appends = fake.calls.filter((call) => call.url === 'media/upload/1880028106020515840/append');
    assert.equal(appends.length, 2);
    assert.deepEqual(appends.map((call) => call.body.segment_index), [0, 1]);
    assert.equal(appends[0].body.media.length, 4 * 1024 * 1024);
    assert.equal(appends[1].body.media.length, 1024 * 1024 + 10);
    assert.equal(appends[0].requestOptions.forceBodyMode, 'form-data');
    assert.ok(fake.calls.some((call) => call.url === 'media/upload/1880028106020515840/finalize'));
    const statusCalls = fake.calls.filter((call) => call.method === 'get');
    assert.equal(statusCalls.length, 2);
    assert.deepEqual(statusCalls[0].params, { command: 'STATUS', media_id: '1880028106020515840' });

    assert.deepEqual(phases.map((entry) => entry.phase), ['uploading', 'uploading', 'uploading', 'processing', 'processing']);
    assert.equal(phases[2].uploadedBytes, 5 * 1024 * 1024 + 10);
    assert.equal(phases[4].progressPercent, 50);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('media processing failures surface as MediaProcessingError with X’s message', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'launchpad-video-'));
  const path = join(directory, 'demo.mp4');
  await writeFile(path, Buffer.alloc(1024, 1));

  try {
    const { connection } = connectionWith(oauth2Env, { processing: 'failed' });
    await assert.rejects(
      connection.uploadVideo({ path, mimeType: 'video/mp4', size: 1024 }),
      (error) => error instanceof MediaProcessingError && /InvalidMedia/.test(error.message) && error.processingCode === 3
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('video upload requires an OAuth 2.0 connection', async () => {
  const { connection } = connectionWith(oauth1Env);
  await assert.rejects(
    connection.uploadVideo({ path: '/dev/null', mimeType: 'video/mp4', size: 1 }),
    (error) => error instanceof LaunchpadAuthError && error.kind === 'reconnect-required'
  );
});

test('authorization link requests every required scope at the configured callback', async () => {
  const { connection, fake } = connectionWith({ X_OAUTH2_CLIENT_ID: 'client-id', X_OAUTH2_CALLBACK_URL: 'http://127.0.0.1:4000/auth/x/callback' });
  const link = connection.beginAuthorization();
  assert.equal(link.state, 'abc');
  assert.equal(link.codeVerifier, 'verifier');
  assert.deepEqual(fake.calls[0].scope, ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access']);
  assert.equal(fake.calls[0].redirectUri, 'http://127.0.0.1:4000/auth/x/callback');

  const { connection: noClient } = connectionWith(oauth1Env);
  assert.throws(() => noClient.beginAuthorization(), (error) => error instanceof LaunchpadAuthError && error.kind === 'client-missing');
});

test('code exchange verifies the account, reports missing scopes and adopted tokens replace seeds', async () => {
  const { connection, fake, tokenStore } = connectionWith(oauth2Env, { grantScopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'] });
  await connection.describe();
  const result = await connection.exchangeAuthorizationCode({ code: 'code-123', codeVerifier: 'verifier' });

  assert.deepEqual(fake.calls.find((call) => call.method === 'loginWithOAuth2').args, {
    code: 'code-123',
    codeVerifier: 'verifier',
    redirectUri: 'http://127.0.0.1:3000/auth/x/callback'
  });
  assert.equal(result.account.username, 'junie_ai');
  assert.deepEqual(result.missingScopes, ['media.write']);
  assert.equal(result.tokens.source, 'authorization');
  assert.equal(result.tokens.accountId, user.id);
  assert.equal((await tokenStore.read()).accessToken, 'seed-access', 'tokens are not stored before the account check passes');

  await connection.adoptTokens(result.tokens);
  const stored = await tokenStore.read();
  assert.equal(stored.accessToken, 'authorized-access');
  assert.equal(stored.refreshToken, 'authorized-refresh');
  const info = await connection.describe();
  assert.equal(info.readiness.text.state, 'ready');
  assert.deepEqual(info.oauth2.missingScopes, ['media.write']);
});

test('token file is written with owner-only permissions in a private directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'launchpad-tokens-'));
  const tokenPath = join(directory, 'state', 'oauth2-tokens.json');

  try {
    const tokenStore = createFileStateStore(tokenPath);
    const { connection } = connectionWith(oauth2Env, {}, { tokenStore });
    await connection.describe();

    const fileStats = await stat(tokenPath);
    assert.equal(fileStats.mode & 0o777, 0o600);
    const directoryStats = await stat(join(directory, 'state'));
    assert.equal(directoryStats.mode & 0o077, 0);
    const written = JSON.parse(await readFile(tokenPath, 'utf8'));
    assert.equal(written.refreshToken, 'seed-refresh');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('classifies uncertain outcomes and sanitises errors for logs', () => {
  assert.equal(isUncertainOutcome(xRequestError('ETIMEDOUT')), true);
  assert.equal(isUncertainOutcome(xRequestError('ECONNRESET')), true);
  assert.equal(isUncertainOutcome(Object.assign(new Error('partial'), { type: 'partial-response' })), true);
  assert.equal(isUncertainOutcome(xRequestError('ECONNREFUSED')), false);
  assert.equal(isUncertainOutcome(xRequestError('ENOTFOUND')), false);
  assert.equal(isUncertainOutcome(xResponseError(500, 'boom')), false);
  assert.equal(isUncertainOutcome(xResponseError(403, 'nope')), false);

  const leaky = Object.assign(new Error('Request failed with code 401'), {
    type: 'response',
    code: 401,
    headers: { authorization: 'Bearer SECRET-ACCESS-TOKEN' },
    data: { title: 'Unauthorized', detail: 'Unauthorized', errors: [{ message: 'bad token' }] }
  });
  Object.defineProperty(leaky, 'request', { value: { getHeaders: () => ({ authorization: 'OAuth oauth_token="SECRET-OAUTH"' }) } });
  const summary = summarizeError(leaky);
  const serialised = JSON.stringify(summary) + inspect(summary, { depth: 5 });
  assert.equal(serialised.includes('SECRET'), false);
  assert.equal(summary.code, 401);
  assert.equal(summary.detail, 'Unauthorized');
  assert.deepEqual(summary.errors, ['bad token']);
});
