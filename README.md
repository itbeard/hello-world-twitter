# Junie Launchpad

A private, single-account publishing app built for one visible moment: press **Publish to X**, wait for the real API response, and open the post on X. The post text is editable, the authenticated account and avatar come from X, and credentials never leave the server.

After `/demo` produces the recording, the same app can upload that MP4 or MOV, wait for X to process it, and publish it as a reply to the saved original post.

## Prerequisites

- Node.js 20 or newer
- An X developer account and an app with **Read and write** permission
- OAuth 1.0a API Key and Secret plus an Access Token and Secret for the X account that will publish

X may require an eligible API access plan. Never commit or paste credentials into source control, issues, or chat.

## Configure X

1. Open the [X Developer Console](https://console.x.com/) and create a developer app.
2. Set the app permission to **Read and write**.
3. Generate or regenerate the user Access Token and Secret after enabling write permission.
4. Create the private credential file:

   ```bash
   mkdir -p "$HOME/.config/hello-world-twitter"
   cp .env.example "$HOME/.config/hello-world-twitter/x.env"
   chmod 600 "$HOME/.config/hello-world-twitter/x.env"
   ```

5. Edit `$HOME/.config/hello-world-twitter/x.env` and fill in all four values. Do not add quotes unless they are part of the value.

## Run locally

```bash
npm install
set -a
source "$HOME/.config/hello-world-twitter/x.env"
set +a
npm run dev -- --host 127.0.0.1
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The button performs a real external write and creates one public post when clicked.

The first successful result is stored in `.data/publication.json`. The server and browser both refuse another original post once that file contains a post, including overlapping clicks. Keep this file until the recording has been published as a reply because it holds the original post ID and link.

## Test

```bash
npm test
```

Tests use an injected fake publisher and never contact X. They cover editable text validation, persistence, duplicate protection, concurrent clicks, and video-reply handling.

## Record with `/demo`

The demo VM reads the same credential file through a read-only bind mount. Once the X app and credentials are ready, run `/demo`; `.junie/demo.md` contains the approved 30–40 second story. It publishes the prefilled `Hello World` once, waits for X, and opens the real post. The reply upload is intentionally not part of that recording.

## Publish the recording as a reply

1. Finish `/demo` and locate its generated MP4 or MOV.
2. Start Junie Launchpad again with the same credentials and working directory. The saved post should restore as **Published**.
3. Expand **Add the /demo recording**, select the video, review the prefilled reply, and click **Publish video reply** once.
4. Leave the page open while X uploads and processes the video. Open **View reply** only after the API confirms success.

The server uses X's chunked media workflow through `twitter-api-v2`: upload, finalize, wait for processing, then attach the returned media ID to a v2 reply. See the [X chunked media guide](https://docs.x.com/x-api/media/quickstart/media-upload-chunked).

The prefilled reply is:

```text
And here’s how that happened.

My own app, my own Publish button, and a recording of me using it.

Meet /demo: https://junie.jetbrains.com/blog/demo-agent/
```