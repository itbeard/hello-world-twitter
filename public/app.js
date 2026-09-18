const publishButton = document.querySelector('#publish');
const buttonText = document.querySelector('#button-text');
const connection = document.querySelector('#connection');
const connectionText = document.querySelector('#connection-text');
const result = document.querySelector('#result');

function showResult(message, type, link) {
  result.className = `result ${type}`;
  result.replaceChildren(document.createTextNode(message));

  if (link) {
    result.append(' ');
    const anchor = document.createElement('a');
    anchor.href = link;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = 'View it on X ↗';
    result.append(anchor);
  }

  result.hidden = false;
}

async function checkStatus() {
  try {
    const response = await fetch('/api/status');
    const status = await response.json();

    connection.classList.add(status.configured ? 'connected' : 'missing');
    connectionText.textContent = status.configured ? 'X API ready' : 'Credentials needed';
    publishButton.disabled = !status.configured;

    if (!status.configured) {
      showResult('Add the four X credentials described in the README, then restart the app.', 'error');
    }
  } catch {
    connection.classList.add('missing');
    connectionText.textContent = 'Server unavailable';
    showResult('Could not reach the server. Refresh after it has started.', 'error');
  }
}

publishButton.addEventListener('click', async () => {
  publishButton.disabled = true;
  buttonText.textContent = 'Posting…';
  result.hidden = true;

  try {
    const response = await fetch('/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello World' })
    });
    const body = await response.json();

    if (!response.ok) {
      throw new Error(body.error || 'The post could not be created.');
    }

    buttonText.textContent = 'Posted';
    showResult(`Post ${body.post.id} was created successfully.`, 'success', body.post.url);
  } catch (error) {
    buttonText.textContent = 'Try again';
    publishButton.disabled = false;
    showResult(error.message, 'error');
  }
});

checkStatus();