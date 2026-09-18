import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../src/app.js';

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

test('health endpoint reports readiness', async () => {
  await withServer(createApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });
});

test('status endpoint does not claim missing credentials are configured', async () => {
  await withServer(createApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/status`);

    assert.deepEqual(await response.json(), { configured: false });
  });
});

test('post endpoint accepts only the fixed demo message', async () => {
  const publisher = { publish: async () => assert.fail('publisher should not be called') };

  await withServer(createApp({ publisher }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'A different message' })
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Message must be exactly “Hello World”.' });
  });
});

test('post endpoint fails safely when credentials are missing', async () => {
  await withServer(createApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello World' })
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'X credentials are not configured.' });
  });
});

test('post endpoint returns the created post', async () => {
  const publisher = {
    publish: async (message) => ({
      id: '123456789',
      text: message,
      url: 'https://x.com/i/web/status/123456789'
    })
  };

  await withServer(createApp({ publisher }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello World' })
    });

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      post: {
        id: '123456789',
        text: 'Hello World',
        url: 'https://x.com/i/web/status/123456789'
      }
    });
  });
});

test('post endpoint converts X authorization errors to safe responses', async () => {
  const publisher = { publish: async () => Promise.reject({ code: 401, privateData: 'hidden' }) };
  const logger = { error() {} };

  await withServer(createApp({ publisher, logger }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello World' })
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'X rejected the credentials.' });
  });
});