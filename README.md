# Junie Launchpad

*An unnecessarily good app for a first post.*

A private, single-account publishing app built for one visible moment: Junie opens it in a browser, checks that the right X account is connected, presses **Publish to X**, waits for the real API answer, and opens the post on X while `/demo` records everything. Afterwards the same app uploads that recording to X and publishes it as a video reply to the saved first post.

Two steps, one screen each:

1. **First post** — editable text (prefilled), live preview, X-accurate character counting, one publish button, confirmed result with the real post ID and an **Open on X** link.
2. **Demo reply** — pick the finished MP4, preview it, check it against X's requirements, and publish it as a reply to the stored post through X's chunked media upload (`initialize → append → finalize → status`).

Credentials and tokens never reach the browser or the logs; the server only ever returns account names, IDs and safe error messages.

## How authentication works

| Purpose | Preferred | Fallback |
| --- | --- | --- |
| Connection check (`GET /2/users/me`) | OAuth 2.0 user token | OAuth 1.0a user context |
| First post (`POST /2/tweets`) | OAuth 2.0 user token | OAuth 1.0a user context |
| Video upload (`POST /2/media/upload/*`) and reply | OAuth 2.0 user token with `media.write` | — |

- **OAuth 2.0 is preferred whenever usable tokens exist.** Tokens come either from the credential file (`X_OAUTH2_ACCESS_TOKEN` / `X_OAUTH2_REFRESH_TOKEN`, e.g. the user Access Token and Refresh Token shown in the Developer Console) or from the in-app **Connect / Reconnect X** flow (OAuth 2.0 Authorization Code with PKCE). Existing valid tokens are used directly — no browser authorization is required just to use them.
- **Refresh is automatic.** Access tokens are refreshed before they expire and once after a `401`; the response's replacement refresh token is persisted immediately. Refreshes are serialised so a rotated refresh token is never used twice.
- **Scopes are verified, not assumed.** Seeded tokens have unknown scopes, so the first connection check performs one refresh to read the `scope` X returns and stores it. The UI then shows whether **Text posts** and **Video uploads** are `ready`, `unverified`, or `blocked` with the missing scope. Refreshing never adds scopes: if `media.write` is missing, use **Connect / Reconnect X**, which requests exactly `tweet.read tweet.write users.read media.write offline.access` and checks what X actually granted.
- **The account is verified before every publication** with `GET /2/users/me`. Set `X_EXPECTED_ACCOUNT_ID` and the server refuses to publish (or to store OAuth 2.0 tokens) for any other account. The video reply is additionally refused unless the OAuth 2.0 account is the one that published the first post.
- **OAuth 1.0a keeps working** for the connection check and text posts when no OAuth 2.0 tokens are usable. The App-Only Bearer Token is never used for user actions.

## Prerequisites

- Node.js 20 or newer (the demo base image satisfies this).
- An X developer app with **User authentication settings** enabled:
  - App permissions: **Read and write**.
  - Type of app: **Web App, Automated App or Bot** (a confidential client, so a Client Secret exists).
  - **Callback URI / Redirect URL:** `http://127.0.0.1:3000/auth/x/callback` — register it exactly like this. X does not accept `localhost`; use `127.0.0.1`. If you run on another port, register that URL and set `X_OAUTH2_CALLBACK_URL` to the same value.
  - Website URL: any valid `https://` URL (required by the console, not used by the app).
- X may require an eligible API access plan. On the Free tier `GET /2/users/me` is limited to 25 requests per user per 24 hours; the app calls it once per start (cached) and once per authorization, so avoid restarting against real credentials in a loop — use `npm run dev:fake` for UI work.

## Configure

1. Create the private credential file and fill it in from `.env.example`:

   ```bash
   mkdir -p "$HOME/.config/hello-world-twitter" "$HOME/.local/state/hello-world-twitter"
   cp .env.example "$HOME/.config/hello-world-twitter/x.env"
   chmod 600 "$HOME/.config/hello-world-twitter/x.env"
   chmod 700 "$HOME/.local/state/hello-world-twitter"
   ```

2. In `x.env` set at least `X_OAUTH2_CLIENT_ID` and `X_OAUTH2_CLIENT_SECRET`. Add `X_OAUTH2_ACCESS_TOKEN` and `X_OAUTH2_REFRESH_TOKEN` if you already have user tokens for the publishing account; add the four OAuth 1.0a values if you want the text fallback. Do not quote values.

3. Start the app once. While the guard is off, the **First post** step shows the exact `X_EXPECTED_ACCOUNT_ID=<id>` line for the connected account (the ID is also the tooltip of the account name). Put it into `x.env` and restart.

