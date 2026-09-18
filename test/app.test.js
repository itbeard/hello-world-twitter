import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { createFakeXConnection, fakeAccount } from '../src/fakeX.js';
import { createMemoryStateStore } from '../src/stateStore.js';
import { demoReplyText, firstPostText } from '../src/textRules.js';

const quietLogger = { error() {}, log() {} };
const savedPost = {
  id: '1900000000000000001',
  text: firstPostText,
  url: 'https://x.com/junie_ai/status/1900000000000000001',
  accountId: fakeAccount.id,
  accountUsername: fakeAccount.username,
  publishedAt: '2026-09-18T10:00:00.000Z'
};

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function postJson(baseUrl, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function videoForm(text = demoReplyText, { type = 'video/mp4', bytes = 'video-bytes', name = 'demo.mp4' } = {}) {
  const form = new FormData();
  form.append('text', text);
  form.append('video', new Blob([bytes], { type }), name);
  return form;
}

async function waitForJob(baseUrl) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const body = await (await fetch(`${baseUrl}/api/replies/progress`)).json();
    if (body.job && ['published', 'failed'].includes(body.job.phase)) {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('reply job did not finish');
}

function appWith(overrides = {}) {
  return createApp({ logger: quietLogger, store: createMemoryStateStore(), ...overrides });
}

test('health endpoint reports readiness', async () => {
  await withServer(appWith(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });
});

test('status explains missing credentials without claiming a connection', async () => {
  await withServer(appWith(), async (baseUrl) => {
    const status = await (await fetch(`${baseUrl}/api/status`)).json();
    assert.equal(status.connection.auth, null);
    assert.equal(status.account, null);
    assert.match(status.blockers.text, /No X credentials are configured/);
    assert.equal(status.connection.oauth2.clientConfigured, false);
  });
});

test('status verifies the account with the connection and returns saved state', async () => {
  const connection = createFakeXConnection();
  const store = createMemoryStateStore({ post: savedPost });

  await withServer(appWith({ connection, store }), async (baseUrl) => {
    const status = await (await fetch(`${baseUrl}/api/status`)).json();
    assert.equal(status.account.username, 'junie_ai');
    assert.equal(status.connection.auth, 'oauth2');
    assert.deepEqual(status.post, savedPost);
    assert.equal(status.blockers.text, null);
    assert.equal(status.blockers.video, null);
    assert.deepEqual(status.guard, { expectedAccountId: null, matches: null });
    assert.equal(connection.calls.filter((call) => call.method === 'getAccount').length, 1);
  });
});

test('status reports unverified readiness for seeded tokens with unknown scopes', async () => {
  const connection = createFakeXConnection({ scopes: null });

  await withServer(appWith({ connection }), async (baseUrl) => {
    const status = await (await fetch(`${baseUrl}/api/status`)).json();
    assert.equal(status.connection.readiness.text.state, 'unverified');
    assert.equal(status.connection.readiness.video.state, 'unverified');
    assert.equal(status.blockers.text, null);
  });
});

test('status surfaces authentication failures from the connection check', async () => {
  const connection = createFakeXConnection({ accountScenario: 'unauthorized' });

  await withServer(appWith({ connection }), async (baseUrl) => {
    const status = await (await fetch(`${baseUrl}/api/status`)).json();
    assert.equal(status.account, null);
    assert.match(status.accountError, /rejected the credentials \(401\)/);
    assert.equal(status.blockers.text, status.accountError);
  });
});

test('account mismatch blocks publishing on the server', async () => {
  const connection = createFakeXConnection();

  await withServer(appWith({ connection, expectedAccountId: '424242' }), async (baseUrl) => {
    const status = await (await fetch(`${baseUrl}/api/status`)).json();
    assert.equal(status.guard.matches, false);
    assert.match(status.blockers.text, /does not match X_EXPECTED_ACCOUNT_ID=424242/);

    const response = await postJson(baseUrl, '/api/posts', { text: firstPostText });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /@junie_ai \(ID 1000000000000000001\) does not match/);
    assert.equal(connection.calls.some((call) => call.method === 'publish'), false);
  });
});

