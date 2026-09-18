import 'dotenv/config';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { createFakeXConnection } from './fakeX.js';
import { createFileStateStore } from './stateStore.js';
import { createXConnection } from './xConnection.js';

function commandLineValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export function defaultStateDirectory(env = process.env) {
  if (env.LAUNCHPAD_STATE_DIR?.trim()) {
    return env.LAUNCHPAD_STATE_DIR.trim();
  }

  const xdgStateHome = env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
  return join(xdgStateHome, 'hello-world-twitter');
}

const port = Number(process.env.PORT || 3000);
const host = commandLineValue('--host') || process.env.HOST || '127.0.0.1';
const stateDirectory = defaultStateDirectory();
const store = createFileStateStore(join(stateDirectory, 'publication.json'));
const tokenStore = createFileStateStore(join(stateDirectory, 'oauth2-tokens.json'));
const fakeMode = Boolean(process.env.LAUNCHPAD_FAKE_X?.trim());
const connection = fakeMode
  ? createFakeXConnection({
    latency: 250,
    scopes: process.env.LAUNCHPAD_FAKE_SCOPES === 'unverified'
      ? null
      : process.env.LAUNCHPAD_FAKE_SCOPES
        ? process.env.LAUNCHPAD_FAKE_SCOPES.split(/\s+/).filter(Boolean)
        : undefined,
    publish: process.env.LAUNCHPAD_FAKE_PUBLISH || 'ok',
    processing: process.env.LAUNCHPAD_FAKE_PROCESSING || 'ok',
    reply: process.env.LAUNCHPAD_FAKE_REPLY || 'ok'
  })
  : createXConnection({ tokenStore });
const app = createApp({
  connection,
  store,
  uploadDirectory: join(stateDirectory, 'uploads'),
  expectedAccountId: process.env.X_EXPECTED_ACCOUNT_ID
});

app.listen(port, host, async () => {
  const info = await connection.describe();
  console.log(`Junie Launchpad listening at http://${host}:${port}`);
  console.log(`State directory: ${stateDirectory}`);
  console.log(`X mode: ${fakeMode ? 'FAKE (no real requests)' : info.auth ? info.auth : 'not configured'}`);
  console.log(`OAuth 2.0 callback URL: ${info.oauth2.callbackUrl}`);
  console.log(`Expected account ID: ${process.env.X_EXPECTED_ACCOUNT_ID?.trim() || 'not set (any connected account may publish)'}`);
});
