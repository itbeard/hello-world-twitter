import { TwitterApi } from 'twitter-api-v2';

const credentialNames = [
  'X_API_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN',
  'X_ACCESS_TOKEN_SECRET'
];

export function createXPublisher(environment = process.env) {
  const missingCredentials = credentialNames.filter((name) => !environment[name]?.trim());

  if (missingCredentials.length > 0) {
    return null;
  }

  const client = new TwitterApi({
    appKey: environment.X_API_KEY,
    appSecret: environment.X_API_SECRET,
    accessToken: environment.X_ACCESS_TOKEN,
    accessSecret: environment.X_ACCESS_TOKEN_SECRET
  }).readWrite;

  return {
    async publish(message) {
      const response = await client.v2.tweet(message);
      return {
        id: response.data.id,
        text: response.data.text,
        url: `https://x.com/i/web/status/${response.data.id}`
      };
    }
  };
}