test('matching expected account allows publishing', async () => {
  const connection = createFakeXConnection();

  await withServer(appWith({ connection, expectedAccountId: fakeAccount.id }), async (baseUrl) => {
    const response = await postJson(baseUrl, '/api/posts', { text: firstPostText });
    assert.equal(response.status, 201);
  });
});

test('post endpoint validates text with X weighting rules', async () => {
  const connection = createFakeXConnection();

  await withServer(appWith({ connection }), async (baseUrl) => {
    const empty = await postJson(baseUrl, '/api/posts', { text: '   ' });
    assert.equal(empty.status, 400);

    const withUrl = `${'a'.repeat(257)} https://junie.jetbrains.com/blog/demo-agent/some/very/long/path/that/is/shortened`;
    const overWeight = await postJson(baseUrl, '/api/posts', { text: withUrl });
    assert.equal(overWeight.status, 400);
    assert.equal((await overWeight.json()).weightedLength, 281);

    const fitsBecauseUrlWeighs23 = await postJson(baseUrl, '/api/posts', { text: `${'a'.repeat(256)} https://junie.jetbrains.com/blog/demo-agent/some/very/long/path/that/is/shortened` });
    assert.equal(fitsBecauseUrlWeighs23.status, 201);
  });
});

test('post endpoint fails safely when credentials are missing', async () => {
  await withServer(appWith(), async (baseUrl) => {
    const response = await postJson(baseUrl, '/api/posts', { text: 'Hello' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'X credentials are not configured.' });
  });
});

test('post endpoint publishes and persists id, account, text and time', async () => {
  const connection = createFakeXConnection();
  const store = createMemoryStateStore();

  await withServer(appWith({ connection, store }), async (baseUrl) => {
    const response = await postJson(baseUrl, '/api/posts', { text: firstPostText });
    assert.equal(response.status, 201);
    const { post } = await response.json();
    assert.match(post.id, /^\d+$/);
    assert.equal(post.text, firstPostText);
    assert.equal(post.url, `https://x.com/junie_ai/status/${post.id}`);
    assert.equal(post.accountId, fakeAccount.id);
    assert.equal(post.accountUsername, 'junie_ai');
    assert.ok(Date.parse(post.publishedAt) > 0);
    assert.deepEqual((await store.read()).post, post);
  });
});

test('duplicate submissions are refused once a post is saved', async () => {
  const connection = createFakeXConnection();

  await withServer(appWith({ connection, store: createMemoryStateStore({ post: savedPost }) }), async (baseUrl) => {
    const response = await postJson(baseUrl, '/api/posts', { text: 'Another post' });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, 'The first post has already been published.');
    assert.deepEqual(body.post, savedPost);
    assert.equal(connection.calls.some((call) => call.method === 'publish'), false);
  });
});

test('concurrent publish attempts are serialised by the server lock', async () => {
  const connection = createFakeXConnection();
  let finishPublish;
  connection.publish = () => new Promise((resolve) => {
    finishPublish = resolve;
  });

  await withServer(appWith({ connection }), async (baseUrl) => {
    const first = postJson(baseUrl, '/api/posts', { text: 'First' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await postJson(baseUrl, '/api/posts', { text: 'Second' });
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error, 'Publication is already in progress.');

    finishPublish({ id: '1900000000000000002', text: 'First' });
    assert.equal((await first).status, 201);

    const third = await postJson(baseUrl, '/api/posts', { text: 'Third' });
    assert.equal(third.status, 409);
  });
});

test('uncertain outcomes are preserved and never retried automatically', async () => {
  const connection = createFakeXConnection({ publish: 'timeout' });
  const store = createMemoryStateStore();

  await withServer(appWith({ connection, store }), async (baseUrl) => {
    const response = await postJson(baseUrl, '/api/posts', { text: firstPostText });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error, /did not confirm whether the post was created/);
    assert.equal(body.pending.text, firstPostText);
    assert.equal(body.pending.accountUsername, 'junie_ai');
    assert.equal((await store.read()).pending.text, firstPostText);

    connection.state.publishScenario = 'ok';
    const blocked = await postJson(baseUrl, '/api/posts', { text: firstPostText });
    assert.equal(blocked.status, 409);
    assert.match((await blocked.json()).error, /unknown outcome/);
    assert.equal(connection.calls.filter((call) => call.method === 'publish').length, 1);

    const status = await (await fetch(`${baseUrl}/api/status`)).json();
    assert.equal(status.pending.text, firstPostText);
    assert.equal(status.post, null);
  });
});

