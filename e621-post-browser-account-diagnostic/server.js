'use strict';

const http = require('http');
const https = require('https');
const httpModule = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const PORT = Number(process.env.PORT || 3000);
const E621_BASE = process.env.E621_BASE_URL || 'https://e621.net';
const USER_AGENT = process.env.E621_USER_AGENT || 'E621PostBrowser/1.1 (by e621-post-browser)';
const STATIC_ROOT = path.join(__dirname, 'public');

// TEMPORARY ACCOUNT DIAGNOSTICS
// Enable with E621_ACCOUNT_DEBUG=true in Render. Never logs the API key itself.
const ACCOUNT_DEBUG = process.env.E621_ACCOUNT_DEBUG === 'true';
let accountConfig = null;
try {
  accountConfig = require('./account.config.js');
} catch (err) {
  if (ACCOUNT_DEBUG) log(`[ACCOUNT DEBUG] account.config.js load failed: ${err.message}`);
}

// Keep the UI list synchronized with e621-supported order metatags. "default" is
// an application-only option and deliberately does not become an API tag.
const ORDER_VALUES = [
  'favcount', 'rating', 'random', 'hot',
  'general_tags', 'general_tags_asc',
  'artist_tags', 'artist_tags_asc',
  'contributor_tags', 'contributor_tags_asc',
  'copyright_tags', 'copyright_tags_asc',
  'character_tags', 'character_tags_asc',
  'species_tags', 'species_tags_asc',
  'invalid_tags', 'invalid_tags_asc',
  'meta_tags', 'meta_tags_asc',
  'lore_tags', 'lore_tags_asc',
  'id', 'id_desc', 'score', 'score_asc', 'md5', 'md5_asc',
  'favcount_asc', 'note', 'note_asc', 'mpixels', 'mpixels_asc',
  'filesize', 'filesize_asc', 'tagcount', 'tagcount_asc',
  'change', 'change_asc', 'duration', 'duration_asc',
  'created', 'created_asc', 'updated', 'updated_asc',
  'comment', 'comment_asc', 'comment_bumped', 'comment_bumped_asc',
  'deleted', 'deleted_asc', 'flagged', 'flagged_asc',
  'comment_count', 'comment_count_asc', 'portrait', 'landscape'
];

const sessions = new Set();
const ipLastApiRequest = new Map();
const cache = new Map();
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 80;
const POST_PAGE_SIZE = 5;

// Render sits behind a reverse proxy. Locally, the default is deliberately false
// so a client cannot spoof X-Forwarded-For against a directly exposed Node server.
const TRUST_PROXY = process.env.TRUST_PROXY === 'true' || process.env.RENDER === 'true';
const TRUST_PROXY_HOPS = Math.max(1, Number(process.env.TRUST_PROXY_HOPS || 1));

function normalizeIp(value) {
  let ip = String(value || '').trim();
  if (!ip) return 'unknown';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  // Some proxies append a source port; strip it for IPv4 only.
  if (net.isIP(ip) === 0 && /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, '');
  return ip;
}

