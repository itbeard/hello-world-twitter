import { randomBytes } from 'node:crypto';
import {
  LaunchpadAuthError,
  MediaProcessingError,
  defaultCallbackUrl,
  requiredScopes,
  textScopes,
  videoScopes
} from './xConnection.js';

export const fakeAccount = {
  id: '1000000000000000001',
  name: 'Junie',
  username: 'junie_ai',
  avatarUrl: null
};

export function xResponseError(code, detail) {
  return Object.assign(new Error(`Request failed with code ${code}`), {
    type: 'response',
    code,
    data: { title: detail, detail, status: code }
  });
}

export function xRequestError(code = 'ETIMEDOUT') {
  return Object.assign(new Error(`Request failed (${code})`), {
    type: 'request',
    requestError: { code }
  });
}

function scenarioError(scenario) {
  switch (scenario) {
    case 'unauthorized':
      return xResponseError(401, 'Unauthorized');
    case 'forbidden':
      return xResponseError(403, 'Your client app is not configured with the appropriate permissions for this endpoint.');
    case 'rate-limited':
      return xResponseError(429, 'Too Many Requests');
    case 'server-error':
      return xResponseError(503, 'Service Unavailable');
    case 'timeout':
      return xRequestError('ETIMEDOUT');
    case 'network-down':
      return xRequestError('ECONNREFUSED');
    case 'media-expired':
      return xResponseError(400, 'The media_ids attribute is invalid or has expired.');
    default:
      return null;
  }
}

function fakeId() {
  return `19${Date.now()}${Math.floor(Math.random() * 900 + 100)}`;
}

export function createFakeXConnection({
  auth = 'oauth2',
  clientConfigured = true,
  scopes = requiredScopes,
  account = fakeAccount,
  authorizeAs = null,
  grantScopes = requiredScopes,
  accountScenario = 'ok',
  publish: publishScenario = 'ok',
  processing = 'ok',
  reply: replyScenario = 'ok',
  latency = 0,
  callbackUrl = defaultCallbackUrl,
  now = () => Date.now()
} = {}) {
  const state = { auth, scopes, account, publishScenario, processing, replyScenario, accountScenario };
  const calls = [];

  function delay(factor) {
    return latency > 0 ? new Promise((resolve) => setTimeout(resolve, latency * factor)) : Promise.resolve();
  }

  function readiness(wanted, unavailableReason) {
    if (state.auth === 'none') {
      return { state: 'unavailable', reason: unavailableReason };
    }

    if (state.auth === 'oauth1') {
      return wanted === textScopes
        ? { state: 'ready', reason: null, auth: 'oauth1' }
        : { state: 'unavailable', reason: unavailableReason };
    }

    if (!Array.isArray(state.scopes)) {
      return { state: 'unverified', reason: 'Granted scopes are not verified yet. Use Connect / Reconnect X to confirm them.', auth: 'oauth2' };
    }

    const missing = wanted.filter((scope) => !state.scopes.includes(scope));
    return missing.length > 0
      ? { state: 'unavailable', reason: `The OAuth 2.0 token lacks ${missing.join(', ')}. Use Connect / Reconnect X.`, auth: 'oauth2' }
      : { state: 'ready', reason: null, auth: 'oauth2' };
  }

  async function describe() {
    const connected = state.auth === 'oauth2';
    const missingScopes = Array.isArray(state.scopes) ? requiredScopes.filter((scope) => !state.scopes.includes(scope)) : null;

    return {
      auth: state.auth === 'none' ? null : state.auth,
      oauth1: { configured: state.auth === 'oauth1' },
      oauth2: {
        clientConfigured,
        connected,
        source: connected ? 'fake' : null,
        scopes: Array.isArray(state.scopes) ? state.scopes : null,
        missingScopes,
        refreshable: connected,
        expiresAt: null,
        invalidReason: null,
        reconnectRequired: clientConfigured && (!connected || (missingScopes?.length ?? 0) > 0),
        callbackUrl,
        requiredScopes
      },
      readiness: {
        text: readiness(textScopes, 'No X credentials are configured. Add OAuth 2.0 tokens or the OAuth 1.0a keys.'),
        video: readiness(videoScopes, 'Video uploads need an OAuth 2.0 connection with media.write. Use Connect / Reconnect X.')
      }
    };
  }

  async function getAccount() {
    calls.push({ method: 'getAccount' });
    await delay(2);

    if (state.auth === 'none') {
      throw new LaunchpadAuthError('not-configured', 'X credentials are not configured.');
    }

    const error = scenarioError(state.accountScenario);
    if (error) {
      throw error;
    }

    return { ...state.account };
  }

  async function publish(text) {
    calls.push({ method: 'publish', text });
    await delay(8);

    const error = scenarioError(state.publishScenario);
    if (error) {
      throw error;
    }

    return { id: fakeId(), text };
  }

  async function uploadVideo({ size, onPhase = () => {} }) {
    calls.push({ method: 'uploadVideo', size });
    const steps = 4;

    for (let step = 0; step <= steps; step += 1) {
      onPhase('uploading', { uploadedBytes: Math.round((size * step) / steps), totalBytes: size });
      await delay(3);
    }

    for (let step = 0; step < 3; step += 1) {
      onPhase('processing', { progressPercent: Math.round(((step + 1) / 3) * 100) });
      await delay(4);
    }

    if (state.processing === 'failed') {
      throw new MediaProcessingError('InvalidMedia: Unsupported video codec.', { code: 3 });
    }

    return { mediaId: fakeId(), expiresAt: new Date(now() + 86_400_000).toISOString() };
  }

  async function publishReply({ text, postId, mediaId }) {
    calls.push({ method: 'publishReply', text, postId, mediaId });
    await delay(6);

    const error = scenarioError(state.replyScenario);
    if (error) {
      throw error;
    }

    return { id: fakeId(), text };
  }

  function beginAuthorization() {
    const authorizationState = randomBytes(16).toString('hex');
    const url = `${callbackUrl}?state=${authorizationState}&code=fake-authorization-code`;
    return { url, codeVerifier: 'fake-code-verifier', state: authorizationState };
  }

  async function exchangeAuthorizationCode({ code }) {
    calls.push({ method: 'exchangeAuthorizationCode' });
    await delay(3);

    if (code !== 'fake-authorization-code') {
      throw xResponseError(400, 'Value passed for the authorization code was invalid.');
    }

    const authorizedAccount = { ...(authorizeAs || state.account) };
    return {
      tokens: {
        accessToken: 'fake-access-token',
        refreshToken: 'fake-refresh-token',
        expiresAt: new Date(now() + 7_200_000).toISOString(),
        scope: [...grantScopes],
        source: 'authorization',
        accountId: authorizedAccount.id,
        username: authorizedAccount.username,
        authorizedAt: new Date(now()).toISOString(),
        updatedAt: new Date(now()).toISOString()
      },
      account: authorizedAccount,
      scopes: [...grantScopes],
      missingScopes: requiredScopes.filter((scope) => !grantScopes.includes(scope))
    };
  }

  async function adoptTokens(tokens) {
    calls.push({ method: 'adoptTokens' });
    state.auth = 'oauth2';
    state.scopes = tokens.scope;
    if (authorizeAs) {
      state.account = { ...authorizeAs };
    }
  }

  return {
    calls,
    state,
    callbackUrl,
    describe,
    verifyConnection: getAccount,
    getAccount,
    publish,
    publishReply,
    uploadVideo,
    beginAuthorization,
    exchangeAuthorizationCode,
    adoptTokens
  };
}
