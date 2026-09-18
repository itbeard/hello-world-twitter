vm: template-vm

## Running inside the VM

Install dependencies, load the read-only X credentials, and launch the web app:

    npm install && npm run dev -- --host 0.0.0.0 &
    # ready when http://localhost:3000/health responds 200

## Demo flow

Open http://localhost:3000. Confirm the status says “X API ready”, show the prefilled “Hello World” message, click “Post to X” exactly once, and wait for the success result. Open the returned X link to demonstrate that the real post was created. Do not click the post button again.