test('an uncertain attempt can be resolved as published with the real link', async () => {
  const connection = createFakeXConnection({ publish: 'timeout' });
  const store = createMemoryStateStore();

  await withServer(appWith({ connection, store }), async (baseUrl) => {
    await postJson(baseUrl, '/api/posts', { text: firstPostText });
    const rejected = await postJson(baseUrl, '/api/posts/pending/resolve', { outcome: 'published', postId: 'not a link' });
    assert.equal(rejected.status, 400);

    const resolved = await postJson(baseUrl, '/api/posts/pending/resolve', {
      outcome: 'published',
      postId: 'https://x.com/junie_ai/status/1900000000000000009'
    });
    assert.equal(resolved.status, 200);
    const { post } = await resolved.json();
    assert.equal(post.id, '1900000000000000009');
    assert.equal(post.text, firstPostText);
    assert.equal(post.confirmedManually, true);
    const state = await store.read();
    assert.equal(state.pending, undefined);
    assert.equal(state.post.id, '1900000000000000009');
  });
});

test('an uncertain attempt can be cleared as not published and then retried manually', async () => {
  const connection = createFakeXConnection({ publish: 'timeout' });
  const store = createMemoryStateStore();

  await withServer(appWith({ connection, store }), async (baseUrl) => {
    await postJson(baseUrl, '/api/posts', { text: firstPostText });
    const cleared = await postJson(baseUrl, '/api/posts/pending/resolve', { outcome: 'not-published' });
    assert.equal(cleared.status, 200);
    assert.equal((await store.read()).pending, undefined);

    connection.state.publishScenario = 'ok';
    const retry = await postJson(baseUrl, '/api/posts', { text: firstPostText });
    assert.equal(retry.status, 201);
  });
});

test('definite network failures do not create an uncertain attempt', async () => {
  const connection = createFakeXConnection({ publish: 'network-down' });
  const store = createMemoryStateStore();

  await withServer(appWith({ connection, store }), async (baseUrl) => {
    const response = await postJson(baseUrl, '/api/posts', { text: firstPostText });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /Could not reach the X API/);
    assert.equal((await store.read()).pending, undefined);
  });
});

test('X authorization, permission and rate-limit errors become understandable responses', async () => {
  for (const [scenario, status, pattern] of [
    ['unauthorized', 401, /rejected the credentials \(401\)/],
    ['forbidden', 403, /refused the post \(403\).*tweet\.write/],
    ['rate-limited', 429, /rate limit/],
    ['server-error', 502, /unavailable right now \(503\)/]
  ]) {
    const connection = createFakeXConnection({ publish: scenario });
    await withServer(appWith({ connection }), async (baseUrl) => {
      const response = await postJson(baseUrl, '/api/posts', { text: firstPostText });
      assert.equal(response.status, status, scenario);
      assert.match((await response.json()).error, pattern, scenario);
    });
  }
});

test('token without tweet.write blocks text publishing with a reconnect hint', async () => {
  const connection = createFakeXConnection({ scopes: ['tweet.read', 'users.read'] });

  await withServer(appWith({ connection }), async (baseUrl) => {
    const status = await (await fetch(`${baseUrl}/api/status`)).json();
    assert.equal(status.connection.readiness.text.state, 'unavailable');
    assert.match(status.blockers.text, /lacks tweet\.write.*Connect \/ Reconnect X/);
    const response = await postJson(baseUrl, '/api/posts', { text: firstPostText });
    assert.equal(response.status, 403);
  });
});