| Variable | Meaning |
| --- | --- |
| `X_OAUTH2_CLIENT_ID`, `X_OAUTH2_CLIENT_SECRET` | OAuth 2.0 client of the developer app (needed for refresh and for Connect / Reconnect X). |
| `X_OAUTH2_ACCESS_TOKEN`, `X_OAUTH2_REFRESH_TOKEN` | Optional seed tokens. They are copied into the token store on first start; afterwards the store is the source of truth, and a *changed* seed replaces it. |
| `X_OAUTH2_CALLBACK_URL` | Defaults to `http://127.0.0.1:3000/auth/x/callback`; must equal the registered callback. |
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` | OAuth 1.0a fallback for text posts. |
| `X_EXPECTED_ACCOUNT_ID` | Numeric user ID allowed to publish. Empty means any connected account (the UI says so). |
| `LAUNCHPAD_STATE_DIR` | Writable state directory. Default `${XDG_STATE_HOME:-$HOME/.local/state}/hello-world-twitter`. |
| `LAUNCHPAD_FAKE_X` | Set to `1` for a mocked X connection (development only). |

### Persistent storage

Everything writable lives in `LAUNCHPAD_STATE_DIR`, outside the repository and separate from the read-only credential file:

- `publication.json` — the first post (ID, text, account ID and username, publication time), an unresolved attempt if X never answered, the processed media ID awaiting a reply, and the reply itself.
- `oauth2-tokens.json` — access token, refresh token, expiry, granted scopes, and source (`environment` or `authorization`). Written with mode `0600`, replaced atomically on every refresh.
- `uploads/` — temporary copies of the selected video, deleted after each job.

Keep this directory until the video reply is published: it holds the original post ID and link.

## Run locally

```bash
npm install                       # also bundles twitter-text for the browser (public/vendor/)
set -a; source "$HOME/.config/hello-world-twitter/x.env"; set +a
npm run dev -- --host 127.0.0.1
```

Open <http://127.0.0.1:3000>. The header shows the connected account, the auth method, and readiness for text posts and video uploads. **Publish to X** performs a real external write when clicked.

Without credentials, or to rehearse the interface: `npm run dev:fake` (mocked X, realistic delays, no network calls). `LAUNCHPAD_FAKE_PUBLISH=timeout`, `LAUNCHPAD_FAKE_PROCESSING=failed`, `LAUNCHPAD_FAKE_REPLY=forbidden` and `LAUNCHPAD_FAKE_SCOPES="tweet.read users.read"` simulate the failure paths.

### Connect / Reconnect X

Click **Connect / Reconnect X** in the header. The server generates a PKCE verifier and a random `state`, redirects to `https://x.com/i/oauth2/authorize` with the five scopes, and handles `GET /auth/x/callback`:

1. The `state` must match a pending authorization started less than 10 minutes ago (single use, so replays fail).
2. The code is exchanged for tokens with the client secret and the PKCE verifier.
3. The granted scopes are read from X's response; missing ones are reported in the UI.
4. The account is verified with `GET /2/users/me`. Tokens are stored only if it matches `X_EXPECTED_ACCOUNT_ID` (when set) and the account that published the first post (when one exists).

Complete this locally before recording; the resulting token file is what the demo VM uses.

## Publishing rules

- Text is validated with the same rules X uses (`twitter-text`): links weigh 23, emoji and most non-Latin characters weigh 2, the limit is 280 weighted characters. The counter in the editor and the server agree.
- Duplicate protection is server-side: a saved post, an in-flight request, or an unresolved attempt all make `POST /api/posts` answer `409`. The button is disabled as well, but the server is the guard.
- **Unknown outcomes are preserved.** If the request times out or the connection drops after sending, the app records the attempt and blocks further publishing. Nothing is retried automatically: check the account on X and choose **It was published** (paste the link or ID) or **Nothing was published** in the UI.
- Errors are explained in plain language: missing credentials, rejected credentials (`401`), insufficient permissions or duplicate content (`403`), rate limits (`429`), unreachable API, and X-side media processing failures.

## Video reply

The reply attaches the real video: the server hashes the file, calls `POST /2/media/upload/initialize` (`media_category: tweet_video`), appends 4 MiB chunks, finalizes, and polls `GET /2/media/upload?command=STATUS` until X reports `succeeded` (or fails with X's reason). Then it creates the reply with `reply.in_reply_to_tweet_id` and `media.media_ids`.

- The UI shows **Uploading video** (percentage), **Processing video**, **Publishing reply**, **Published**, or the failure reason. Progress is polled from the server, so a page reload during a job resumes the live view.
- A processed media ID is stored with the file fingerprint and expiry. If the reply step fails, retrying with the same file skips the upload; an expired or rejected media ID is uploaded again.
- Client-side checks before upload: MP4/MOV, ≤ 512 MB, 0.5 s–20 min (warning above 140 s), ≥ 32×32, aspect ratio between 1:3 and 3:1 (warning above 1920×1200). The server enforces type and size again.

Documentation used: [chunked media upload](https://docs.x.com/x-api/media/quickstart/media-upload-chunked), [initialize media upload](https://docs.x.com/x-api/media/initialize-media-upload), [OAuth 2.0 Authorization Code with PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code).

## Test

```bash
npm test
```

Tests use fake X connections and never contact X. They cover account mismatch, duplicate and concurrent submissions, uncertain outcomes and their resolution, OAuth 2.0 preference and 1.0a fallback, token seeding, refresh with rotation and scope discovery, PKCE state validation and account checks, chunked upload phases, media processing failure, media reuse after a failed reply, expired uploads, error mapping, and the full interface flow.

## Record with `/demo`

`.junie/demo.md` contains the launch command and two scenarios (first post, then video reply). `.junie/vms/template-vm/mounts` gives the VM the credential file read-only at `/workspace/.env` and the host state directory read-write at `/workspace/.data`, so the published post and rotated tokens survive the VM. Finish **Connect / Reconnect X** locally first; the recording never shows credentials or the terminal.

## HTTP API

| Route | Purpose |
| --- | --- |
| `GET /api/status` | Connection info, verified account, guard result, saved post/pending/media/reply, current reply job, blockers. |
| `POST /api/posts` `{ text }` | Publish the first post (`201`), or `400/403/409/5xx` with an explanation. |
| `POST /api/posts/pending/resolve` `{ outcome, postId? }` | Resolve an unknown outcome as `published` or `not-published`. |
| `POST /api/replies` (multipart `video`, `text`) | Start the video reply job (`202`). |
| `GET /api/replies/progress` | Live job phase, saved reply, reusable media. |
| `GET /auth/x/start`, `GET /auth/x/callback` | OAuth 2.0 Authorization Code with PKCE. |
