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
  let accountPromise;

  async function getAccount() {
    if (!accountPromise) {
      accountPromise = client.v2.me({
        'user.fields': ['name', 'username', 'profile_image_url']
      }).then(({ data }) => ({
        id: data.id,
        name: data.name,
        username: data.username,
        avatarUrl: data.profile_image_url?.replace('_normal.', '_200x200.') || null
      })).catch((error) => {
        accountPromise = undefined;
        throw error;
      });
    }

    return accountPromise;
  }

  function publishedPost(response) {
    return {
      id: response.data.id,
      text: response.data.text,
      url: `https://x.com/i/web/status/${response.data.id}`
    };
  }

  return {
    getAccount,

    async publish(message) {
      const response = await client.v2.tweet(message);
      return publishedPost(response);
    },

    async publishReply({ message, postId, videoPath, mediaType }) {
      const mediaId = await client.v1.uploadMedia(videoPath, {
        type: mediaType === 'video/quicktime' ? 'mov' : 'mp4',
        mimeType: mediaType,
        target: 'tweet'
      });
      const response = await client.v2.reply(message, postId, {
        media: { media_ids: [mediaId] }
      });
      return publishedPost(response);
    }
  };
}