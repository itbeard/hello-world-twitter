import 'dotenv/config';
import { join } from 'node:path';
import { createApp } from './app.js';
import { createFileStateStore } from './stateStore.js';
import { createXPublisher } from './xPublisher.js';

function commandLineValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const port = Number(process.env.PORT || 3000);
const host = commandLineValue('--host') || process.env.HOST || '127.0.0.1';
const publisher = createXPublisher();
const stateFile = process.env.POST_STATE_FILE || join(process.cwd(), '.data', 'publication.json');
const store = createFileStateStore(stateFile);
const app = createApp({ publisher, store });

app.listen(port, host, () => {
  console.log(`Junie Launchpad listening at http://${host}:${port}`);
  console.log(`X credentials: ${publisher ? 'configured' : 'missing'}`);
});