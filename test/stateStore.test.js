import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileStateStore } from '../src/stateStore.js';

test('file state store starts empty and persists publication data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'junie-launchpad-'));
  const filePath = join(directory, 'publication.json');

  try {
    const store = createFileStateStore(filePath);
    assert.deepEqual(await store.read(), {});

    const state = {
      post: { id: '123', url: 'https://x.com/i/web/status/123' },
      reply: { id: '456', url: 'https://x.com/i/web/status/456' }
    };
    await store.write(state);

    assert.deepEqual(await store.read(), state);
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).post.id, '123');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});