// Serves the static site (web/) and a tiny API to sync a profile between devices:
//   GET /api/profile/:code   → the stored profile (404 if none)
//   PUT /api/profile/:code   → store it (JSON, max 1 MB)
// The code is a random 128-bit id generated in the browser; whoever knows it can read and
// write that profile, nothing else. Profiles hold reading preferences, no personal data.
//
// Optional login: with the INVITES variable set (secret or dashboard text) ("ana:código, pepe:otro…", one per person) the
// whole site asks for an invite code. Each person gets a cookie bound to their code (changing
// or removing it logs them out) and an account sync code derived from it (GET /api/me), so
// their profile follows them to any device where they log in. Without INVITES the site is open.

const CODE_RE = /^[a-f0-9]{32}$/;
const MAX_BYTES = 1024 * 1024; // a heavy profile (2 × 300 saved stories + the model) is ~600 KB
const COOKIE = 'md_session';
const COOKIE_MAX_AGE = 400 * 86400; // the longest browsers keep a cookie
// Reachable without logging in. data/meta.json is only the edition date and story count: the
// freshness checks of the workflows read it.
const PUBLIC = /^\/(sw\.js|manifest\.webmanifest|icons\/.*|data\/meta\.json)$/;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

// ---------- login ----------

export function parseInvites(raw) {
  const out = new Map();
  for (const entry of String(raw ?? '').split(/[\n,]/)) {
    const i = entry.indexOf(':');
    const name = entry.slice(0, i).trim();
    const code = entry.slice(i + 1).trim();
    if (i > 0 && name && code) out.set(name, code);
  }
  return out;
}

async function hmac(key, message) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const sessionToken = async (name, code) => `${encodeURIComponent(name)}.${await hmac(code, `session:${name}`)}`;
const accountSync = async (name, code) => (await hmac(code, `sync:${name}`)).slice(0, 32);

