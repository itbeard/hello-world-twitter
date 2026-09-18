import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function withUpdate(store) {
  let queue = Promise.resolve();

  store.update = (mutate) => {
    const next = queue.then(async () => {
      const state = await store.read();
      const result = await mutate(state);
      await store.write(result === undefined ? state : result);
      return result === undefined ? state : result;
    });
    queue = next.catch(() => {});
    return next;
  };

  return store;
}

export function createFileStateStore(filePath) {
  return withUpdate({
    path: filePath,

    async read() {
      try {
        return JSON.parse(await readFile(filePath, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') {
          return {};
        }

        throw error;
      }
    },

    async write(state) {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, filePath);
    }
  });
}

export function createMemoryStateStore(initialState = {}) {
  let state = structuredClone(initialState);

  return withUpdate({
    path: null,

    async read() {
      return structuredClone(state);
    },

    async write(nextState) {
      state = structuredClone(nextState);
    }
  });
}