test('video reply uploads through the chunked flow, reports phases and saves the reply', async () => {
  const connection = createFakeXConnection();
  const store = createMemoryStateStore({ post: savedPost });
  const uploadDirectory = await mkdtemp(join(tmpdir(), 'launchpad-uploads-'));

  try {
    await withServer(appWith({ connection, store, uploadDirectory }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/replies`, { method: 'POST', body: videoForm() });
      assert.equal(response.status, 202);
      const { job } = await response.json();
      assert.equal(job.phase, 'uploading');
      assert.equal(job.fileName, 'demo.mp4');

      const finished = await waitForJob(baseUrl);
      assert.equal(finished.job.phase, 'published');
      assert.equal(finished.job.reusedMedia, false);
      assert.equal(finished.reply.text, demoReplyText);
      assert.equal(finished.reply.postId, savedPost.id);
      assert.equal(finished.media, null);

      const replyCall = connection.calls.find((call) => call.method === 'publishReply');
      assert.equal(replyCall.postId, savedPost.id);
      assert.match(replyCall.mediaId, /^\d+$/);
      const state = await store.read();
      assert.equal(state.reply.id, finished.reply.id);
      assert.equal(state.media, undefined);
    });
    assert.deepEqual(await readdir(uploadDirectory), []);
  } finally {
    await rm(uploadDirectory, { recursive: true, force: true });
  }
});

test('media processing failure fails the job and discards the broken upload', async () => {
  const connection = createFakeXConnection({ processing: 'failed' });
  const store = createMemoryStateStore({ post: savedPost });

  await withServer(appWith({ connection, store }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/replies`, { method: 'POST', body: videoForm() });
    assert.equal(response.status, 202);
    const finished = await waitForJob(baseUrl);
    assert.equal(finished.job.phase, 'failed');
    assert.equal(finished.job.failedDuring, 'upload');
    assert.match(finished.job.error, /could not process the video: InvalidMedia/);
    assert.equal(finished.job.mediaPreserved, false);
    assert.equal(finished.media, null);
    assert.equal((await store.read()).reply, undefined);
    assert.equal(connection.calls.some((call) => call.method === 'publishReply'), false);
  });
});

test('a processed upload is preserved after a failed reply and reused on retry', async () => {
  const connection = createFakeXConnection({ reply: 'forbidden' });
  const store = createMemoryStateStore({ post: savedPost });

  await withServer(appWith({ connection, store }), async (baseUrl) => {
    await fetch(`${baseUrl}/api/replies`, { method: 'POST', body: videoForm() });
    const failed = await waitForJob(baseUrl);
    assert.equal(failed.job.phase, 'failed');
    assert.equal(failed.job.failedDuring, 'reply');
    assert.equal(failed.job.mediaPreserved, true);
    assert.equal(failed.media.fileName, 'demo.mp4');
    assert.ok(Date.parse(failed.media.expiresAt) > Date.now());

    connection.state.replyScenario = 'ok';
    const retry = await fetch(`${baseUrl}/api/replies`, { method: 'POST', body: videoForm() });
    assert.equal(retry.status, 202);
    const published = await waitForJob(baseUrl);
    assert.equal(published.job.phase, 'published');
    assert.equal(published.job.reusedMedia, true);
    assert.equal(connection.calls.filter((call) => call.method === 'uploadVideo').length, 1);
    assert.equal(connection.calls.filter((call) => call.method === 'publishReply').length, 2);
  });
});

test('an expired stored upload is uploaded again', async () => {
  const connection = createFakeXConnection();
  const store = createMemoryStateStore({
    post: savedPost,
    media: { id: '1', fingerprint: 'stale', mimeType: 'video/mp4', fileName: 'demo.mp4', size: 1, expiresAt: '2000-01-01T00:00:00.000Z' }
  });

  await withServer(appWith({ connection, store }), async (baseUrl) => {
    await fetch(`${baseUrl}/api/replies`, { method: 'POST', body: videoForm() });
    const finished = await waitForJob(baseUrl);
    assert.equal(finished.job.phase, 'published');
    assert.equal(finished.job.reusedMedia, false);
    assert.equal(connection.calls.filter((call) => call.method === 'uploadVideo').length, 1);
  });
});

