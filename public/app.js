const message = document.querySelector('#message');
const characterCount = document.querySelector('#character-count');
const publishButton = document.querySelector('#publish');
const buttonText = document.querySelector('#button-text');
const state = document.querySelector('#publication-state');
const stateText = document.querySelector('#state-text');
const title = document.querySelector('#page-title');
const result = document.querySelector('#result');
const viewPost = document.querySelector('#view-post');
const recordingPanel = document.querySelector('#recording-panel');
const avatar = document.querySelector('#avatar');
const avatarFallback = document.querySelector('#avatar-fallback');
const accountName = document.querySelector('#account-name');
const accountHandle = document.querySelector('#account-handle');
const replyForm = document.querySelector('#reply-form');
const replyMessage = document.querySelector('#reply-message');
const video = document.querySelector('#video');
const fileLabel = document.querySelector('#file-label');
const publishReply = document.querySelector('#publish-reply');
const replyResult = document.querySelector('#reply-result');

let configured = false;
let published = false;
let publishing = false;
let replyPublished = false;

function characters(value) {
  return [...value];
}

function resizeTextarea(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function updateComposer() {
  const count = characters(message.value).length;
  characterCount.textContent = `${count} / 280`;
  characterCount.classList.toggle('over-limit', count > 280);
  publishButton.disabled = !configured || published || publishing || !message.value.trim() || count > 280;
  resizeTextarea(message);
}

function showError(text) {
  result.textContent = text;
  result.className = 'result error';
  result.hidden = false;
}

function showAccount(account) {
  if (!account) return;
  accountName.textContent = account.name;
  accountHandle.textContent = `@${account.username}`;
  avatarFallback.textContent = account.name.slice(0, 1).toUpperCase();

  if (account.avatarUrl) {
    avatar.src = account.avatarUrl;
    avatar.alt = `${account.name} avatar`;
    avatar.hidden = false;
    avatarFallback.hidden = true;
  }
}

function showPublished(post) {
  published = true;
  message.value = post.text;
  message.disabled = true;
  title.textContent = 'Hello, X.';
  state.className = 'publication-state published';
  stateText.textContent = 'Published';
  publishButton.hidden = true;
  viewPost.href = post.url;
  viewPost.hidden = false;
  recordingPanel.hidden = false;
  result.hidden = true;
  document.body.classList.add('is-published');
  updateComposer();
}

function showReplyPublished(reply) {
  replyPublished = true;
  publishReply.disabled = true;
  video.disabled = true;
  replyMessage.disabled = true;
  replyResult.replaceChildren(document.createTextNode('Video reply published. '));
  const link = document.createElement('a');
  link.href = reply.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'View reply ↗';
  replyResult.append(link);
  replyResult.className = 'reply-result success';
  replyResult.hidden = false;
}

async function checkStatus() {
  try {
    const response = await fetch('/api/status');
    const status = await response.json();
    if (!response.ok) throw new Error(status.error || 'Could not connect to X.');

    configured = status.configured;
    showAccount(status.account);

    if (status.post) {
      showPublished(status.post);
      if (status.reply) showReplyPublished(status.reply);
      return;
    }

    state.classList.add(status.configured ? 'ready' : 'missing');
    stateText.textContent = status.configured ? 'Ready to launch' : 'Credentials needed';
    if (!status.configured) {
      accountName.textContent = 'X account not connected';
      accountHandle.textContent = 'Add credentials to begin';
      showError('Add the four X credentials described in the README, then restart the app.');
    }
    updateComposer();
  } catch (error) {
    state.classList.add('missing');
    stateText.textContent = 'Connection unavailable';
    showError(error.message);
  }
}

message.addEventListener('input', () => {
  if (characters(message.value).length > 280) {
    message.value = characters(message.value).slice(0, 280).join('');
  }
  updateComposer();
});

publishButton.addEventListener('click', async () => {
  if (publishing || published) return;
  publishing = true;
  buttonText.textContent = 'Publishing…';
  state.className = 'publication-state working';
  stateText.textContent = 'Talking to X API';
  result.hidden = true;
  updateComposer();

  try {
    const response = await fetch('/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message.value })
    });
    const body = await response.json();
    if (!response.ok) {
      if (body.post) showPublished(body.post);
      throw new Error(body.error || 'The post could not be created.');
    }
    showPublished(body.post);
  } catch (error) {
    if (!published) {
      publishing = false;
      buttonText.textContent = 'Try again';
      state.className = 'publication-state missing';
      stateText.textContent = 'Not published';
      showError(error.message);
      updateComposer();
    }
  }
});

video.addEventListener('change', () => {
  fileLabel.textContent = video.files[0]?.name || 'Choose the finished MP4 or MOV';
  publishReply.disabled = replyPublished || !video.files.length || !replyMessage.value.trim();
});

replyMessage.addEventListener('input', () => {
  resizeTextarea(replyMessage);
  publishReply.disabled = replyPublished || !video.files.length || !replyMessage.value.trim()
    || characters(replyMessage.value).length > 280;
});

replyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (publishReply.disabled) return;

  publishReply.disabled = true;
  publishReply.textContent = 'Uploading & processing…';
  replyResult.hidden = true;

  try {
    const form = new FormData();
    form.append('message', replyMessage.value);
    form.append('video', video.files[0]);
    const response = await fetch('/api/replies', { method: 'POST', body: form });
    const body = await response.json();
    if (!response.ok) {
      if (body.reply) showReplyPublished(body.reply);
      throw new Error(body.error || 'The video reply could not be published.');
    }
    showReplyPublished(body.reply);
  } catch (error) {
    if (!replyPublished) {
      publishReply.disabled = false;
      publishReply.textContent = 'Try publishing again';
      replyResult.textContent = error.message;
      replyResult.className = 'reply-result error';
      replyResult.hidden = false;
    }
  }
});

resizeTextarea(replyMessage);
updateComposer();
checkStatus();