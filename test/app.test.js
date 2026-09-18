import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../src/app.js';

function createStore(initialState = {}) {
  let state = structuredClone(initialState);

  return {
    async read() {
      return structuredClone(state);
    },
    async write(nextState) {
      state = structuredClone(nextState);
    }
  };
}

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

test('status endpoint returns configuration and saved publication state', async () => {
  const post = {
    id: '123456789',
    text: 'Hello World',
    url: 'https://x.com/junie/status/123456789'
  };

  await withServer(createApp({ store: createStore({ post }) }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/status`);

    assert.deepEqual(await response.json(), { configured: false, account: null, post, reply: null });
  });
});

test('post endpoint rejects an empty message', async () => {
  const publisher = { publish: async () => assert.fail('publisher should not be called') };

  await withServer(createApp({ publisher, store: createStore() }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' })
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Message must contain between 1 and 280 characters.' });
  });
});

test('post endpoint counts Unicode characters and rejects messages over 280', async () => {
  const publisher = { publish: async () => assert.fail('publisher should not be called') };

  await withServer(createApp({ publisher, store: createStore() }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '🚀'.repeat(281) })
    });

    assert.equal(response.status, 400);
  });
});

test('post endpoint fails safely when credentials are missing', async () => {
  await withServer(createApp({ store: createStore() }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello World' })
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'X credentials are not configured.' });
  });
});

test('post endpoint publishes editable text and saves the created post', async () => {
  const store = createStore();
  const publisher = {
    publish: async (message) => ({
      id: '123456789',
      text: message,
      url: 'https://x.com/i/web/status/123456789'
    })
  };

  await withServer(createApp({ publisher, store }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Built and published by Junie.' })
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.deepEqual(body, {
      post: {
        id: '123456789',
        text: 'Built and published by Junie.',
        url: 'https://x.com/i/web/status/123456789'
      }
    });
    assert.deepEqual((await store.read()).post, body.post);
  });
});

test('post endpoint prevents publishing again when a post is already saved', async () => {
  const post = { id: '123', text: 'Already sent', url: 'https://x.com/i/web/status/123' };
  const publisher = { publish: async () => assert.fail('publisher should not be called') };

  await withServer(createApp({ publisher, store: createStore({ post }) }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Another post' })
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'This launch has already been published.', post });
  });
});

test('post endpoint locks concurrent publish attempts', async () => {
  let finishPublish;
  const publisher = {
    publish: () => new Promise((resolve) => {
      finishPublish = resolve;
    })
  };

  await withServer(createApp({ publisher, store: createStore() }), async (baseUrl) => {
    const first = fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'First' })
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Second' })
    });

    assert.equal(second.status, 409);
    finishPublish({ id: '1', text: 'First', url: 'https://x.com/i/web/status/1' });
    assert.equal((await first).status, 201);
  });
});

test('video reply endpoint uploads the recording and saves the reply', async () => {
  const post = { id: '123', text: 'Hello', url: 'https://x.com/junie/status/123' };
  const store = createStore({ post });
  const publisher = {
    publishReply: async ({ message, postId, videoPath, mediaType }) => {
      assert.equal(message, 'And here is the recording.');
      assert.equal(postId, '123');
      assert.equal(mediaType, 'video/mp4');
      assert.equal(typeof videoPath, 'string');
      return { id: '456', text: message, url: 'https://x.com/junie/status/456' };
    }
  };

  await withServer(createApp({ publisher, store }), async (baseUrl) => {
    const form = new FormData();
    form.append('message', 'And here is the recording.');
    form.append('video', new Blob(['video-data'], { type: 'video/mp4' }), 'demo.mp4');
    const response = await fetch(`${baseUrl}/api/replies`, { method: 'POST', body: form });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.reply.id, '456');
    assert.deepEqual((await store.read()).reply, body.reply);
  });
});

test('video reply endpoint requires the original post and an MP4 or MOV file', async () => {
  const publisher = { publishReply: async () => assert.fail('publisher should not be called') };

  await withServer(createApp({ publisher, store: createStore() }), async (baseUrl) => {
    const noPostForm = new FormData();
    noPostForm.append('message', 'Reply');
    noPostForm.append('video', new Blob(['video'], { type: 'video/mp4' }), 'demo.mp4');
    const noPostResponse = await fetch(`${baseUrl}/api/replies`, { method: 'POST', body: noPostForm });
    assert.equal(noPostResponse.status, 409);
  });

  await withServer(createApp({ publisher, store: createStore({ post: { id: '123' } }) }), async (baseUrl) => {
    const wrongTypeForm = new FormData();
    wrongTypeForm.append('message', 'Reply');
    wrongTypeForm.append('video', new Blob(['video'], { type: 'video/webm' }), 'demo.webm');
    const wrongTypeResponse = await fetch(`${baseUrl}/api/replies`, { method: 'POST', body: wrongTypeForm });
    assert.equal(wrongTypeResponse.status, 400);
    assert.deepEqual(await wrongTypeResponse.json(), { error: 'Choose an MP4 or MOV video.' });
  });
});

test('post endpoint converts X authorization errors to safe responses', async () => {
  const publisher = { publish: async () => Promise.reject({ code: 401, privateData: 'hidden' }) };
  const logger = { error() {} };

  await withServer(createApp({ publisher, logger, store: createStore() }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello World' })
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'X rejected the credentials.' });
  });
});