test('video reply validates prerequisites, file type and authorization', async () => {
  const withoutPost = createFakeXConnection();
  await withServer(appWith({ connection: withoutPost }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/replies`, { method: 'POST', body: videoForm() });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /Publish the first post/);
  });

  const wrongType = createFakeXConnection();
  await withServer(appWith({ connection: wrongType, store: createMemoryStateStore({ post: savedPost }) }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/replies`, { method: 'POST', body: videoForm(demoReplyText, { type: 'video/webm', name: 'demo.webm' }) });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Choose an MP4 or MOV video.' });
  });

  const oauth1Only = createFakeXConnection({ auth: 'oauth1' });
  await withServer(appWith({ connection: oauth1Only, store: createMemoryStateStore({ post: savedPost }) }), async (baseUrl) => {
    const status = await (await fetch(`${baseUrl}/api/status`)).json();
    assert.equal(status.connection.readiness.text.state, 'ready');
    assert.match(status.blockers.video, /OAuth 2.0 connection with media\.write/);
    const response = await fetch(`${baseUrl}/api/replies`, { method: 'POST', body: videoForm() });
    assert.equal(response.status, 403);
  });

  const missingMediaScope = createFakeXConnection({ scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'] });
  await withServer(appWith({ connection: missingMediaScope, store: createMemoryStateStore({ post: savedPost }) }), async (baseUrl) => {
    const status = await (await fetch(`${baseUrl}/api/status`)).json();
    assert.match(status.blockers.video, /lacks media\.write/);
    assert.equal(status.connection.oauth2.reconnectRequired, true);
  });
});

test('video reply refuses an OAuth 2.0 account that did not publish the first post', async () => {
  const connection = createFakeXConnection({ account: { id: '777', name: 'Other', username: 'other', avatarUrl: null } });

  await withServer(appWith({ connection, store: createMemoryStateStore({ post: savedPost }) }), async (baseUrl) => {
    const status = await (await fetch(`${baseUrl}/api/status`)).json();
    assert.match(status.blockers.video, /@other is not the account that published the first post \(@junie_ai\)/);
    const response = await fetch(`${baseUrl}/api/replies`, { method: 'POST', body: videoForm() });
    assert.equal(response.status, 403);
    assert.equal(connection.calls.some((call) => call.method === 'uploadVideo'), false);
  });
});

test('OAuth 2.0 authorization validates state, verifies the account and stores tokens', async () => {
  const connection = createFakeXConnection({ auth: 'none', clientConfigured: true });

  await withServer(appWith({ connection }), async (baseUrl) => {
    const start = await fetch(`${baseUrl}/auth/x/start`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const authorizeUrl = new URL(start.headers.get('location'));
    const state = authorizeUrl.searchParams.get('state');
    assert.ok(state);

    const forged = await fetch(`${baseUrl}/auth/x/callback?state=forged&code=fake-authorization-code`, { redirect: 'manual' });
    assert.equal(new URL(forged.headers.get('location'), baseUrl).searchParams.get('reason'), 'state');

    const callback = await fetch(`${baseUrl}/auth/x/callback?state=${state}&code=fake-authorization-code`, { redirect: 'manual' });
    const landing = new URL(callback.headers.get('location'), baseUrl);
    assert.equal(landing.searchParams.get('auth'), 'success');
    assert.equal(landing.searchParams.get('account'), 'junie_ai');
    assert.equal(landing.searchParams.get('missing'), null);
    assert.equal(connection.calls.some((call) => call.method === 'adoptTokens'), true);

    const replay = await fetch(`${baseUrl}/auth/x/callback?state=${state}&code=fake-authorization-code`, { redirect: 'manual' });
    assert.equal(new URL(replay.headers.get('location'), baseUrl).searchParams.get('reason'), 'state');

    const status = await (await fetch(`${baseUrl}/api/status`)).json();
    assert.equal(status.connection.auth, 'oauth2');
    assert.equal(status.connection.readiness.video.state, 'ready');
  });
});

test('OAuth 2.0 authorization reports missing scopes and refuses the wrong account', async () => {
  const partial = createFakeXConnection({ grantScopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'] });
  await withServer(appWith({ connection: partial }), async (baseUrl) => {
    const start = await fetch(`${baseUrl}/auth/x/start`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const callback = await fetch(`${baseUrl}/auth/x/callback?state=${state}&code=fake-authorization-code`, { redirect: 'manual' });
    const landing = new URL(callback.headers.get('location'), baseUrl);
    assert.equal(landing.searchParams.get('auth'), 'success');
    assert.equal(landing.searchParams.get('missing'), 'media.write');
    const status = await (await fetch(`${baseUrl}/api/status`)).json();
    assert.match(status.blockers.video, /lacks media\.write/);
  });

  const wrongAccount = createFakeXConnection({ authorizeAs: { id: '777', name: 'Other', username: 'other', avatarUrl: null } });
  await withServer(appWith({ connection: wrongAccount, store: createMemoryStateStore({ post: savedPost }) }), async (baseUrl) => {
    const start = await fetch(`${baseUrl}/auth/x/start`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const callback = await fetch(`${baseUrl}/auth/x/callback?state=${state}&code=fake-authorization-code`, { redirect: 'manual' });
    const landing = new URL(callback.headers.get('location'), baseUrl);
    assert.equal(landing.searchParams.get('reason'), 'mismatch');
    assert.match(landing.searchParams.get('detail'), /@other is not the account that published the first post/);
    assert.equal(wrongAccount.calls.some((call) => call.method === 'adoptTokens'), false);
  });

  const denied = createFakeXConnection();
  await withServer(appWith({ connection: denied }), async (baseUrl) => {
    const start = await fetch(`${baseUrl}/auth/x/start`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const callback = await fetch(`${baseUrl}/auth/x/callback?state=${state}&error=access_denied`, { redirect: 'manual' });
    assert.equal(new URL(callback.headers.get('location'), baseUrl).searchParams.get('reason'), 'denied');
  });
});

test('the full interface flow works against mocked X responses', async () => {
  const connection = createFakeXConnection();
  const store = createMemoryStateStore();

  await withServer(appWith({ connection, store, expectedAccountId: fakeAccount.id }), async (baseUrl) => {
    const page = await (await fetch(`${baseUrl}/`)).text();
    assert.match(page, /Junie Launchpad/);
    assert.match(page, /An unnecessarily good app for a first post\./);
    assert.match(page, /Publish to X/);
    assert.match(page, /Connect \/ Reconnect X/);
    assert.equal((await fetch(`${baseUrl}/vendor/twitter-text.js`)).status, 200);

    const initial = await (await fetch(`${baseUrl}/api/status`)).json();
    assert.equal(initial.guard.matches, true);
    assert.equal(initial.blockers.text, null);
    assert.match(initial.blockers.video, /Publish the first post/);

    const published = await postJson(baseUrl, '/api/posts', { text: firstPostText });
    assert.equal(published.status, 201);

    const afterPost = await (await fetch(`${baseUrl}/api/status`)).json();
    assert.equal(afterPost.post.text, firstPostText);
    assert.equal(afterPost.blockers.video, null);

    await fetch(`${baseUrl}/api/replies`, { method: 'POST', body: videoForm() });
    const finished = await waitForJob(baseUrl);
    assert.equal(finished.job.phase, 'published');

    const final = await (await fetch(`${baseUrl}/api/status`)).json();
    assert.equal(final.reply.postId, final.post.id);
    assert.equal(final.replyJob.phase, 'published');
    const again = await fetch(`${baseUrl}/api/replies`, { method: 'POST', body: videoForm() });
    assert.equal(again.status, 409);
  });
});
