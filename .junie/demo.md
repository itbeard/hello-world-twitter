vm: template-vm

## Running inside the VM

Preflight (fail fast instead of clicking into a dead app):

    test -s /workspace/.env || { echo "Missing credential mount: $HOME/.config/hello-world-twitter/x.env"; exit 1; }
    test -d /workspace/.data || { echo "Missing state mount: $HOME/.local/state/hello-world-twitter"; exit 1; }

Install dependencies and launch Junie Launchpad (Express, port 3000). The credential file is
mounted read-only at `/workspace/.env`; the writable state directory (`publication.json`,
`oauth2-tokens.json`, uploads) is the host directory mounted at `/workspace/.data`, so the
published post survives the VM:

    npm install
    LAUNCHPAD_STATE_DIR=/workspace/.data npm run dev -- --host 0.0.0.0 &
    # ready when http://localhost:3000/health responds 200

Do not set `LAUNCHPAD_FAKE_X` here: the recording must talk to the real X API.

## Before recording

Complete these on the host, not in the VM, so nothing sensitive appears on screen:

- OAuth 2.0 tokens for the publishing account exist in `$HOME/.local/state/hello-world-twitter/oauth2-tokens.json`
  (seeded from the credential file or created with **Connect / Reconnect X**). For the video
  scenario the token must include `media.write`; the app's **Video uploads** indicator shows `ready`.
- `X_EXPECTED_ACCOUNT_ID` in the credential file matches the account shown in the app.
- Never open the credential file, the state directory, or the terminal output during a recording.
  Credential values are never rendered by the UI; the terminal is not part of the story.

## Scenario 1 — Publish the first post (30–40 seconds)

Introductory slide: *I built my own publishing app.*

1. Open http://localhost:3000. Wait until the connection card in the top-right shows the account
   name and `@username` (verified via `GET /2/users/me`) and the state pill reads **Ready to launch**.
2. Point at the account and the prefilled text in the preview card. Do not edit the text.
3. Click **Publish to X** exactly once. Leave the **Publishing…** state and the API wait at normal
   speed; do not cut it.
4. Wait until the headline changes to **Hello, X.**, the pill reads **Published**, and the post ID,
   time and **Open on X** button appear.
5. Click **Open on X** and show the real post on X. This transition is the strongest moment — keep
   it at normal speed.

Do not open the **Demo reply** step in this recording. Closing slide: *Built by Junie. Published by
Junie. Recorded with /demo.*

## Scenario 2 — Publish the video reply (after the first recording exists)

Preconditions: Scenario 1 has finished, the first post is saved (the app restores **Published** on
load), and the finished MP4 from Scenario 1 is available inside the VM (mount it or copy it to
`/workspace/.data/` before launching).

1. Open http://localhost:3000/#reply (or click the **Demo reply** step). The pill should read
   **Ready · choose the recording**; the **Video uploads** indicator in the header must be `ready`.
2. Click **Choose the /demo recording (MP4)** and select the finished recording. Wait for the preview
   and the requirement checks (format, size, duration, dimensions) to show green marks. Play a second
   of the preview.
3. Review the prefilled reply text; do not change it.
4. Click **Publish video reply** once. The states **Uploading video** (with percentage),
   **Processing video**, **Publishing reply** and finally **Published** reflect real API progress.
5. Click **Open on X** and show the reply with the embedded video under the first post.

If the job fails, the message explains why and whether the processed video is preserved for a retry;
retrying is a manual click, never automatic.