function getClientIp(req) {
  const socketIp = normalizeIp(req.socket.remoteAddress || 'unknown');
  if (!TRUST_PROXY) return socketIp;

  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map(part => normalizeIp(part))
    .filter(ip => ip !== 'unknown');

  if (forwarded.length) {
    // With one trusted reverse proxy, the right-most XFF entry is the client.
    // With N trusted hops, walk N-1 entries from the right.
    const index = Math.max(0, forwarded.length - TRUST_PROXY_HOPS);
    return forwarded[index] || socketIp;
  }

  const realIp = normalizeIp(req.headers['x-real-ip'] || '');
  return realIp !== 'unknown' ? realIp : socketIp;
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function runAccountDiagnostics() {
  if (!ACCOUNT_DEBUG) return;

  const envUsernamePresent = Boolean(String(process.env.E621_ACCOUNT_USERNAME || '').trim());
  const envApiKeyPresent = Boolean(String(process.env.E621_ACCOUNT_API_KEY || '').trim());
  const configUsernamePresent = Boolean(String(accountConfig?.username || '').trim());
  const configApiKeyPresent = Boolean(String(accountConfig?.apiKey || '').trim());

  log('[ACCOUNT DEBUG] ===== account diagnostic start =====');
  log(`[ACCOUNT DEBUG] env username present: ${envUsernamePresent}`);
  log(`[ACCOUNT DEBUG] env API key present: ${envApiKeyPresent}`);
  log(`[ACCOUNT DEBUG] account.config.js loaded: ${Boolean(accountConfig)}`);
  log(`[ACCOUNT DEBUG] config username present: ${configUsernamePresent}`);
  log(`[ACCOUNT DEBUG] config API key present: ${configApiKeyPresent}`);

  if (!configUsernamePresent || !configApiKeyPresent) {
    log('[ACCOUNT DEBUG] STOP: credentials are missing before any e621 account request.');
    log('[ACCOUNT DEBUG] ===== account diagnostic end =====');
    return;
  }

  // This diagnostic request is intentionally separate from the normal API client.
  // It tells us whether the credentials themselves work, without changing normal requests.
  const targetUrl = `${E621_BASE}/users/me.json`;
  const urlObject = new URL(targetUrl);
  const transport = urlObject.protocol === 'http:' ? httpModule : https;
  const authorization = Buffer.from(`${accountConfig.username}:${accountConfig.apiKey}`, 'utf8').toString('base64');

  log('[ACCOUNT DEBUG] credentials present; testing authenticated GET /users/me.json');
  log('[ACCOUNT DEBUG] API key is NOT printed.');

  const request = transport.get(urlObject, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
      'Authorization': `Basic ${authorization}`
    },
    timeout: 15_000
  }, response => {
    let raw = '';
    response.setEncoding('utf8');
    response.on('data', chunk => raw += chunk);
    response.on('end', () => {
      const status = response.statusCode || 0;
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (_) {}
      log(`[ACCOUNT DEBUG] /users/me.json HTTP status: ${status}`);

      if (status >= 200 && status < 300 && parsed) {
        const user = parsed;
        const blacklistCount = Array.isArray(user.blacklisted_tags) ? user.blacklisted_tags.length : 'missing';
        log(`[ACCOUNT DEBUG] authenticated username returned by e621: ${String(user.name || 'unknown')}`);
        log(`[ACCOUNT DEBUG] authenticated user id returned by e621: ${String(user.id ?? 'unknown')}`);
        log(`[ACCOUNT DEBUG] blacklisted_tags entries: ${blacklistCount}`);
        log('[ACCOUNT DEBUG] AUTHENTICATION TEST: PASS');
      } else {
        log(`[ACCOUNT DEBUG] authentication response body type: ${parsed ? 'JSON' : 'non-JSON'}`);
        log(`[ACCOUNT DEBUG] AUTHENTICATION TEST: FAIL at e621 credential/API request`);
        if (status === 401) log('[ACCOUNT DEBUG] 401 means e621 rejected the supplied username/API key pair.');
        else if (status === 403) log('[ACCOUNT DEBUG] 403 means e621 refused the authenticated request.');
      }

      log('[ACCOUNT DEBUG] Normal e621 API requests in this release are still unauthenticated unless separately wired to account credentials.');
      log('[ACCOUNT DEBUG] ===== account diagnostic end =====');
    });
  });

  request.on('timeout', () => request.destroy(new Error('account diagnostic timed out')));
  request.on('error', err => {
    log(`[ACCOUNT DEBUG] authenticated account request failed before a response: ${err.message}`);
    log('[ACCOUNT DEBUG] AUTHENTICATION TEST: FAIL at network/transport stage');
    log('[ACCOUNT DEBUG] ===== account diagnostic end =====');
  });
}

function safeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff'});
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 16 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      body += chunk.toString('utf8');
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch (_) {
    return {};
  }
}

function normalizeSearchQuery({rating, order, tags}) {
  const allowedRatings = new Set(['safe', 'questionable', 'explicit', 'any']);
  const selectedRating = allowedRatings.has(String(rating || '').toLowerCase())
    ? String(rating).toLowerCase()
    : 'safe';

  const requestedOrder = String(order || '').toLowerCase();
  const selectedOrder = requestedOrder === 'default'
    ? 'default'
    : ORDER_VALUES.includes(requestedOrder)
      ? requestedOrder
      : 'favcount';

  const tokens = String(tags || '').trim().split(/\s+/).filter(Boolean);
  const cleaned = tokens.filter(token => {
    const lower = token.toLowerCase();
    // Rating/order dropdowns are authoritative. Remove only rating/order tokens;
    // preserve all other native e621 syntax supplied by the user.
    if (/^rating:(safe|questionable|explicit|s|q|e)$/i.test(lower)) return false;
    if (/^order:[^\s]+$/i.test(lower)) return false;
    return true;
  });

  const prefix = [];
  if (selectedRating !== 'any') prefix.push(`rating:${selectedRating}`);
  if (selectedOrder !== 'default') prefix.push(`order:${selectedOrder}`);
  return [...prefix, ...cleaned].join(' ').trim();
}

