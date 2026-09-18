(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    notice: $('notice'),
    avatar: $('avatar'),
    avatarFallback: $('avatar-fallback'),
    accountName: $('account-name'),
    accountHandle: $('account-handle'),
    readinessText: $('readiness-text'),
    readinessTextState: $('readiness-text-state'),
    readinessVideo: $('readiness-video'),
    readinessVideoState: $('readiness-video-state'),
    connectX: $('connect-x'),
    tabPost: $('tab-post'),
    tabReply: $('tab-reply'),
    badgePost: $('badge-post'),
    badgeReply: $('badge-reply'),
    panelPost: $('panel-post'),
    panelReply: $('panel-reply'),
    postTitle: $('post-title'),
    postState: $('post-state'),
    postStateText: $('post-state-text'),
    message: $('message'),
    characterCount: $('character-count'),
    previewAvatar: $('preview-avatar'),
    previewAvatarFallback: $('preview-avatar-fallback'),
    previewName: $('preview-name'),
    previewHandle: $('preview-handle'),
    previewText: $('preview-text'),
    previewMeta: $('preview-meta'),
    previewId: $('preview-id'),
    publish: $('publish'),
    publishLabel: $('publish-label'),
    openPost: $('open-post'),
    postFacts: $('post-facts'),
    postId: $('post-id'),
    postTime: $('post-time'),
    postAccount: $('post-account'),
    postResult: $('post-result'),
    pendingPanel: $('pending-panel'),
    pendingText: $('pending-text'),
    pendingForm: $('pending-form'),
    pendingPostId: $('pending-post-id'),
    pendingNotPublished: $('pending-not-published'),
    replyState: $('reply-state'),
    replyStateText: $('reply-state-text'),
    video: $('video'),
    filePicker: document.querySelector('.file-picker'),
    fileLabel: $('file-label'),
    videoPreview: $('video-preview'),
    videoChecks: $('video-checks'),
    replyMessage: $('reply-message'),
    replyCount: $('reply-count'),
    replyTo: $('reply-to'),
    publishReply: $('publish-reply'),
    publishReplyLabel: $('publish-reply-label'),
    openReply: $('open-reply'),
    replyProgress: $('reply-progress'),
    replyProgressBar: $('reply-progress-bar'),
    replyResult: $('reply-result')
  };

  const maxWeightedLength = 280;
  const maxVideoBytes = 512 * 1024 * 1024;
  const maxVideoSeconds = 20 * 60;
  const safeVideoSeconds = 140;
  const phaseLabels = {
    uploading: 'Uploading video',
    processing: 'Processing video',
    publishing: 'Publishing reply',
    published: 'Published',
    failed: 'Not published'
  };

  let status = null;
  let publishing = false;
  let replySubmitting = false;
  let pollTimer = null;
  let videoFacts = null;
  let previewUrl = null;

  function measure(text) {
    if (window.twitterText?.parseTweet) {
      const parsed = window.twitterText.parseTweet(text);
      return { weightedLength: parsed.weightedLength, valid: parsed.valid && text.trim().length > 0 };
    }

    const length = [...text].length;
    return { weightedLength: length, valid: text.trim().length > 0 && length <= maxWeightedLength };
  }

  function autosize(textarea) {
    if (textarea.getClientRects().length === 0) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }

  function setState(element, textElement, kind, text) {
    element.className = `publication-state ${kind}`;
    textElement.textContent = text;
  }

  function showResult(element, text, kind = 'error') {
    element.textContent = text || '';
    element.className = `result ${kind}`;
    element.hidden = !text;
  }

  function showNotice(text, kind = 'info') {
    els.notice.textContent = text;
    els.notice.className = `notice ${kind === 'error' ? 'error' : ''}`;
    els.notice.hidden = !text;
  }

  function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }

  function formatDate(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function renderRichText(container, text, placeholder) {
    container.replaceChildren();
    if (!text) {
      const span = document.createElement('span');
      span.className = 'placeholder';
      span.textContent = placeholder;
      container.append(span);
      return;
    }

    const urls = window.twitterText?.extractUrlsWithIndices ? window.twitterText.extractUrlsWithIndices(text) : [];
    let cursor = 0;
    for (const { indices: [start, end] } of urls) {
      container.append(document.createTextNode(text.slice(cursor, start)));
      const link = document.createElement('span');
      link.className = 'link';
      link.textContent = text.slice(start, end);
      container.append(link);
      cursor = end;
    }
    container.append(document.createTextNode(text.slice(cursor)));
  }

  function renderCounter(counter, text) {
    const measured = measure(text);
    counter.textContent = `${measured.weightedLength} / ${maxWeightedLength}`;
    counter.classList.toggle('over-limit', measured.weightedLength > maxWeightedLength);
    counter.classList.toggle('near-limit', measured.weightedLength <= maxWeightedLength && measured.weightedLength > maxWeightedLength - 20);
    return measured;
  }

  function renderAvatar(image, fallback, account) {
    fallback.textContent = account?.name ? account.name.slice(0, 1).toUpperCase() : '·';
    if (account?.avatarUrl) {
      image.src = account.avatarUrl;
      image.alt = `${account.name} avatar`;
      image.hidden = false;
      fallback.hidden = true;
    } else {
      image.hidden = true;
      image.removeAttribute('src');
      fallback.hidden = false;
    }
  }

  function authLabel(connection) {
    if (connection.auth === 'oauth2') return 'OAuth 2.0';
    if (connection.auth === 'oauth1') return 'OAuth 1.0a';
    return null;
  }

  function renderConnection(s) {
    const { account, connection } = s;
    renderAvatar(els.avatar, els.avatarFallback, account);
    renderAvatar(els.previewAvatar, els.previewAvatarFallback, account);

    if (account) {
      els.accountName.textContent = account.name;
      els.accountName.title = `Account ID ${account.id}`;
      els.accountHandle.textContent = `@${account.username} · ${authLabel(connection)} · verified via GET /2/users/me`;
      els.previewName.textContent = account.name;
      els.previewHandle.textContent = `@${account.username}`;
    } else if (s.accountError) {
      els.accountName.textContent = 'X connection failed';
      els.accountHandle.textContent = s.accountError;
      els.previewName.textContent = 'Account unavailable';
      els.previewHandle.textContent = '@…';
    } else {
      els.accountName.textContent = 'X is not connected';
      els.accountHandle.textContent = connection.oauth2.clientConfigured
        ? 'Use Connect / Reconnect X or add tokens to the credential file'
        : 'Add credentials to the credential file and restart';
      els.previewName.textContent = 'Your account';
      els.previewHandle.textContent = '@…';
    }

    const readinessLabel = { ready: 'ready', unverified: 'unverified', unavailable: 'blocked', checking: 'checking' };
    for (const [item, stateElement, readiness] of [
      [els.readinessText, els.readinessTextState, connection.readiness.text],
      [els.readinessVideo, els.readinessVideoState, connection.readiness.video]
    ]) {
      item.className = `readiness-item ${readiness.state}`;
      stateElement.textContent = readinessLabel[readiness.state] || readiness.state;
      item.title = readiness.reason || (readiness.auth ? `Ready via ${readiness.auth === 'oauth2' ? 'OAuth 2.0' : 'OAuth 1.0a'}` : '');
    }

    els.connectX.hidden = !connection.oauth2.clientConfigured;
    els.connectX.classList.toggle('attention', connection.oauth2.reconnectRequired || connection.readiness.video.state !== 'ready');
    els.connectX.title = connection.oauth2.scopes
      ? `Granted scopes: ${connection.oauth2.scopes.join(' ')}`
      : 'Starts OAuth 2.0 Authorization Code with PKCE and requests tweet.read tweet.write users.read media.write offline.access';
  }

  function selectTab(name) {
    const isPost = name === 'post';
    els.tabPost.setAttribute('aria-selected', String(isPost));
    els.tabReply.setAttribute('aria-selected', String(!isPost));
    els.tabPost.tabIndex = isPost ? 0 : -1;
    els.tabReply.tabIndex = isPost ? -1 : 0;
    els.panelPost.hidden = !isPost;
    els.panelReply.hidden = isPost;
    autosize(isPost ? els.message : els.replyMessage);
    window.history.replaceState({}, '', isPost ? window.location.pathname : '#reply');
  }

  function canPublishText() {
    return Boolean(status) && !status.post && !status.pending && !status.blockers.text;
  }

  function updateComposer() {
    const measured = renderCounter(els.characterCount, els.message.value);
    if (!status?.post) {
      renderRichText(els.previewText, els.message.value, 'Your post will appear here.');
    }
    els.publish.disabled = !canPublishText() || publishing || !measured.valid;
    autosize(els.message);
  }

  function showPublished(post) {
    els.postTitle.textContent = 'Hello, X.';
    els.postTitle.classList.add('arrived');
    setState(els.postState, els.postStateText, 'published', 'Published');
    els.message.value = post.text;
    els.message.disabled = true;
    renderCounter(els.characterCount, post.text);
    renderRichText(els.previewText, post.text, '');
    els.previewMeta.textContent = `Published · ${formatDate(post.publishedAt)}`;
    els.previewId.textContent = `ID ${post.id}`;
    els.previewId.hidden = false;
    els.publish.hidden = true;
    els.openPost.href = post.url;
    els.openPost.hidden = false;
    els.postId.textContent = post.id;
    els.postTime.textContent = formatDate(post.publishedAt);
    els.postAccount.textContent = post.accountUsername ? `@${post.accountUsername}` : post.accountId || '—';
    els.postFacts.hidden = false;
    els.pendingPanel.hidden = true;
    els.badgePost.textContent = 'Published';
    els.badgePost.className = 'step-badge done';
    showResult(els.postResult, '');
    autosize(els.message);
  }

  function renderPost(s) {
    if (s.post) {
      showPublished(s.post);
      return;
    }

    els.postTitle.textContent = 'Hello, world.';
    els.postTitle.classList.remove('arrived');
    els.message.disabled = false;
    els.previewMeta.textContent = 'Draft · Everyone can reply';
    els.previewId.hidden = true;
    els.openPost.hidden = true;
    els.postFacts.hidden = true;

    if (s.pending) {
      setState(els.postState, els.postStateText, 'blocked', 'Outcome unknown');
      els.publish.hidden = true;
      els.message.value = s.pending.text;
      els.message.disabled = true;
      els.pendingText.textContent = `An attempt started ${formatDate(s.pending.startedAt)} for @${s.pending.accountUsername}, but X never confirmed it.`;
      els.pendingPanel.hidden = false;
      els.badgePost.textContent = 'Unresolved';
      els.badgePost.className = 'step-badge blocked';
      showResult(els.postResult, '');
      updateComposer();
      return;
    }

    els.publish.hidden = false;
    els.pendingPanel.hidden = true;
    if (!publishing) {
      els.publishLabel.textContent = 'Publish to X';
      els.publish.classList.remove('working');
    }

    if (s.blockers.text) {
      setState(els.postState, els.postStateText, 'blocked', 'Publishing blocked');
      showResult(els.postResult, s.blockers.text);
      els.badgePost.textContent = 'Blocked';
      els.badgePost.className = 'step-badge blocked';
    } else if (!publishing) {
      const unverified = s.connection.readiness.text.state === 'unverified';
      setState(els.postState, els.postStateText, 'ready', unverified ? 'Ready · scopes unverified' : 'Ready to launch');
      const hints = [];
      if (unverified) hints.push(s.connection.readiness.text.reason);
      if (s.account && !s.guard.expectedAccountId) {
        hints.push(`Account guard is off. To pin publishing to @${s.account.username}, set X_EXPECTED_ACCOUNT_ID=${s.account.id} and restart.`);
      }
      showResult(els.postResult, hints.join(' '), 'info');
      els.badgePost.textContent = 'Draft';
      els.badgePost.className = 'step-badge';
    }

    updateComposer();
  }

  function videoReady() {
    return Boolean(videoFacts?.ok) && els.video.files.length > 0;
  }

  function jobActive(job) {
    return Boolean(job) && !['published', 'failed'].includes(job.phase);
  }

  function updateReplyComposer() {
    const measured = renderCounter(els.replyCount, els.replyMessage.value);
    const active = jobActive(status?.replyJob);
    els.publishReply.disabled = !status || Boolean(status.reply) || Boolean(status.blockers.video) || active || replySubmitting || !videoReady() || !measured.valid;
    autosize(els.replyMessage);
  }

  function renderProgress(job) {
    if (!jobActive(job)) {
      els.replyProgress.hidden = true;
      els.replyProgress.classList.remove('indeterminate');
      return;
    }

    els.replyProgress.hidden = false;
    let percent = null;
    if (job.phase === 'uploading' && job.totalBytes) {
      percent = Math.round((job.uploadedBytes / job.totalBytes) * 100);
    } else if (job.phase === 'processing' && typeof job.progressPercent === 'number') {
      percent = job.progressPercent;
    }

    els.replyProgress.classList.toggle('indeterminate', percent === null);
    els.replyProgressBar.style.width = percent === null ? '' : `${percent}%`;
    els.replyProgress.setAttribute('aria-valuenow', String(percent ?? 0));
  }

  function showReplyPublished(reply) {
    setState(els.replyState, els.replyStateText, 'published', 'Published');
    els.replyMessage.value = reply.text;
    els.replyMessage.disabled = true;
    renderCounter(els.replyCount, reply.text);
    els.video.disabled = true;
    els.filePicker.hidden = true;
    if (els.videoPreview.hidden) {
      const item = document.createElement('li');
      item.className = 'ok';
      item.textContent = `Video attached to the reply (media ${reply.mediaId}).`;
      els.videoChecks.replaceChildren(item);
      els.videoChecks.hidden = false;
    }
    els.publishReply.hidden = true;
    els.openReply.href = reply.url;
    els.openReply.hidden = false;
    els.replyTo.textContent = `Reply ID ${reply.id} · ${formatDate(reply.publishedAt)}`;
    els.badgeReply.textContent = 'Published';
    els.badgeReply.className = 'step-badge done';
    showResult(els.replyResult, '');
    renderProgress(null);
    autosize(els.replyMessage);
  }

  function renderReply(s) {
    els.replyTo.textContent = s.post ? `Replying to @${s.post.accountUsername} · post ${s.post.id}` : 'Replying to your first post';

    if (s.reply) {
      showReplyPublished(s.reply);
      return;
    }

    els.publishReply.hidden = false;
    els.openReply.hidden = true;
    const job = s.replyJob;
    renderProgress(job);

    if (jobActive(job)) {
      const suffix = job.phase === 'uploading' && job.totalBytes ? ` · ${Math.round((job.uploadedBytes / job.totalBytes) * 100)}%` : '';
      setState(els.replyState, els.replyStateText, 'working', `${phaseLabels[job.phase]}${suffix}`);
      els.publishReplyLabel.textContent = `${phaseLabels[job.phase]}…`;
      els.publishReply.classList.add('working');
      els.badgeReply.textContent = 'Working';
      els.badgeReply.className = 'step-badge';
      showResult(els.replyResult, job.reusedMedia ? 'Reusing the video that X already processed.' : '', 'info');
    } else {
      els.publishReplyLabel.textContent = job?.phase === 'failed' ? 'Try publishing again' : 'Publish video reply';
      els.publishReply.classList.remove('working');

      if (s.blockers.video) {
        setState(els.replyState, els.replyStateText, 'blocked', s.post ? 'Video publishing blocked' : 'Locked until the first post exists');
        showResult(els.replyResult, s.blockers.video);
        els.badgeReply.textContent = s.post ? 'Blocked' : 'Locked';
        els.badgeReply.className = `step-badge ${s.post ? 'blocked' : ''}`;
      } else if (job?.phase === 'failed') {
        setState(els.replyState, els.replyStateText, 'blocked', job.uncertain ? 'Outcome unknown' : 'Not published');
        showResult(els.replyResult, `${job.error}${job.mediaPreserved ? ' The processed video is kept, so retrying skips the upload.' : ''}`);
        els.badgeReply.textContent = 'Retry';
        els.badgeReply.className = 'step-badge blocked';
      } else {
        const unverified = s.connection.readiness.video.state === 'unverified';
        setState(els.replyState, els.replyStateText, 'ready', videoReady() ? 'Ready to publish' : 'Ready · choose the recording');
        showResult(els.replyResult, unverified ? s.connection.readiness.video.reason : (s.media ? `A processed upload of ${s.media.fileName} is ready to reuse.` : ''), 'info');
        els.badgeReply.textContent = 'Ready';
        els.badgeReply.className = 'step-badge';
      }
    }

    updateReplyComposer();
  }

  function render(s) {
    status = s;
    renderConnection(s);
    renderPost(s);
    renderReply(s);
    if (jobActive(s.replyJob)) {
      startPolling();
    }
  }

  async function refreshStatus() {
    try {
      const response = await fetch('/api/status', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Launchpad could not load its state.');
      render(body);
    } catch (error) {
      setState(els.postState, els.postStateText, 'blocked', 'Launchpad unavailable');
      showResult(els.postResult, error.message);
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const response = await fetch('/api/replies/progress', { cache: 'no-store' });
        const body = await response.json();
        if (!status) return;
        status.replyJob = body.job;
        status.reply = body.reply;
        status.media = body.media;
        renderReply(status);
        if (!jobActive(body.job)) {
          stopPolling();
          refreshStatus();
        }
      } catch {
        // keep polling; transient network hiccups should not abort the view
      }
    }, 800);
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function runVideoChecks(file, meta) {
    const checks = [];
    const push = (level, text) => checks.push({ level, text });
    const isVideoType = ['video/mp4', 'video/quicktime'].includes(file.type);
    push(isVideoType ? 'ok' : 'fail', isVideoType ? `Format ${file.type === 'video/quicktime' ? 'MOV' : 'MP4'}` : `Format ${file.type || 'unknown'} — choose an MP4 (H.264 + AAC) or MOV`);
    push(file.size <= maxVideoBytes ? 'ok' : 'fail', `Size ${formatBytes(file.size)}${file.size > maxVideoBytes ? ' — over the 512 MB limit' : ''}`);

    if (!meta) {
      push('fail', 'The browser could not read this video. Re-encode it as H.264 MP4.');
    } else {
      const seconds = meta.duration;
      if (!Number.isFinite(seconds) || seconds < 0.5) {
        push('fail', 'Duration must be at least 0.5 seconds.');
      } else if (seconds > maxVideoSeconds) {
        push('fail', `Duration ${Math.round(seconds)} s — longer than the 20 minute limit.`);
      } else if (seconds > safeVideoSeconds) {
        push('warn', `Duration ${Math.round(seconds)} s — above 140 s; X allows it for default accounts, but keep the demo short.`);
      } else {
        push('ok', `Duration ${seconds.toFixed(1)} s`);
      }

      const { width, height } = meta;
      const ratio = width / height;
      if (width < 32 || height < 32) {
        push('fail', `Dimensions ${width}×${height} — smaller than 32×32.`);
      } else if (ratio < 1 / 3 || ratio > 3) {
        push('fail', `Aspect ratio ${ratio.toFixed(2)} — must be between 1:3 and 3:1.`);
      } else if (width > 1920 || height > 1200) {
        push('warn', `Dimensions ${width}×${height} — above 1920×1200; X may downscale it.`);
      } else {
        push('ok', `Dimensions ${width}×${height}`);
      }
    }

    els.videoChecks.replaceChildren(...checks.map(({ level, text }) => {
      const item = document.createElement('li');
      item.className = level;
      item.textContent = text;
      return item;
    }));
    els.videoChecks.hidden = false;
    return { ok: checks.every((check) => check.level !== 'fail') };
  }

  els.message.addEventListener('input', updateComposer);
  els.replyMessage.addEventListener('input', updateReplyComposer);

  for (const [tab, name] of [[els.tabPost, 'post'], [els.tabReply, 'reply']]) {
    tab.addEventListener('click', () => selectTab(name));
    tab.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const next = name === 'post' ? 'reply' : 'post';
        selectTab(next);
        (next === 'post' ? els.tabPost : els.tabReply).focus();
      }
    });
  }

  els.publish.addEventListener('click', async () => {
    if (publishing || !canPublishText()) return;
    publishing = true;
    els.publishLabel.textContent = 'Publishing…';
    els.publish.classList.add('working');
    setState(els.postState, els.postStateText, 'working', 'Waiting for X to confirm');
    showResult(els.postResult, '');
    updateComposer();

    try {
      const response = await fetch('/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: els.message.value })
      });
      const body = await response.json();

      if (response.ok) {
        status.post = body.post;
        showPublished(body.post);
        refreshStatus();
        return;
      }

      if (body.post) {
        status.post = body.post;
        showPublished(body.post);
        return;
      }

      if (body.pending) {
        status.pending = body.pending;
        renderPost(status);
        showResult(els.postResult, body.error);
        return;
      }

      throw new Error(body.error || 'The post could not be created.');
    } catch (error) {
      els.publishLabel.textContent = 'Try again';
      els.publish.classList.remove('working');
      setState(els.postState, els.postStateText, 'blocked', 'Not published');
      showResult(els.postResult, error.message);
    } finally {
      publishing = false;
      updateComposer();
    }
  });

  async function resolvePending(payload) {
    const response = await fetch('/api/posts/pending/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Could not resolve the attempt.');
    await refreshStatus();
  }

  els.pendingForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await resolvePending({ outcome: 'published', postId: els.pendingPostId.value });
    } catch (error) {
      showResult(els.postResult, error.message);
    }
  });

  els.pendingNotPublished.addEventListener('click', async () => {
    try {
      await resolvePending({ outcome: 'not-published' });
    } catch (error) {
      showResult(els.postResult, error.message);
    }
  });

  els.video.addEventListener('change', () => {
    const file = els.video.files[0];
    videoFacts = null;
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }

    if (!file) {
      els.fileLabel.textContent = 'Choose the /demo recording (MP4)';
      els.videoPreview.hidden = true;
      els.videoChecks.hidden = true;
      updateReplyComposer();
      return;
    }

    els.fileLabel.textContent = `${file.name} · ${formatBytes(file.size)}`;
    previewUrl = URL.createObjectURL(file);
    els.videoPreview.src = previewUrl;
    els.videoPreview.hidden = false;
    setState(els.replyState, els.replyStateText, 'working', 'Reading the video');

    const finish = (meta) => {
      videoFacts = runVideoChecks(file, meta);
      if (status) renderReply(status);
    };
    els.videoPreview.onloadedmetadata = () => finish({
      duration: els.videoPreview.duration,
      width: els.videoPreview.videoWidth,
      height: els.videoPreview.videoHeight
    });
    els.videoPreview.onerror = () => finish(null);
    updateReplyComposer();
  });

  els.publishReply.addEventListener('click', async () => {
    if (els.publishReply.disabled || replySubmitting) return;
    replySubmitting = true;
    els.publishReplyLabel.textContent = 'Uploading video…';
    els.publishReply.classList.add('working');
    setState(els.replyState, els.replyStateText, 'working', 'Uploading video');
    showResult(els.replyResult, '');
    updateReplyComposer();

    try {
      const form = new FormData();
      form.append('text', els.replyMessage.value);
      form.append('video', els.video.files[0]);
      const response = await fetch('/api/replies', { method: 'POST', body: form });
      const body = await response.json();
      if (!response.ok) {
        if (body.reply) {
          status.reply = body.reply;
          showReplyPublished(body.reply);
          return;
        }
        throw new Error(body.error || 'The video reply could not be started.');
      }

      status.replyJob = body.job;
      renderReply(status);
      startPolling();
    } catch (error) {
      els.publishReplyLabel.textContent = 'Try publishing again';
      els.publishReply.classList.remove('working');
      setState(els.replyState, els.replyStateText, 'blocked', 'Not published');
      showResult(els.replyResult, error.message);
    } finally {
      replySubmitting = false;
      updateReplyComposer();
    }
  });

  function readAuthResult() {
    const params = new URLSearchParams(window.location.search);
    const auth = params.get('auth');
    if (!auth) return;

    if (auth === 'success') {
      const missing = params.get('missing');
      showNotice(
        missing
          ? `Connected @${params.get('account')}, but X granted the tokens without: ${missing}. Reconnect and approve every permission to enable that workflow.`
          : `Connected @${params.get('account')} with OAuth 2.0. Granted scopes were verified and the account was confirmed with GET /2/users/me.`,
        missing ? 'error' : 'info'
      );
    } else {
      const reasons = {
        state: 'The sign-in state did not match or expired. Start Connect / Reconnect X again.',
        denied: 'Authorization was cancelled on X. Nothing changed.',
        code: 'X did not return an authorization code.',
        'client-missing': 'Set X_OAUTH2_CLIENT_ID and X_OAUTH2_CLIENT_SECRET in the credential file, then restart Launchpad.',
        mismatch: params.get('detail') || 'The authorized account did not match.',
        exchange: params.get('detail') || 'X rejected the authorization code exchange.'
      };
      showNotice(reasons[params.get('reason')] || params.get('detail') || 'Connecting X failed.', 'error');
    }

    window.history.replaceState({}, '', window.location.pathname);
  }

  readAuthResult();
  selectTab(window.location.hash === '#reply' ? 'reply' : 'post');
  autosize(els.message);
  autosize(els.replyMessage);
  renderCounter(els.characterCount, els.message.value);
  renderCounter(els.replyCount, els.replyMessage.value);
  renderRichText(els.previewText, els.message.value, 'Your post will appear here.');
  refreshStatus();
})();
