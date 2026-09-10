'use strict';

const $ = id => document.getElementById(id);
const ratingEl = $('rating');
const orderEl = $('order');
const inputEl = $('tagInput');
const loadBtn = $('loadBtn');
const copyBtn = $('copyBtn');
const openBtn = $('openBtn');
const prevBtn = $('prevBtn');
const nextBtn = $('nextBtn');
const mediaStage = $('mediaStage');
const tagsToggle = $('tagsToggle');
const tagsCaret = $('tagsCaret');
const tagList = $('tagList');
const toast = $('toast');
const confirmDialog = $('confirmDialog');
const confirmText = $('confirmText');
const cancelOpen = $('cancelOpen');
const confirmOpen = $('confirmOpen');

const state = {
  sessionId: sessionStorage.getItem('e621-browser-session') || crypto.randomUUID(),
  query: '',
  page: 1,
  window: [],
  index: 0,
  hasMore: true,
  currentPost: null,
  tagsOpen: false,
  loading: false,
  mode: 'search',
  lastErrorSignature: '',
  requestToken: 0,
};

sessionStorage.setItem('e621-browser-session', state.sessionId);

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 1600);
}

function postUrl(post) {
  return post ? `https://e621.net/posts/${post.id}` : '';
}

function mediaUrl(post) {
  const ext = String(post?.file?.ext || '').toLowerCase();
  if (['mp4', 'webm'].includes(ext)) {
    return post?.sample?.alternates?.variants?.mp4?.url || post?.file?.url || post?.sample?.url || '';
  }
  return post?.file?.url || post?.sample?.url || '';
}

function extensionFor(post) {
  const url = mediaUrl(post).split('?')[0];
  return url.includes('.') ? url.slice(url.lastIndexOf('.') + 1).toLowerCase() : '';
}

function clearError() {
  state.lastErrorSignature = '';
}