function readCookie(request) {
  const m = (request.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

// The logged-in person, or null. The token is re-checked against the current invites.
async function currentUser(request, invites) {
  const token = readCookie(request);
  if (!token) return null;
  let name;
  try {
    name = decodeURIComponent(token.slice(0, token.lastIndexOf('.'))); // names may contain dots
  } catch {
    return null;
  }
  const code = invites.get(name);
  if (!code || token !== (await sessionToken(name, code))) return null;
  return { name, code };
}

const safeNext = (next) => (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function loginPage(next, error = '', status = error ? 401 : 200, extra = {}) {
  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mi Diario · Entrar</title>
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<style>
  :root { --bg: #fbfaf7; --surface: #fff; --text: #1b1c1f; --muted: #6a6d74; --border: #e6e3dc; --accent: #b4381e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #16171a; --surface: #1f2024; --text: #ececec; --muted: #9a9ca3; --border: #2f3036; --accent: #ff8a65; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  form { width: min(360px, calc(100vw - 32px)); background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; box-sizing: border-box; }
  h1 { margin: 0 0 4px; font: 700 1.6rem/1.2 'Iowan Old Style', Palatino, Georgia, serif; }
  p { margin: 0 0 16px; color: var(--muted); }
  input, button { width: 100%; box-sizing: border-box; font: inherit; border-radius: 8px; padding: 10px 12px; }
  input { border: 1px solid var(--border); background: var(--bg); color: var(--text); margin-bottom: 12px; }
  button { border: 0; background: var(--accent); color: #fff; font-weight: 600; cursor: pointer; }
  .error { color: var(--accent); }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>Mi Diario</h1>
  <p>Escribe tu código de invitación.</p>
  ${error ? `<p class="error">${esc(error)}</p>` : ''}
  <input type="hidden" name="next" value="${esc(next)}">
  <input name="code" type="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="Código de invitación" required autofocus>
  <button>Entrar</button>
</form>
</body>
</html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra } });
}

// Brute-force limit per client IP. KV allows few writes a day, so only failed attempts write.
const MAX_FAILS = 5;
const FAIL_WINDOW = 15 * 60; // seconds
const failKey = (request) => `rl:${request.headers.get('cf-connecting-ip') ?? 'unknown'}`;

// Seconds until this IP may try again (0 = not locked). Fails open if KV is unavailable.
async function lockedFor(env, key) {
  try {
    const [n, start] = String(await env.PROFILES.get(key) ?? '').split(':').map(Number);
    return n >= MAX_FAILS ? Math.max(1, start + FAIL_WINDOW - Math.floor(Date.now() / 1000)) : 0;
  } catch (err) {
    console.error('login rate limit read failed', err);
    return 0;
  }
}

async function recordFail(env, key) {
  try {
    const now = Math.floor(Date.now() / 1000);
    let [n, start] = String(await env.PROFILES.get(key) ?? '').split(':').map(Number);
    if (!(n > 0) || !(start + FAIL_WINDOW > now)) [n, start] = [0, now];
    const ttl = Math.max(60, start + FAIL_WINDOW - now); // KV minimum TTL is 60 s
    await env.PROFILES.put(key, `${n + 1}:${start}`, { expirationTtl: ttl });
  } catch (err) {
    console.error('login rate limit write failed', err);
  }
}

// Case-insensitive, constant-time lookup: compare digests and never stop at the first match.
async function findInvite(invites, typed) {
  const want = await hmac('login', typed);
  let found;
  for (const [name, code] of invites) {
    const got = await hmac('login', code.toLowerCase());
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
    if (diff === 0) found = [name, code];
  }
  return found ?? [];
}

async function login(request, url, invites, env) {
  if (request.method === 'GET') return loginPage(safeNext(url.searchParams.get('next')));
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const key = failKey(request);
  const wait = await lockedFor(env, key);
  if (wait) return loginPage('/', 'Demasiados intentos, espera unos minutos.', 429, { 'retry-after': String(wait) });
  const form = await request.formData();
  const next = safeNext(form.get('next'));
  const typed = String(form.get('code') ?? '').trim().toLowerCase(); // phones capitalise the first letter
  const [name, code] = await findInvite(invites, typed);
  if (!typed || !name) {
    await recordFail(env, key);
    return loginPage(next, 'Código incorrecto.');
  }
  const cookie = `${COOKIE}=${await sessionToken(name, code)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
  return new Response(null, { status: 303, headers: { location: next, 'set-cookie': cookie } });
}

const logout = () =>
  new Response(null, { status: 303, headers: { location: '/login', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });

// ---------- profiles ----------

async function profileApi(request, env, url) {
  const m = url.pathname.match(/^\/api\/profile\/([^/]+)$/);
  if (!m || !CODE_RE.test(m[1])) return json({ error: 'not found' }, 404);
  const key = `profile:${m[1]}`;

  if (request.method === 'GET') {
    const stored = await env.PROFILES.get(key);
    return stored ? new Response(stored, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }) : json({ error: 'not found' }, 404);
  }
  if (request.method === 'PUT') {
    if (Number(request.headers.get('content-length')) > MAX_BYTES) return json({ error: 'too large' }, 413);
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_BYTES) return json({ error: 'too large' }, 413); // bytes, not UTF-16 chars
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    } catch {
      return json({ error: 'invalid json' }, 400);
    }
    await env.PROFILES.put(key, body);
    return json({ ok: true });
  }
  return json({ error: 'method not allowed' }, 405);
}

// ---------- news schedule ----------

// GitHub's own cron is unreliable (runs hours late or never), so Cloudflare's cron, which fires
// on time, launches the update workflow. Times are UTC, as in update-news.yml: every 30 min from
// 5:17 to 22:47 plus 1:17 and 3:17; AI summaries on the even hours from 6:17 to 22:17.
export function planRun(date) {
  const h = date.getUTCHours();
  const m = date.getUTCMinutes();
  const slot = m >= 47 ? 47 : m >= 17 ? 17 : null; // a late tick still counts for its slot
  if (slot === null) return null;
  if (!(h >= 5 && h <= 22) && !(slot === 17 && (h === 1 || h === 3))) return null;
  return { ai: slot === 17 && h % 2 === 0 && h >= 6 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Network errors and 5xx are retried (GitHub's API hiccups now and then); a 4xx never is. Every
// outcome is logged, since nobody watches this Worker: a 401/403/404 almost always means the
// GITHUB_DISPATCH_TOKEN expired or lost its Actions permission, and the workflows' freshness
// check (vigilar-noticias.yml) is what tells the owner.
export async function dispatchUpdate(env, scheduledTime, { retryDelayMs = 1000 } = {}) {
  const plan = planRun(new Date(scheduledTime));
  if (!plan) return;
  if (!env.GITHUB_DISPATCH_TOKEN) {
    console.error('dispatch skipped: GITHUB_DISPATCH_TOKEN is not set');
    return;
  }
  const repo = env.GITHUB_REPO || 'jaime-otero/App-personal-de-noticias';
  const request = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'mi-diario-worker',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ ref: env.GITHUB_BRANCH || 'main', inputs: { resumen_ia: plan.ai ? 'si' : 'no' } }),
  };
  const url = `https://api.github.com/repos/${repo}/actions/workflows/update-news.yml/dispatches`;
  const attempts = 3;
  for (let i = 1; ; i++) {
    let failure;
    try {
      const res = await fetch(url, request);
      if (res.ok) {
        console.log(`dispatch ok (${new Date(scheduledTime).toISOString()}, ai=${plan.ai}, attempt ${i})`);
        return;
      }
      const hint = [401, 403, 404].includes(res.status) ? ' — GITHUB_DISPATCH_TOKEN caducado, revocado o sin permiso Actions: write?' : '';
      failure = new Error(`GitHub dispatch ${res.status}${hint}: ${(await res.text()).slice(0, 300)}`);
      failure.retry = res.status >= 500;
    } catch (err) {
      failure = new Error(`GitHub dispatch network error: ${err.message}`);
      failure.retry = true;
    }
    if (!failure.retry || i === attempts) {
      console.error(`${failure.message} (attempt ${i}/${attempts})`);
      throw failure;
    }
    console.warn(`${failure.message}; retrying (attempt ${i}/${attempts})`);
    await sleep(retryDelayMs * i);
  }
}

// ---------- watchdog ----------

// The watchdog lives here, not in a GitHub workflow, because GitHub's cron is the thing that
// fails: vigilar-noticias.yml ran once in 6 hours. Every tick (from 7:17 UTC, so the first edition
// of the day has had time to land) it reads the published data/meta.json and, if the edition is
// older than STALE_MINUTES, sends ONE push through ntfy.sh (set the NTFY_TOPIC variable, install the
// ntfy app and subscribe to that topic); another one when the news come back. The state is kept
// in KV and written only when it changes (KV allows 1,000 writes a day), and only after the push
// went out, so a failed push is retried on the next tick.
export const STALE_MINUTES = 90;

async function notify(env, message) {
  console.error(message);
  if (!env.NTFY_TOPIC) return;
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}`, {
    method: 'POST',
    headers: { title: 'Mi Diario', tags: 'newspaper' },
    body: message,
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}`);
}

