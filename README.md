# Hello World for X

A small private web app that publishes exactly `Hello World` through the X API v2. X credentials remain on the server and are never sent to the browser.

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

## Test

```bash
npm test
```

Tests use an injected fake publisher and never contact X.

## Record with `/demo`

The demo VM reads the same credential file through a read-only bind mount. Once the X app and credentials are ready, run `/demo`, review the prepared launch steps, and ask it to publish the prefilled message once. The resulting recording is produced by the `/demo` workflow.