function showMessage(message) {
  mediaStage.replaceChildren();
  const card = document.createElement('div');
  card.className = 'status-card';
  card.textContent = message;
  mediaStage.appendChild(card);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.detail || data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function logAction(action, tags = state.query) {
  try {
    await api('/api/log', {
      method: 'POST',
      body: JSON.stringify({action, tags: tags || 'none'})
    });
  } catch (_) {}
}

async function logError(errorType) {
  const signature = `${errorType}:${state.query}:${state.currentPost?.id || 'none'}`;
  if (state.lastErrorSignature === signature) return;
  state.lastErrorSignature = signature;
  try {
    await api('/api/log', {
      method: 'POST',
      body: JSON.stringify({action: 'error', errorType})
    });
  } catch (_) {}
}

function tagStringFromPost(post) {
  const cats = post?.tags || {};
  const groups = [];
  for (const key of Object.keys(cats)) {
    if (Array.isArray(cats[key])) groups.push(...cats[key]);
  }
  return [...new Set(groups)].sort();
}

function updateTags(post) {
  const tags = tagStringFromPost(post);
  tagList.replaceChildren();
  if (tags.length) {
    for (const tag of tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = tag;
      tagList.appendChild(chip);
    }
  } else {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.textContent = 'No tags returned';
    tagList.appendChild(chip);
  }

  // The hidden attribute is the source of truth for actual visibility.
  tagList.hidden = !state.tagsOpen;
  tagsToggle.setAttribute('aria-expanded', String(state.tagsOpen));
  tagsCaret.textContent = state.tagsOpen ? '⏷' : '⏵';
}

function resizeMediaElement() {
  const media = mediaStage.querySelector('img, video');
  if (!media) return;
  const availableWidth = Math.max(0, mediaStage.clientWidth - 8);
  const availableHeight = Math.max(0, mediaStage.clientHeight - 8);
  media.style.maxWidth = `${availableWidth}px`;
  media.style.maxHeight = `${availableHeight}px`;
}

const mediaResizeObserver = typeof ResizeObserver !== 'undefined'
  ? new ResizeObserver(resizeMediaElement)
  : null;

function attachMediaResizeObserver() {
  mediaResizeObserver?.disconnect();
  if (mediaResizeObserver) mediaResizeObserver.observe(mediaStage);
  resizeMediaElement();
}

function renderPost(post) {
  state.currentPost = post;
  updateTags(post);

  const ext = extensionFor(post);
  const url = mediaUrl(post);
  mediaStage.replaceChildren();

  if (!url) {
    showMessage('This post has no usable media URL.');
    return;
  }

  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
    const img = document.createElement('img');
    img.alt = `e621 post ${post.id}`;
    img.src = url;
    img.decoding = 'async';
    img.loading = 'eager';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      if (state.currentPost?.id !== post.id) return;
      showMessage('The media is currently unavailable.');
    }, {once: true});
    img.addEventListener('load', resizeMediaElement, {once: true});
    mediaStage.appendChild(img);
    attachMediaResizeObserver();
    return;
  }

  if (['mp4', 'webm'].includes(ext)) {
    const video = document.createElement('video');

    // Keep the browser from falling back to its 300x150 default object size while
    // media metadata is loading by using the dimensions e621 already supplies.
    const width = Number(post?.file?.width);
    const height = Number(post?.file?.height);
    if (width > 0 && height > 0) {
      video.width = width;
      video.height = height;
    }

    // Playback behavior copied from the supplied working video-only reference:
    // native controls + autoplay + inline playback + an explicit media load.
    video.controls = true;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('autoplay', '');
    video.setAttribute('playsinline', '');
    video.referrerPolicy = 'no-referrer';

    const source = document.createElement('source');
    source.src = url;
    source.type = ext === 'webm' ? 'video/webm' : 'video/mp4';
    video.appendChild(source);

    const fail = () => {
      if (state.currentPost?.id !== post.id) return;
      showMessage('The video media is currently unavailable or unsupported by this browser.');
    };

    video.addEventListener('error', fail, {once: true});
    video.addEventListener('loadedmetadata', () => {
      resizeMediaElement();
      video.play().catch(() => {});
    }, {once: true});
    video.addEventListener('canplay', () => {
      resizeMediaElement();
      video.play().catch(() => {});
    }, {once: true});

    mediaStage.appendChild(video);
    attachMediaResizeObserver();
    video.load();
    video.volume = 1.0;
    video.muted = false;
    video.defaultMuted = false;
    video.play().catch(() => {});
    return;
  }

  const card = document.createElement('div');
  card.className = 'status-card';
  card.textContent = `Unsupported media format: ${ext || 'unknown'}`;
  mediaStage.appendChild(card);
}

function renderTagNotFound(tag, suggestions) {
  mediaStage.replaceChildren();
  const card = document.createElement('div');
  card.className = 'error-card point-up';

  const title = document.createElement('div');
  title.className = 'error-title';
  title.textContent = 'Tag not found';
  card.appendChild(title);

  const text = document.createElement('div');
  text.className = 'error-text';
  text.innerHTML = `The tag <strong>${escapeHtml(tag)}</strong> doesn't exist.`;
  card.appendChild(text);

  if (suggestions?.length) {
    const wrap = document.createElement('div');
    wrap.className = 'suggestions';
    const label = document.createElement('div');
    label.className = 'suggestions-label';
    label.textContent = 'Similar tags:';
    wrap.appendChild(label);

    suggestions.forEach(suggestion => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = suggestion;
      b.addEventListener('click', () => {
        const tokens = inputEl.value.trim().split(/\s+/).filter(Boolean);
        const target = String(tag).toLowerCase();
        const index = tokens.findIndex(token => token.replace(/^[-~]+/, '').toLowerCase() === target);
        if (index >= 0) tokens[index] = suggestion;
        inputEl.value = tokens.join(' ');
        loadSearch();
      });
      wrap.appendChild(b);
    });
    card.appendChild(wrap);
  }

  mediaStage.appendChild(card);
}

function renderEndError() {
  mediaStage.replaceChildren();
  const card = document.createElement('div');
  card.className = 'error-card point-right';
  const title = document.createElement('div');
  title.className = 'error-title';
  title.textContent = 'End of posts';
  const text = document.createElement('div');
  text.className = 'error-text';
  text.textContent = 'Reached end of posts. Try other tags to see more.';
  card.append(title, text);
  mediaStage.appendChild(card);
}

