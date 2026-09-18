import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileStateStore, createMemoryStateStore } from '../src/stateStore.js';

test('file store creates its directory, writes atomically with owner-only permissions and reads back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'launchpad-state-'));
  const path = join(directory, 'nested', 'publication.json');

  try {
    const store = createFileStateStore(path);
    assert.deepEqual(await store.read(), {});
    await store.write({ post: { id: '1' } });
    assert.deepEqual(await store.read(), { post: { id: '1' } });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(directory, 'nested')), ['publication.json']);
    assert.match(await readFile(path, 'utf8'), /"id": "1"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('update serialises concurrent read-modify-write cycles', async () => {
  const store = createMemoryStateStore({ counter: 0 });
  await Promise.all(Array.from({ length: 25 }, () => store.update(async (state) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return { ...state, counter: state.counter + 1 };
  })));
  assert.equal((await store.read()).counter, 25);
});

test('update keeps the mutated state when the callback returns nothing', async () => {
  const store = createMemoryStateStore({ items: [] });
  await store.update((state) => {
    state.items.push('a');
  });
  assert.deepEqual((await store.read()).items, ['a']);
});