function extractPostId(input) {
  const value = String(input || '').trim();
  if (/^\d+$/.test(value)) return Number(value);
  const match = value.match(/^(?:https?:\/\/)?(?:www\.)?e621\.net\/posts\/(\d+)(?:[/?#].*)?$/i);
  return match ? Number(match[1]) : null;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, {time: Date.now(), value});
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function httpsGetJson(targetUrl, minIntervalMs = 1000, identityKey = 'global') {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const last = ipLastApiRequest.get(identityKey) || 0;
    const delay = Math.max(0, minIntervalMs - (now - last));

    setTimeout(() => {
      ipLastApiRequest.set(identityKey, Date.now());
      const urlObject = new URL(targetUrl);
      const transport = urlObject.protocol === 'http:' ? httpModule : https;
      const request = transport.get(urlObject, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/json'
        },
        timeout: 15_000
      }, response => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', chunk => raw += chunk);
        response.on('end', () => {
          const status = response.statusCode || 0;
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (_) {}
          if (status >= 200 && status < 300 && parsed !== null) {
            resolve(parsed);
            return;
          }
          const err = new Error(`e621 returned HTTP ${status}`);
          err.status = status;
          err.payload = parsed;
          reject(err);
        });
      });
      request.on('timeout', () => request.destroy(new Error('e621 request timed out')));
      request.on('error', reject);
    }, delay);
  });
}