function updateNavDisabled() {
  prevBtn.disabled = state.loading || (state.index === 0 && (state.page === 1 || state.mode === 'post'));
  nextBtn.disabled = state.loading;
}

async function getNormalizedQuery() {
  const params = new URLSearchParams({
    rating: ratingEl.value,
    order: orderEl.value,
    tags: inputEl.value.trim()
  });
  const data = await api(`/api/query?${params.toString()}`);
  return data.query || '';
}

function buildSearchUrl(page) {
  const params = new URLSearchParams({
    input: inputEl.value.trim(),
    rating: ratingEl.value,
    order: orderEl.value,
    page: String(page),
    limit: '5'
  });
  return `/api/posts?${params.toString()}`;
}

async function fetchPage(page) {
  return api(buildSearchUrl(page));
}

function isDirectInput() {
  const value = inputEl.value.trim();
  return /^\d+$/.test(value) || /^(?:https?:\/\/)?(?:www\.)?e621\.net\/posts\/\d+(?:[/?#].*)?$/i.test(value);
}

async function loadDirectPost() {
  const data = await fetchPage(1);
  state.mode = 'post';
  state.query = data.query;
  state.page = 1;
  state.window = data.posts || [];
  state.index = 0;
  state.hasMore = false;
  if (!state.window.length) {
    showMessage('Post not found.');
    state.currentPost = null;
    updateTags(null);
    updateNavDisabled();
    return;
  }
  clearError();
  renderPost(state.window[0]);
  updateNavDisabled();
}

async function loadSearch() {
  if (state.loading) return;
  const requestToken = ++state.requestToken;
  state.loading = true;
  updateNavDisabled();
  showMessage('Loading e621 posts…');

  const direct = isDirectInput();
  let queryForLog = inputEl.value.trim() || 'none';
  if (!direct) {
    try {
      queryForLog = await getNormalizedQuery() || 'none';
    } catch (_) {}
  }
  await logAction('load', queryForLog);

  try {
    if (direct) {
      await loadDirectPost();
      return;
    }

    const data = await fetchPage(1);
    if (requestToken !== state.requestToken) return;

    state.mode = 'search';
    state.query = data.query || 'none';
    state.page = 1;
    state.window = (data.posts || []).slice(0, 5);
    state.index = 0;
    state.hasMore = state.window.length === 5;
    clearError();

    if (!state.window.length) {
      if (data.invalidTag) {
        renderTagNotFound(data.invalidTag, data.suggestions || []);
        await logError('tagNotFound');
      } else {
        showMessage('No posts matched this search.');
      }
      updateNavDisabled();
      return;
    }

    renderPost(state.window[0]);
  } catch (err) {
    showMessage(`Unable to load e621 posts: ${err.message}`);
    state.window = [];
    state.index = 0;
    state.currentPost = null;
    updateTags(null);
  } finally {
    state.loading = false;
    updateNavDisabled();
  }
}

async function moveNext() {
  if (state.loading) return;
  await logAction('next', state.query || 'none');

  if (state.mode === 'post') {
    renderEndError();
    await logError('endOfTags');
    return;
  }

  if (state.index < state.window.length - 1) {
    state.index += 1;
    renderPost(state.window[state.index]);
    updateNavDisabled();
    return;
  }

  if (!state.hasMore) {
    renderEndError();
    await logError('endOfTags');
    updateNavDisabled();
    return;
  }

  state.loading = true;
  updateNavDisabled();
  try {
    const nextPage = state.page + 1;
    const data = await fetchPage(nextPage);
    const posts = Array.isArray(data.posts) ? data.posts : [];
    if (!posts.length) {
      state.hasMore = false;
      renderEndError();
      await logError('endOfTags');
      return;
    }

    const previousPost = state.window.at(-1);
    state.page = nextPage;
    state.window = [previousPost, ...posts.slice(0, 4)].filter(Boolean).slice(-5);
    state.index = Math.min(1, state.window.length - 1);
    state.hasMore = posts.length >= 5;
    renderPost(state.window[state.index]);
  } catch (err) {
    showMessage(`Unable to load the next posts: ${err.message}`);
  } finally {
    state.loading = false;
    updateNavDisabled();
  }
}

async function movePrevious() {
  if (state.loading || !state.currentPost) return;
  await logAction('previous', state.query || 'none');

  if (state.index > 0) {
    state.index -= 1;
    renderPost(state.window[state.index]);
    updateNavDisabled();
    return;
  }
  if (state.page <= 1 || state.mode === 'post') return;

  state.loading = true;
  updateNavDisabled();
  try {
    const prevPage = state.page - 1;
    const data = await fetchPage(prevPage);
    const posts = Array.isArray(data.posts) ? data.posts : [];
    if (!posts.length) return;

    const current = state.window[0];
    state.page = prevPage;
    state.window = [...posts.slice(-4), current].filter(Boolean).slice(-5);
    state.index = Math.max(0, state.window.length - 2);
    renderPost(state.window[state.index]);
    state.hasMore = true;
  } catch (err) {
    showMessage(`Unable to load the previous posts: ${err.message}`);
  } finally {
    state.loading = false;
    updateNavDisabled();
  }
}

async function copyCurrentLink() {
  const url = postUrl(state.currentPost);
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
  } catch (_) {
    const textarea = document.createElement('textarea');
    textarea.value = url;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
  showToast('Link copied!');
}

function openConfirm() {
  const url = postUrl(state.currentPost);
  if (!url) return;
  confirmText.textContent = `This will open ${url} in another tab. Are you sure you want to continue?`;
  if (typeof confirmDialog.showModal === 'function') confirmDialog.showModal();
  else if (window.confirm(`This will open ${url} in another tab. Are you sure you want to continue?`)) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

async function startSession() {
  try {
    await api('/api/session/start', {method:'POST', body: JSON.stringify({sessionId: state.sessionId})});
  } catch (_) {}
}

function leaveSession() {
  const body = JSON.stringify({sessionId: state.sessionId});
  try {
    const blob = new Blob([body], {type:'application/json'});
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/session/leave', blob);
      return;
    }
    fetch('/api/session/leave', {
      method:'POST',
      body,
      headers:{'Content-Type':'application/json'},
      keepalive:true
    }).catch(() => {});
  } catch (_) {}
}

async function populateOrders() {
  const data = await api('/api/orders');
  orderEl.replaceChildren();
  data.orders.forEach(value => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value === 'default' ? 'order:default' : `order:${value}`;
    orderEl.appendChild(option);
  });
  orderEl.value = 'favcount';
}

tagsToggle.addEventListener('click', () => {
  state.tagsOpen = !state.tagsOpen;
  updateTags(state.currentPost);
  resizeMediaElement();
});
loadBtn.addEventListener('click', loadSearch);
copyBtn.addEventListener('click', copyCurrentLink);
openBtn.addEventListener('click', openConfirm);
prevBtn.addEventListener('click', movePrevious);
nextBtn.addEventListener('click', moveNext);

cancelOpen.addEventListener('click', () => confirmDialog.close());
confirmOpen.addEventListener('click', () => {
  const url = postUrl(state.currentPost);
  confirmDialog.close();
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
});

inputEl.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    loadSearch();
  }
});

document.addEventListener('keydown', event => {
  if (event.target === inputEl || event.target.isContentEditable) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); movePrevious(); }
  if (event.key === 'ArrowRight') { event.preventDefault(); moveNext(); }
  if (event.key === 'Enter' && event.target !== loadBtn) { event.preventDefault(); loadSearch(); }
});

window.addEventListener('resize', resizeMediaElement, {passive: true});
window.addEventListener('orientationchange', resizeMediaElement, {passive: true});
window.addEventListener('pagehide', leaveSession);

(async function init() {
  state.tagsOpen = false;
  updateTags(null);
  await startSession();
  try {
    await populateOrders();
  } catch (_) {
    orderEl.innerHTML = '<option value="favcount">order:favcount</option><option value="default">order:default</option>';
    orderEl.value = 'favcount';
  }
  ratingEl.value = 'safe';
  inputEl.value = '';
  await loadSearch();
})();
