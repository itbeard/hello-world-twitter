import 'dotenv/config';
import { createApp } from './app.js';
import { createXPublisher } from './xPublisher.js';

function commandLineValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const port = Number(process.env.PORT || 3000);
const host = commandLineValue('--host') || process.env.HOST || '127.0.0.1';
const publisher = createXPublisher();
const app = createApp({ publisher });

app.listen(port, host, () => {
  console.log(`Hello World X app listening at http://${host}:${port}`);
  console.log(`X credentials: ${publisher ? 'configured' : 'missing'}`);
});