async function fetchExactTag(tag, ip) {
  const normalized = String(tag || '').toLowerCase();
  const key = `tag-exact:${normalized}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const params = new URLSearchParams({
    'search[name_matches]': String(tag),
    limit: '5'
  });
  const data = await httpsGetJson(`${E621_BASE}/tags.json?${params.toString()}`, 1000, ip);
  const rows = Array.isArray(data) ? data : [];
  const exact = rows.find(row => String(row?.name || '').toLowerCase() === normalized) || null;
  const result = {
    exists: Boolean(exact),
    invalid: Boolean(exact && Number(exact.category) === 6),
    name: exact?.name || String(tag)
  };
  cacheSet(key, result);
  return result;
}

async function findInvalidTag(tags, ip) {
  const candidates = String(tags || '').trim().split(/\s+/).filter(Boolean)
    .map(token => token.replace(/^[-~]+/, ''))
    .filter(token => token && !token.includes(':'));

  for (const tag of candidates) {
    const result = await fetchExactTag(tag, ip);
    if (!result.exists || result.invalid) return tag;
  }
  return null;
}

async function getTagSuggestions(tag, ip) {
  const normalized = String(tag || '').trim().toLowerCase();
  if (!normalized) return [];
  const key = `tag-suggestions:${normalized}`;
  const cached = cacheGet(key);
  if (cached) return cached.suggestions || [];

  const params = new URLSearchParams({
    'search[name_matches]': `${String(tag).trim()}*`,
    limit: '8'
  });
  const data = await httpsGetJson(`${E621_BASE}/tags.json?${params.toString()}`, 1000, ip);
  const rows = Array.isArray(data) ? data : [];
  const suggestions = rows.map(row => row?.name).filter(Boolean)
    .filter(name => String(name).toLowerCase() !== normalized)
    .slice(0, 8);
  cacheSet(key, {suggestions});
  return suggestions;
}

function withSecurityHeaders(res) {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

function serveStatic(req, res) {
  let requested = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  if (requested === '/') requested = '/index.html';
  const safePath = path.normalize(requested).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(STATIC_ROOT, safePath);
  if (!filePath.startsWith(STATIC_ROOT)) return sendText(res, 403, 'Forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (requested !== '/index.html') return sendText(res, 404, 'Not found');
      return sendText(res, 500, 'Application shell missing');
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.html':'text/html; charset=utf-8',
      '.js':'text/javascript; charset=utf-8',
      '.css':'text/css; charset=utf-8',
      '.json':'application/json; charset=utf-8',
      '.svg':'image/svg+xml'
    };
    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}

async function handleApi(req, res) {
  withSecurityHeaders(res);
  const ip = getClientIp(req);

  if (req.method === 'POST' && req.url === '/api/session/start') {
    const body = parseBody(await readBody(req).catch(() => '{}'));
    const sessionId = String(body.sessionId || crypto.randomUUID());
    if (!sessions.has(sessionId)) {
      sessions.add(sessionId);
      log(`New user: ${ip}`);
    }
    return safeJson(res, 200, {ok: true, sessionId});
  }

  if (req.method === 'POST' && req.url === '/api/session/leave') {
    const body = parseBody(await readBody(req).catch(() => '{}'));
    if (body.sessionId && sessions.has(String(body.sessionId))) {
      sessions.delete(String(body.sessionId));
      log(`User left: ${ip}`);
    }
    return safeJson(res, 200, {ok: true});
  }

  if (req.method === 'POST' && req.url === '/api/log') {
    const body = parseBody(await readBody(req).catch(() => '{}'));
    const action = body.action;
    const tags = String(body.tags || 'none').trim() || 'none';
    if (action === 'load') log(`[${ip}] button 'Load Tags' pressed, tags requested: ${tags}`);
    else if (action === 'next') log(`[${ip}] button 'Next' pressed, tags in use: ${tags}`);
    else if (action === 'previous') log(`[${ip}] button 'Previous' pressed, tags in use: ${tags}`);
    else if (action === 'error' && ['endOfTags', 'tagNotFound'].includes(body.errorType)) {
      log(`[ERROR] user ${ip} raised '${body.errorType}'`);
    }
    return safeJson(res, 200, {ok: true});
  }

  if (req.method !== 'GET') return safeJson(res, 405, {error: 'Method not allowed'});

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (parsedUrl.pathname === '/api/orders') {
    return safeJson(res, 200, {orders: ['default', ...ORDER_VALUES]});
  }

  if (parsedUrl.pathname === '/api/query') {
    const query = normalizeSearchQuery({
      rating: parsedUrl.searchParams.get('rating') || 'safe',
      order: parsedUrl.searchParams.get('order') || 'favcount',
      tags: parsedUrl.searchParams.get('tags') || ''
    });
    return safeJson(res, 200, {query});
  }

  if (parsedUrl.pathname === '/api/posts') {
    const input = parsedUrl.searchParams.get('input') || '';
    const rating = parsedUrl.searchParams.get('rating') || 'safe';
    const order = parsedUrl.searchParams.get('order') || 'favcount';
    const page = Math.max(1, Number(parsedUrl.searchParams.get('page') || 1));
    const limit = Math.min(POST_PAGE_SIZE, Math.max(1, Number(parsedUrl.searchParams.get('limit') || POST_PAGE_SIZE)));
    const directId = extractPostId(input);

    try {
      if (directId !== null) {
        const key = `post:${directId}`;
        const cached = cacheGet(key);
        if (cached) return safeJson(res, 200, {mode: 'post', posts: [cached], query: String(directId)});
        const data = await httpsGetJson(`${E621_BASE}/posts/${directId}.json`, 1000, ip);
        if (!data || !data.post) return safeJson(res, 404, {error: 'Post not found'});
        cacheSet(key, data.post);
        return safeJson(res, 200, {mode: 'post', posts: [data.post], query: String(directId)});
      }

      const query = normalizeSearchQuery({rating, order, tags: input});
      const cacheKey = `search:${query}|page:${page}|limit:${limit}`;
      const cached = cacheGet(cacheKey);
      if (cached) return safeJson(res, 200, cached);

      const params = new URLSearchParams({tags: query, limit: String(limit), page: String(page)});
      const data = await httpsGetJson(`${E621_BASE}/posts.json?${params.toString()}`, 1000, ip);
      const posts = Array.isArray(data.posts) ? data.posts : [];
      const payload = {mode: 'search', posts, query};

      if (!posts.length) {
        const invalidTag = await findInvalidTag(input, ip).catch(() => null);
        if (invalidTag) {
          const suggestions = await getTagSuggestions(invalidTag, ip).catch(() => []);
          payload.invalidTag = invalidTag;
          payload.suggestions = suggestions;
        }
      }

      cacheSet(cacheKey, payload);
      return safeJson(res, 200, payload);
    } catch (err) {
      return safeJson(res, err.status === 404 ? 404 : 502, {
        error: 'e621 API request failed',
        detail: err.message
      });
    }
  }

  if (parsedUrl.pathname === '/api/tag-suggestions') {
    const tag = String(parsedUrl.searchParams.get('tag') || '').trim();
    if (!tag) return safeJson(res, 200, {suggestions: []});
    try {
      return safeJson(res, 200, {suggestions: await getTagSuggestions(tag, ip)});
    } catch (_) {
      return safeJson(res, 200, {suggestions: []});
    }
  }

  return safeJson(res, 404, {error: 'Not found'});
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      await handleApi(req, res);
      return;
    }
    withSecurityHeaders(res);
    serveStatic(req, res);
  } catch (err) {
    log(`[ERROR] server request failed: ${err.message}`);
    if (!res.headersSent) safeJson(res, 500, {error: 'Internal server error'});
    else res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  log(`e621 Post Browser listening on port ${PORT}`);
  log(`Using e621 User-Agent: ${USER_AGENT}`);
  log(`Trusted proxy IP detection: ${TRUST_PROXY ? `enabled (${TRUST_PROXY_HOPS} hop${TRUST_PROXY_HOPS === 1 ? '' : 's'})` : 'disabled'}`);
  runAccountDiagnostics();
});