export async function watchFreshness(env, scheduledTime) {
  const when = new Date(scheduledTime);
  if (!planRun(when) || when.getUTCHours() < 7) return;
  let age = null;
  try {
    const res = await env.ASSETS.fetch(new Request('https://assets.local/data/meta.json'));
    const t = res.ok ? Date.parse((await res.json()).generatedAt) : NaN;
    if (!Number.isNaN(t)) age = Math.round((scheduledTime - t) / 60e3);
  } catch {}
  if (age === null) return console.error('watchdog: cannot read data/meta.json');
  const wasStale = (await env.PROFILES.get('watch:state')) === 'stale';
  if (age > STALE_MINUTES && !wasStale) {
    await notify(env, `⚠️ Las noticias no se actualizan: la última edición es de hace ${age} min.`);
    await env.PROFILES.put('watch:state', 'stale');
  } else if (age <= STALE_MINUTES && wasStale) {
    await notify(env, '✅ Las noticias vuelven a actualizarse.');
    await env.PROFILES.put('watch:state', 'ok');
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchUpdate(env, event.scheduledTime));
    ctx.waitUntil(watchFreshness(env, event.scheduledTime).catch((err) => console.error(`watchdog: ${err.message}`)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const invites = parseInvites(env.INVITES);
    let user = null;

    if (invites.size) {
      if (url.pathname === '/login') return login(request, url, invites, env);
      if (url.pathname === '/logout') return logout();
      user = await currentUser(request, invites);
      if (!user && !PUBLIC.test(url.pathname)) {
        const isPage = request.method === 'GET' && (request.headers.get('accept') ?? '').includes('text/html');
        if (!isPage) return json({ error: 'login required' }, 401);
        return new Response(null, { status: 302, headers: { location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` } });
      }
    }

    if (url.pathname === '/api/me') return json(user ? { name: user.name, sync: await accountSync(user.name, user.code) } : { name: null });
    if (url.pathname.startsWith('/api/')) return profileApi(request, env, url);
    return env.ASSETS.fetch(request);
  },
};
