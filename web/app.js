import { loadProfile, saveProfile, pruneProfile, defaultProfile, migrate, isOn, listOf, setFlag, toRemote, mergeProfiles, orderedSections, moveSection } from './lib/profile.js';
import { rankStories, rankWeek, sortEntries, SORTS, train, topFeatures, featureLabel, sectionPref, scoreStory, emptyModel } from './lib/rank.js';
import { SECTIONS, SECTION_BY_ID, sectionLabel } from './lib/taxonomy.js';
import { isSpoiler } from './lib/spoilers.js';
import { applyCorrections, setCorrection, clearCorrection, listCorrections } from './lib/corrections.js';

const PAGE = 30;
const SESSION = Date.now();
const state = { data: null, profile: pruneProfile(loadProfile()), account: null, route: { view: 'foryou' }, limit: PAGE, revealed: new Set(), weekly: { index: null, weeks: new Map(), week: null } };
const $main = document.getElementById('main');
const $tabs = document.getElementById('tabs');
const $subtabs = document.getElementById('subtabs');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : '#');
const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

function timeAgo(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.parse(iso) - Date.now()) / 6e4);
  if (mins > -60) return rtf.format(Math.min(mins, 0), 'minute');
  if (mins > -1440) return rtf.format(Math.round(mins / 60), 'hour');
  return rtf.format(Math.round(mins / 1440), 'day');
}

function toast(text) {
  const el = Object.assign(document.createElement('div'), { className: 'toast', textContent: text, role: 'status' });
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

// prefs = an explicit preference changed (decides which copy wins when syncing).
// sync = a change other devices should get; it stays pending (sync.dirty) until a push succeeds.
function persist({ prefs = false, sync = true } = {}) {
  const now = Date.now();
  state.profile.updatedAt = now;
  if (prefs) state.profile.prefsAt = now;
  if (sync) state.profile.sync.dirty = now;
  saveProfile(state.profile);
  if (sync) scheduleSync();
}

const sourceNames = () => Object.fromEntries((state.data?.sources ?? []).map((s) => [s.id, s.name]));

// ---------- routing ----------

function parseRoute() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [view, sec, sub] = h.split('/');
  if (view === 's' && SECTION_BY_ID[sec]) return { view: 'section', sec, sub: SECTION_BY_ID[sec].subs.some((s) => s.id === sub) ? sub : null };
  if (['megusta', 'guardados', 'ajustes'].includes(view)) return { view };
  return { view: 'foryou' };
}

window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#sync=')) return linkSync(location.hash.slice(6));
  state.route = parseRoute();
  state.limit = PAGE;
  render();
  window.scrollTo({ top: 0 });
});

// Desktop: the tab bars hide their scrollbar, so let the mouse wheel and a click-drag scroll them sideways.
function scrollableSideways(bar) {
  bar.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return; // trackpads already scroll sideways
      const max = bar.scrollWidth - bar.clientWidth;
      if (max <= 0 || (e.deltaY < 0 && bar.scrollLeft <= 0) || (e.deltaY > 0 && bar.scrollLeft >= max - 1)) return;
      e.preventDefault();
      bar.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    },
    { passive: false },
  );
  let drag = null;
  bar.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button === 0) drag = { x: e.clientX, left: bar.scrollLeft, moved: false };
  });
  bar.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 5) return;
    if (!drag.moved) bar.setPointerCapture(e.pointerId);
    drag.moved = true;
    bar.scrollLeft = drag.left - dx;
  });
  let suppressClickUntil = 0;
  bar.addEventListener('click', (e) => {
    if (performance.now() < suppressClickUntil) e.preventDefault(); // a drag isn't a tap on the tab under the cursor
  }, true);
  const end = () => {
    if (drag?.moved) suppressClickUntil = performance.now() + 100;
    drag = null;
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', () => (drag = null));
  bar.addEventListener('dragstart', (e) => e.preventDefault()); // links would otherwise start a native drag
}
scrollableSideways($tabs);
scrollableSideways($subtabs);

// ---------- data ----------

async function loadData() {
  try {
    const res = await fetch('data/news.json', { cache: 'no-cache' });
    if (res.status === 401) return goLogin();
    if (!res.ok) throw new Error(res.status);
    state.data = await res.json();
  } catch {
    $main.innerHTML = `<div class="empty"><p>No se han podido cargar las noticias.</p><p class="muted">Comprueba la conexión o vuelve a intentarlo en un rato.</p></div>`;
    return;
  }
  showUpdated();
  render();
  if (!state.profile.onboarded && !location.hash.startsWith('#sync=')) openOnboarding();
}

const goLogin = () => location.assign(`/login?next=${encodeURIComponent(location.pathname + location.hash)}`);

// With login enabled, the account's own sync code replaces any device link: the profile is
// merged into the account and follows the person to every device where they log in.
// Returns true when it already pulled, so boot does not pull twice.
async function initAccount() {
  try {
    const res = await fetch('api/me', { cache: 'no-store' });
    if (res.status === 401) return goLogin();
    if (!res.ok) return;
    state.account = await res.json();
  } catch {
    return;
  }
  const code = state.account?.sync;
  if (!code || state.profile.sync.code === code) return;
  state.profile.sync = { code, lastPull: 0, lastPush: 0 };
  saveProfile(state.profile);
  const pulled = await pull();
  if (pulled) {
    // The account already has a profile: no need for the welcome questions on this device.
    state.profile.onboarded = true;
    document.getElementById('onboarding').close?.();
  }
  persist({ sync: false });
  return pulled;
}

function logout() {
  if (!confirm('¿Cerrar sesión? Tus gustos siguen guardados en tu cuenta.')) return;
  try {
    localStorage.clear();
  } catch {}
  location.assign('/logout');
}

function showUpdated() {
  if (state.data) document.getElementById('updated').textContent = `Actualizado ${timeAgo(state.data.generatedAt)}`;
}

// ---------- new editions while the app is open ----------

const CHECK_EVERY = 10 * 60e3;
let lastCheck = Date.now();

// Polls the tiny meta.json; if a newer edition exists, offers it without touching the page.
async function checkForUpdate() {
  if (!state.data) return;
  lastCheck = Date.now();
  try {
    const res = await fetch('data/meta.json', { cache: 'no-store' });
    if (!res.ok) return;
    const meta = await res.json();
    if (Date.parse(meta.generatedAt) > Date.parse(state.data.generatedAt)) showNewEdition();
  } catch {
    /* offline: try again later */
  }
}

function showNewEdition() {
  if (document.getElementById('new-edition')) return;
  const btn = Object.assign(document.createElement('button'), { id: 'new-edition', className: 'new-edition', textContent: 'Hay noticias nuevas · Actualizar' });
  btn.style.top = `${document.querySelector('.top').offsetHeight + 8}px`; // below the tabs and subtabs
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const res = await fetch('data/news.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      state.data = await res.json();
      state.limit = PAGE;
      state.weekly = { index: null, weeks: new Map(), week: state.weekly.week };
      showUpdated();
      render();
      window.scrollTo({ top: 0 });
      btn.remove();
    } catch {
      btn.disabled = false;
      toast('No se han podido cargar las noticias nuevas');
    }
  });
  document.body.append(btn);
}

setInterval(showUpdated, 60e3);
setInterval(checkForUpdate, CHECK_EVERY);

const findStory = (id) =>
  state.data?.stories.find((s) => s.id === id) ?? state.weekly.weeks.get(state.weekly.week)?.stories[id] ?? state.profile.liked[id]?.d ?? state.profile.saved[id]?.d;
const inSection = (story, key) => (story.sections ?? []).some((s) => s === key || s.startsWith(`${key}/`));

// ---------- views ----------

const href = (route) => (route.view === 'section' ? `#/s/${route.sec}${route.sub ? `/${route.sub}` : ''}` : route.view === 'foryou' ? '#/' : `#/${route.view}`);

function tabsHtml() {
  const r = state.route;
  const tabs = [[{ view: 'foryou' }, 'Para ti']];
  for (const s of orderedSections(state.profile)) if (sectionPref(state.profile, s.id) > -2) tabs.push([{ view: 'section', sec: s.id }, s.label]);
  tabs.push([{ view: 'megusta' }, '❤️ Me gusta'], [{ view: 'guardados' }, 'Guardados'], [{ view: 'ajustes' }, 'Ajustes']);
  return tabs
    .map(([route, label]) => {
      const active = route.view === r.view && route.sec === r.sec;
      return `<a class="tab${active ? ' active' : ''}" href="${href(route)}"${active ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
    })
    .join('');
}

function subtabsHtml() {
  const r = state.route;
  if (r.view !== 'section') return '';
  const sec = orderedSections(state.profile).find((s) => s.id === r.sec);
  const subs = sec.subs.filter((s) => sectionPref(state.profile, s.key) > -2);
  return [{ id: null, label: 'Todo' }, ...subs]
    .map((s) => `<a class="subtab${r.sub === s.id ? ' active' : ''}" href="${href({ view: 'section', sec: r.sec, sub: s.id })}">${esc(s.label)}</a>`)
    .join('');
}

// Section chips, skipping the one being browsed; other sections' subsections name their parent.
function chipsFor(story) {
  const r = state.route;
  const current = r.view === 'section' ? (r.sub ? `${r.sec}/${r.sub}` : r.sec) : null;
  return (story.sections ?? [])
    .filter((k) => k !== current)
    .slice(0, 2)
    .map((k) => `<span class="chip">${esc(sectionLabel(k, { withParent: k.includes('/') && k.split('/')[0] !== r.sec }))}</span>`)
    .join('');
}

function storyCard(entry) {
  const story = entry.story ?? entry;
  const p = state.profile;
  const [first, ...rest] = story.sources;
  const read = p.read[story.id] ? ' read' : '';
  // Weekly archive topics keep a few outlets and the count over the week (n); the date says more
  // than "hace 4 días", and how many days the topic lasted.
  const more = (story.n ?? story.sources.length) - 1;
  const when = story.n != null ? `${dayLabel(story.publishedAt)}${story.days > 1 ? ` · ${story.days} días` : ''}` : timeAgo(story.publishedAt);

  if (p.spoilers.nba && !state.revealed.has(story.id) && isSpoiler(story, p.spoilers.extra)) {
    return `<article class="card spoiler" data-id="${esc(story.id)}">
      <div class="body">
        <p class="meta"><strong>${esc(first.source)}</strong> · ${when} <span class="chip">NBA</span></p>
        <p class="spoiler-msg">🙈 Posible spoiler de la NBA</p>
        <div class="actions"><button data-act="reveal">Mostrar</button><button data-act="hide">Ocultar</button></div>
      </div>
    </article>`;
  }

  const liked = isOn(p.liked, story.id);
  const saved = isOn(p.saved, story.id);
  const text = story.aiSummary
    ? `<p class="summary"><span class="badge" title="Resumen generado con IA a partir de los titulares y extractos de los medios">IA</span> ${esc(story.aiSummary)}</p>`
    : story.summary
      ? `<p class="summary clamp" title="Toca para ver entero">${esc(story.summary)}</p>`
      : '';
  const why = entry.explore
    ? `<span class="why explore" title="Algo distinto a lo habitual, para que no te pierdas nada importante">✨ Para descubrir</span>`
    : (entry.reasons ?? []).length
      ? `<span class="why" title="Por lo que has marcado con me gusta, guardado o leído">♥ ${esc(entry.reasons.join(' · '))}</span>`
      : '';
  const others = rest.length
    ? `<details class="others"><summary>${rest.length === 1 ? 'También en 1 medio más' : `También en ${rest.length} medios más`}</summary><ul>${rest
        .map((s) => `<li><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener" data-open="${esc(story.id)}"><strong>${esc(s.source)}</strong> · ${esc(s.title)}</a></li>`)
        .join('')}</ul></details>`
    : '';
  // Weekly topics that go on from the week before link to it.
  const prev = story.prev
    ? `<p class="prevweek"><button data-act="week" data-week="${esc(story.prev.week)}" title="${esc(story.prev.title)}">↩ Viene de la semana pasada</button> <span class="muted">${story.prev.n} ${story.prev.n === 1 ? 'medio' : 'medios'} entonces</span></p>`
    : '';
  // Weekly topics: the other stories of the topic, in the order they came out.
  const related = story.related?.length
    ? `<details class="others"><summary>Cómo ha evolucionado (${story.related.length})</summary><ul>${story.related
        .map((r) => `<li><a href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener" data-open="${esc(story.id)}"><strong>${esc(dayLabel(r.publishedAt))}</strong> · ${esc(r.source)} · ${esc(r.title)}</a></li>`)
        .join('')}</ul></details>`
    : '';
  return `<article class="card${read}" data-id="${esc(story.id)}">
    ${story.image ? `<img class="thumb" src="${esc(safeUrl(story.image))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
    <div class="body">
      <p class="meta"><strong>${esc(first.source)}</strong>${more > 0 ? ` <span class="coverage" title="Llegó a cubrirla ${more + 1} medios">+${more}</span>` : ''} · ${when} ${chipsFor(story)}</p>
      <h2><a href="${esc(safeUrl(first.url))}" target="_blank" rel="noopener" data-open="${esc(story.id)}">${esc(story.title)}</a></h2>
      ${text}
      ${why}
      ${prev}
      ${related}
      ${others}
      <div class="actions card-actions">
        <button data-act="like" class="like" aria-pressed="${liked}" aria-label="Me gusta" title="Me gusta: verás más noticias así">${liked ? '❤️' : '🤍'}<span class="label"> Me gusta</span></button>
        <button data-act="dislike" aria-label="No me interesa" title="No me interesa: verás menos noticias así">👎</button>
        <button data-act="save" aria-pressed="${saved}" aria-label="${saved ? 'Guardada' : 'Guardar'}" title="${saved ? 'Guardada: quitar de Guardados' : 'Guardar para leer después'}">${saved ? '★' : '☆'}<span class="label"> ${saved ? 'Guardada' : 'Guardar'}</span></button>
        <button data-act="hide" aria-label="Ocultar" title="Ocultar solo esta noticia">✕<span class="label"> Ocultar</span></button>
        <button data-act="reclass" aria-label="Cambiar de sección" title="¿Está en la sección equivocada? Dime dónde va">🏷️<span class="label"> Sección</span></button>
      </div>
    </div>
  </article>`;
}

function listHtml(entries, emptyMsg) {
  if (!entries.length) return `<div class="empty"><p>${emptyMsg}</p></div>`;
  const page = entries.slice(0, state.limit);
  return `<div class="list">${page.map(storyCard).join('')}</div>${entries.length > page.length ? `<button class="more" data-act="more">Ver más</button>` : ''}`;
}

const collapsed = (() => {
  try {
    return new Set(JSON.parse(localStorage.getItem('midiario.collapsed') ?? '[]'));
  } catch {
    return new Set();
  }
})();

// How the feeds (Para ti and sections) are ordered; a per-device choice.
let sortMode = (() => {
  try {
    const v = localStorage.getItem('midiario.sort');
    return SORTS.some(([id]) => id === v) ? v : 'foryou';
  } catch {
    return 'foryou';
  }
})();

// Every feed (Para ti, sections, subsections) shows either the latest stories or the most important
// ones of a week. Per visit: the app always opens on "Ahora".
let feedMode = 'now';
// In "Semana": every topic, or only the ones the person has not opened. Per visit too.
let weekFilter = 'all';
// In "Semana": the most important topics, or the person's order ("Para mí"); a per-device choice.
let weekOrder = (() => {
  try {
    return localStorage.getItem('midiario.weekorder') === 'me' ? 'me' : 'top';
  } catch {
    return 'top';
  }
})();

const modeBar = () =>
  `<div class="modebar" role="group" aria-label="Qué noticias ver">${[['now', 'Ahora'], ['week', 'Semana']]
    .map(([id, label]) => `<button data-mode="${id}" aria-pressed="${feedMode === id}">${label}</button>`)
    .join('')}</div>`;

function feedHtml(ranked, emptyMsg) {
  const bar = `<div class="sortbar" role="group" aria-label="Ordenar noticias"><span class="muted small">Ordenar:</span>${SORTS.map(
    ([id, label]) => `<button data-sort="${id}" aria-pressed="${sortMode === id}">${label}</button>`,
  ).join('')}</div>`;
  return bar + listHtml(sortEntries(ranked, sortMode), emptyMsg);
}

// A collapsible AI summary; `id` remembers whether it was folded.
function briefingBox(id, title, text, note) {
  return `<details class="briefing" data-briefing="${esc(id)}"${collapsed.has(id) ? '' : ' open'}>
    <summary><h2>${esc(title)}</h2><span class="badge">IA</span></summary>
    <p>${esc(text)}</p>
    <p class="muted small">${note} Puede contener errores: abre las fuentes para contrastar.</p>
  </details>`;
}

function briefingHtml(key, title) {
  const b = state.data.briefings?.[key];
  if (!b) return '';
  return briefingBox(key, title, b.text, `Resumen generado con IA ${timeAgo(b.at)} a partir de los titulares de los medios.`);
}

// "La semana en …": Para ti, each section (not its subsections) and the NBA, as in "Ahora".
function weeklyBriefingHtml(week, key) {
  const b = week.briefings?.[key];
  if (!b) return '';
  const title = key === 'all' ? 'Lo importante de la semana' : key === 'eeuu/nba' ? 'La semana · NBA (sin resultados)' : `La semana · ${sectionLabel(key)}`;
  const note = b.final
    ? 'Resumen de la semana generado con IA a partir de sus noticias más importantes.'
    : `Resumen provisional generado con IA ${timeAgo(b.at)}: se rehace cada día hasta que acaba la semana.`;
  return briefingBox(`week:${key}`, title, b.text, note);
}

function sectionView() {
  const { sec, sub } = state.route;
  const key = sub ? `${sec}/${sub}` : sec;
  const s = SECTION_BY_ID[sec];
  if (feedMode === 'week') return modeBar() + weeklyView(key);
  const briefing = !sub ? briefingHtml(sec, `Lo importante · ${s.label}`) : key === 'eeuu/nba' ? briefingHtml(key, 'Lo importante · NBA (sin resultados)') : '';
  const stories = state.data.stories.filter((st) => inSection(st, key));
  return modeBar() + briefing + feedHtml(rankStories(stories, state.profile), 'No hay noticias de esta sección ahora mismo.');
}

// ---------- weekly archive ----------

const dayFmt = new Intl.DateTimeFormat('es', { weekday: 'short', day: 'numeric', month: 'short' });
const dayLabel = (iso) => (iso ? dayFmt.format(new Date(iso)) : '');

// "Del 5 al 11 de octubre" / "Del 28 de septiembre al 4 de octubre" (start and end are YYYY-MM-DD).
function weekLabel(w) {
  const d = (ymd) => new Date(`${ymd}T12:00:00Z`);
  const [a, b] = [d(w.start), d(w.end)];
  const month = (x) => x.toLocaleDateString('es', { month: 'long', timeZone: 'UTC' });
  const year = a.getUTCFullYear() !== new Date().getFullYear() ? ` de ${a.getUTCFullYear()}` : '';
  return a.getUTCMonth() === b.getUTCMonth()
    ? `Del ${a.getUTCDate()} al ${b.getUTCDate()} de ${month(b)}${year}`
    : `Del ${a.getUTCDate()} de ${month(a)} al ${b.getUTCDate()} de ${month(b)}${year}`;
}

// Fetches the list of weeks and the chosen week the first time the tab is opened, then renders.
function loadWeekly() {
  state.weekly.loading ??= fetchWeekly().finally(() => {
    state.weekly.loading = null;
    if (feedMode === 'week') render();
  });
}

async function fetchWeekly() {
  const wk = state.weekly;
  try {
    if (!wk.index) {
      const res = await fetch('data/weekly/index.json', { cache: 'no-cache' });
      if (res.status === 401) return goLogin();
      if (res.status === 404) wk.index = { weeks: [] };
      else if (!res.ok) throw new Error(res.status);
      else wk.index = await res.json();
      if (!wk.index.weeks.some((w) => w.id === wk.week)) wk.week = wk.index.weeks[0]?.id ?? null;
    }
    if (wk.week && !wk.weeks.has(wk.week)) {
      const res = await fetch(`data/weekly/${wk.week}.json`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      wk.weeks.set(wk.week, await res.json());
    }
    wk.error = false;
  } catch {
    wk.error = true;
  }
}

// "8 temas nuevos · 4 siguen de la semana pasada": what changed from the week before, when the week
// knows (weeks saved before topics did not link to the one before).
function weekSummary(week, stories) {
  if (!stories.some((st) => st.ids)) return '';
  const going = stories.filter((st) => st.prev).length;
  const fresh = stories.length - going;
  const parts = [fresh && `${fresh} ${fresh === 1 ? 'tema nuevo' : 'temas nuevos'}`, going && `${going} ${going === 1 ? 'sigue' : 'siguen'} de la semana pasada`].filter(Boolean);
  return parts.length ? `<p class="weeksum muted small">${parts.join(' · ')}</p>` : '';
}

// key: 'all' (Para ti), a section or a subsection.
function weeklyView(key) {
  const wk = state.weekly;
  if (wk.error) return `<div class="empty"><p>No se han podido cargar las noticias de la semana.</p><div class="actions center-row"><button data-act="weekly-retry">Reintentar</button></div></div>`;
  if (!wk.index || (wk.week && !wk.weeks.has(wk.week))) {
    loadWeekly();
    return '<p class="muted center">Cargando la semana…</p>';
  }
  if (!wk.index.weeks.length) return '<div class="empty"><p>Todavía no hay noticias de la semana.</p><p class="muted">Se irán guardando con cada edición: aquí quedarán las más importantes de cada semana.</p></div>';

  const weeks = wk.index.weeks; // newest first
  const i = weeks.findIndex((w) => w.id === wk.week);
  const w = weeks[i];
  const nav = `<div class="weeknav">
    <button data-act="week" data-week="${esc(weeks[i + 1]?.id ?? '')}"${weeks[i + 1] ? '' : ' disabled'} aria-label="Semana anterior">‹</button>
    <div><strong>${esc(weekLabel(w))}</strong><span class="muted small">${w.id === wk.index.current ? 'Semana en curso: se actualiza con cada edición' : 'Los temas que más medios cubrieron, y durante más días'}</span></div>
    <button data-act="week" data-week="${esc(weeks[i - 1]?.id ?? '')}"${i > 0 ? '' : ' disabled'} aria-label="Semana siguiente">›</button>
  </div>`;

  // The objective order (coverage over the week), only leaving out what the person has hidden or
  // filtered; or "Para mí": every topic the week published in this feed (not only its top list),
  // in the person's order, as many as the top list shows.
  const week = wk.weeks.get(wk.week);
  const size = key === 'all' ? 20 : 10;
  const entries =
    weekOrder === 'me'
      ? rankWeek(Object.values(week.stories).filter((st) => key === 'all' || inSection(st, key)), state.profile).slice(0, size)
      : (week.top[key] ?? []).map((id) => week.stories[id]).filter((st) => st && scoreStory(st, state.profile)).map((story) => ({ story }));
  const ranked = entries.map((entry, n) => ({ st: entry.story, entry, rank: n + 1 }));
  // What the person missed: topics none of whose stories they opened, liked or saved. Opened
  // stories are remembered for two weeks, so only this week and the one before can tell.
  const p = state.profile;
  const engaged = (st) => (st.ids ?? [st.id]).some((id) => p.read[id] || isOn(p.liked, id) || isOn(p.saved, id));
  const recent = Date.parse(`${w.end}T23:59:59Z`) > Date.now() - 14 * 864e5;
  const missed = recent ? ranked.filter(({ st }) => !engaged(st)) : [];
  const filter = recent && weekFilter === 'missed' ? 'missed' : 'all';
  const orders = [['top', 'Lo más importante'], ['me', 'Para mí']]
    .map(([id, label]) => `<button data-worder="${id}" aria-pressed="${weekOrder === id}">${label}</button>`)
    .join('');
  const filterBar =
    `<div class="sortbar" role="group" aria-label="Orden de los temas"><span class="muted small">Orden:</span>${orders}</div>` +
    (recent
      ? `<div class="sortbar" role="group" aria-label="Qué temas ver"><span class="muted small">Ver:</span><button data-wfilter="all" aria-pressed="${filter === 'all'}">Todos</button><button data-wfilter="missed" aria-pressed="${filter === 'missed'}">No abiertos (${missed.length})</button></div>`
      : '');
  const shown = filter === 'missed' ? missed : ranked;
  const list = shown.length
    ? `<ol class="list ranked">${shown.map(({ entry, rank }) => `<li data-rank="${rank}">${storyCard(entry)}</li>`).join('')}</ol>`
    : filter === 'missed'
      ? '<div class="empty"><p>Has abierto todos los temas importantes de esta semana.</p></div>'
      : '<div class="empty"><p>No hay noticias de esta sección esta semana.</p></div>';
  return nav + weekSummary(week, ranked.map(({ st }) => st)) + weeklyBriefingHtml(week, key) + filterBar + list;
}

function settingsHtml() {
  const p = state.profile;
  const levels = [[-2, 'Ocultar'], [0, 'Poco'], [1, 'Normal'], [2, 'Mucho'], [3, 'Me encanta']];
  const select = (key, isSub) => {
    const own = p.sections[key];
    const opts = (isSub ? [['', 'Como la sección']] : []).concat(levels);
    const current = own ?? (isSub ? '' : 1);
    return `<select data-section="${key}">${opts.map(([v, l]) => `<option value="${v}"${String(current) === String(v) ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  };
  const move = (key, label, i, n) =>
    `<span class="move"><button data-move="${key}" data-dir="-1" title="Subir ${esc(label)}" aria-label="Subir ${esc(label)}"${i === 0 ? ' disabled' : ''}>↑</button><button data-move="${key}" data-dir="1" title="Bajar ${esc(label)}" aria-label="Bajar ${esc(label)}"${i === n - 1 ? ' disabled' : ''}>↓</button></span>`;
  const sections = orderedSections(p);
  const sectionRows = sections
    .map(
      (s, i) => `<div class="group"><div class="row">${move(s.id, s.label, i, sections.length)}<label><strong>${s.label}</strong>${select(s.id, false)}</label></div>
      ${s.subs.map((sub, j) => `<div class="row sub">${move(sub.key, sub.label, j, s.subs.length)}<label><span>${sub.label}</span>${select(sub.key, true)}</label></div>`).join('')}</div>`,
    )
    .join('');

  const byName = new Map();
  for (const s of state.data.sources) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  const sourceRows = [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'es'))
    .map(([name, feeds]) => {
      const v = p.sources[feeds[0].id] ?? 0;
      const ok = feeds.some((f) => f.ok);
      return `<label class="row"><span>${esc(name)}${ok ? '' : ' <span class="muted small">(sin datos ahora)</span>'}</span><select data-source="${feeds.map((f) => f.id).join(',')}">
        <option value="1"${v === 1 ? ' selected' : ''}>Favorito</option><option value="0"${v === 0 ? ' selected' : ''}>Normal</option><option value="-1"${v === -1 ? ' selected' : ''}>Silenciar</option></select></label>`;
    })
    .join('');

  const names = sourceNames();
  const { pos, neg } = topFeatures(p.model);
  const featChips = (list) =>
    list.map(([k]) => `<button class="feat" data-forget="${esc(k)}" title="Olvidar">${esc(featureLabel(k, names))} ✕</button>`).join('') || '<span class="muted small">Nada todavía.</span>';
  const counts = `${listOf(p.liked).length} me gusta · ${listOf(p.saved).length} guardadas · ${Object.keys(p.disliked).length} “no me interesa” · ${p.model.n} señales aprendidas`;

  const sync = state.account?.name
    ? `<p>Has entrado como <strong>${esc(state.account.name)}</strong>. Tus gustos se guardan en tu cuenta: entra con tu código en cualquier dispositivo y los tendrás allí.</p>
       <div class="actions"><button data-act="sync-now">Sincronizar ahora</button><button data-act="logout">Cerrar sesión</button></div>`
    : p.sync.code
    ? `<p>Sincronización activada. Abre este enlace en tu otro dispositivo (móvil, PC…) para unirlo:</p>
       <input class="code" readonly value="${esc(syncLink())}" aria-label="Enlace de sincronización">
       <div class="actions"><button data-act="sync-copy">Copiar enlace</button>${navigator.share ? '<button data-act="sync-share">Compartir</button>' : ''}<button data-act="sync-now">Sincronizar ahora</button><button data-act="sync-off">Desactivar en este dispositivo</button></div>
       <p class="muted small">${p.sync.lastPull ? `Última sincronización ${timeAgo(new Date(Math.max(p.sync.lastPull, p.sync.lastPush)).toISOString())}.` : ''} Cualquiera con el enlace puede ver y cambiar tus preferencias de lectura: no lo compartas.</p>`
    : `<p>Usa la web en el móvil y en el PC con los mismos gustos: lo que aprendas en uno se aplica en el otro.</p>
       <div class="actions"><button data-act="sync-on">Activar sincronización</button></div>`;

  return `<section class="settings">
    <h2>Secciones</h2><p class="muted small">Cuánto te interesa cada sección. Las subsecciones heredan el valor de su sección salvo que elijas otro. “Ocultar” la quita de la navegación. Con ↑ ↓ cambias el orden de las pestañas y subsecciones.</p>
    ${sectionRows}
    ${Object.keys(p.order ?? {}).length ? '<div class="actions"><button data-act="reset-order">Restablecer el orden</button></div>' : ''}
    ${correctionsHtml()}
    <h2>Sin spoilers</h2>
    <label class="row"><span>Tapar resultados de la NBA (marcadores, quién gana…)</span><input type="checkbox" data-spoilers${p.spoilers.nba ? ' checked' : ''}></label>
    <label class="stack"><span>Otras palabras a tapar en la NBA (una por línea)</span><textarea data-spoiler-words rows="2" placeholder="playoffs">${esc(p.spoilers.extra.join('\n'))}</textarea></label>
    <h2>Lo que he aprendido de ti</h2>
    <p class="muted small">${counts}. Pulsa una etiqueta para que la olvide.</p>
    <p class="small"><strong>Te interesa:</strong></p><div class="feats">${featChips(pos)}</div>
    <p class="small"><strong>Te interesa poco:</strong></p><div class="feats">${featChips(neg)}</div>
    <div class="actions"><button data-act="reset-learning">Borrar todo lo aprendido</button></div>
    <h2>${state.account?.name ? 'Tu cuenta' : 'Sincronizar dispositivos'}</h2>${sync}
    <h2>Idiomas</h2>
    <label class="row"><span>Español</span><input type="checkbox" data-lang="es"${p.langs.includes('es') ? ' checked' : ''}></label>
    <label class="row"><span>Inglés</span><input type="checkbox" data-lang="en"${p.langs.includes('en') ? ' checked' : ''}></label>
    <h2>Palabras clave</h2>
    <label class="stack"><span>Potenciar (una por línea)</span><textarea data-kw="boostKeywords" rows="3" placeholder="fusión nuclear&#10;Wembanyama">${esc(p.boostKeywords.join('\n'))}</textarea></label>
    <label class="stack"><span>Silenciar (una por línea)</span><textarea data-kw="muteKeywords" rows="3" placeholder="horóscopo">${esc(p.muteKeywords.join('\n'))}</textarea></label>
    <h2>Medios</h2>${sourceRows}
    <h2>Copia de seguridad</h2>
    <div class="actions">
      <button data-act="export">Exportar perfil</button>
      <label class="button">Importar perfil<input type="file" accept="application/json" data-act="import" hidden></label>
      <button data-act="onboarding">Repetir configuración inicial</button>
    </div>
    <p class="muted small">Las noticias enlazan siempre al medio original.</p>
  </section>`;
}

function render() {
  if (!state.data) return;
  applyCorrections(state.data.stories, state.profile);
  $tabs.innerHTML = tabsHtml();
  $subtabs.innerHTML = subtabsHtml();
  $subtabs.hidden = state.route.view !== 'section';
  const p = state.profile;
  const v = state.route.view;
  let html;
  if (v === 'foryou' && feedMode === 'week') html = modeBar() + weeklyView('all');
  else if (v === 'foryou') html = modeBar() + briefingHtml('portada', 'Lo importante ahora') + feedHtml(rankStories(state.data.stories, p, Date.now(), { explore: true }), 'No hay noticias que encajen con tus filtros.');
  else if (v === 'section') html = sectionView();
  else if (v === 'megusta') html = listHtml(listOf(p.liked), 'Aún no has marcado ninguna noticia con ❤️. Cada me gusta enseña a la web lo que te interesa.');
  else if (v === 'guardados') html = listHtml(listOf(p.saved), 'Aún no has guardado noticias.');
  else html = settingsHtml();
  $main.innerHTML = html;
  observeCards();
  document.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---------- interactions ----------

function learn(story, signal) {
  train(state.profile.model, story, signal);
}

function rerenderCard(card, story) {
  const entry = rankStories([story], state.profile)[0] ?? { story };
  card.outerHTML = storyCard(entry);
}

$main.addEventListener('click', (e) => {
  const extract = e.target.closest('.summary.clamp');
  if (extract) {
    extract.classList.toggle('open');
    return;
  }
  const link = e.target.closest('[data-open]');
  if (link) {
    const story = findStory(link.dataset.open);
    if (story && !state.profile.read[story.id]) {
      state.profile.read[story.id] = Date.now();
      learn(story, 'open');
      persist();
      link.closest('.card')?.classList.add('read');
    }
    return;
  }
  const mode = e.target.closest('[data-mode]');
  if (mode) {
    feedMode = mode.dataset.mode;
    state.limit = PAGE;
    return render();
  }
  const worder = e.target.closest('[data-worder]');
  if (worder) {
    weekOrder = worder.dataset.worder;
    try {
      localStorage.setItem('midiario.weekorder', weekOrder);
    } catch {}
    return render();
  }
  const wfilter = e.target.closest('[data-wfilter]');
  if (wfilter) {
    weekFilter = wfilter.dataset.wfilter;
    return render();
  }
  const sort = e.target.closest('[data-sort]');
  if (sort) {
    sortMode = sort.dataset.sort;
    try {
      localStorage.setItem('midiario.sort', sortMode);
    } catch {}
    state.limit = PAGE;
    return render();
  }
  const mover = e.target.closest('[data-move]');
  if (mover) {
    if (!moveSection(state.profile, mover.dataset.move, Number(mover.dataset.dir))) return;
    persist({ prefs: true });
    render();
    // Keep the focus on the moved row's button so it can be pressed again.
    document.querySelector(`[data-move="${mover.dataset.move}"][data-dir="${mover.dataset.dir}"]:not(:disabled)`)?.focus({ preventScroll: true });
    return;
  }
  const forget = e.target.closest('[data-forget]');
  if (forget) {
    delete state.profile.model.w[forget.dataset.forget];
    persist();
    forget.remove();
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.tagName === 'INPUT') return;
  const act = btn.dataset.act;
  const p = state.profile;
  if (act === 'more') {
    state.limit += PAGE;
    return render();
  }
  if (act === 'export') return exportProfile();
  if (act === 'onboarding') return openOnboarding();
  if (act === 'logout') return logout();
  if (act === 'reset-learning') {
    if (confirm('¿Borrar todo lo aprendido? Se mantienen tus secciones, medios y noticias guardadas.')) {
      p.model = emptyModel();
      p.model.t = Date.now();
      persist();
      render();
    }
    return;
  }
  if (act === 'reset-order') {
    p.order = {};
    persist({ prefs: true });
    return render();
  }
  if (act.startsWith('sync-')) return syncAction(act);
  if (act === 'unreclass') {
    clearCorrection(p, btn.dataset.id);
    persist();
    return render();
  }
  if (act === 'copy-reclass') return copyCorrections();
  if (act === 'week' && btn.dataset.week) {
    state.weekly.week = btn.dataset.week;
    render();
    return window.scrollTo({ top: 0 });
  }
  if (act === 'weekly-retry') {
    state.weekly.error = false;
    return render();
  }

  const card = btn.closest('.card');
  const story = card && findStory(card.dataset.id);
  if (!story) return;
  if (act === 'reveal') {
    state.revealed.add(story.id);
    return rerenderCard(card, story);
  }
  if (act === 'reclass') return openReclass(story);
  if (act === 'like') {
    const on = !isOn(p.liked, story.id);
    setFlag(p.liked, story, on);
    learn(story, on ? 'like' : 'unlike');
    if (on) toast('❤️ Anotado: verás más noticias así');
  } else if (act === 'save') {
    const on = !isOn(p.saved, story.id);
    setFlag(p.saved, story, on);
    if (on) learn(story, 'save');
  } else if (act === 'dislike') {
    p.disliked[story.id] = Date.now();
    learn(story, 'dislike');
    toast('👎 Anotado: verás menos noticias así');
  } else if (act === 'hide') {
    p.hidden[story.id] = Date.now();
    learn(story, 'hide');
  }
  persist();
  const leaves = act === 'hide' || act === 'dislike' || (state.route.view === 'megusta' && act === 'like') || (state.route.view === 'guardados' && act === 'save');
  if (leaves) (card.parentElement.tagName === 'LI' ? card.parentElement : card).remove();
  else rerenderCard(card, story);
});

$main.addEventListener(
  'toggle',
  (e) => {
    const key = e.target.dataset?.briefing;
    if (!key) return;
    if (e.target.open) collapsed.delete(key);
    else collapsed.add(key);
    try {
      localStorage.setItem('midiario.collapsed', JSON.stringify([...collapsed]));
    } catch {}
  },
  true,
);

$main.addEventListener('change', (e) => {
  const el = e.target;
  const p = state.profile;
  if (el.dataset.section) {
    if (el.value === '') delete p.sections[el.dataset.section];
    else p.sections[el.dataset.section] = Number(el.value);
  } else if (el.dataset.source) for (const id of el.dataset.source.split(',')) p.sources[id] = Number(el.value);
  else if (el.dataset.lang) {
    const langs = [...document.querySelectorAll('[data-lang]')].filter((c) => c.checked).map((c) => c.dataset.lang);
    if (!langs.length) {
      el.checked = true;
      return toast('Deja al menos un idioma');
    }
    p.langs = langs;
  }
  else if (el.dataset.kw) p[el.dataset.kw] = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
  else if ('spoilers' in el.dataset) p.spoilers.nba = el.checked;
  else if ('spoilerWords' in el.dataset) p.spoilers.extra = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
  else if (el.dataset.act === 'import') return importProfile(el.files[0]);
  else return;
  persist({ prefs: true });
  $tabs.innerHTML = tabsHtml();
});

function exportProfile() {
  const blob = new Blob([JSON.stringify(state.profile, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'mi-diario-perfil.json' });
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importProfile(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (typeof data !== 'object' || !(data.sections || data.topics)) throw new Error();
    state.profile = { ...migrate(data), sync: state.profile.sync, onboarded: true, prefsAt: Date.now() };
    persist();
    render();
  } catch {
    alert('El archivo no es un perfil válido.');
  }
}

// ---------- impressions: stories you keep scrolling past ----------

let observer;
const timers = new Map();

function observeCards() {
  observer?.disconnect();
  timers.forEach(clearTimeout);
  timers.clear();
  if (!['foryou', 'section'].includes(state.route.view) || feedMode === 'week' || !('IntersectionObserver' in window)) return;
  observer = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        const id = en.target.dataset.id;
        if (en.isIntersecting) timers.set(id, setTimeout(() => markSeen(id), 1500));
        else clearTimeout(timers.get(id));
      }
    },
    { threshold: 0.6 },
  );
  // Covered spoilers are left out: a card that cannot be read is not a story you chose to skip.
  document.querySelectorAll('.card[data-id]:not(.spoiler)').forEach((c, i) => i < 20 && observer.observe(c));
}

// Seen near the top in 3 different visits and never opened → mild "not for me" for its section/outlet.
function markSeen(id) {
  const p = state.profile;
  const e = (p.seen[id] ??= { n: 0 });
  e.t = Date.now();
  if (e.s !== SESSION) {
    e.n++;
    e.s = SESSION;
  }
  const story = findStory(id);
  if (e.n >= 3 && !e.k && story && !p.read[id] && !isOn(p.liked, id) && !isOn(p.saved, id)) {
    e.k = 1;
    learn(story, 'skip');
    persist();
  } else persist({ sync: false });
}

// ---------- sync between devices ----------

const API = (code) => `api/profile/${code}`;
const KEEPALIVE_MAX = 60_000; // browsers drop keepalive requests over 64 KB
const syncLink = () => `${location.origin}${location.pathname}#sync=${state.profile.sync.code}`;
let pushTimer;
let pushPending = false;

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function scheduleSync() {
  if (!state.profile.sync.code) return;
  pushPending = true;
  clearTimeout(pushTimer);
  // Pull first: it merges what other devices sent and then pushes, so a device with an old copy
  // never overwrites the server with it.
  pushTimer = setTimeout(pull, 15000);
}

async function push({ keepalive = false } = {}) {
  const p = state.profile;
  if (!p.sync.code) return;
  clearTimeout(pushTimer);
  pushPending = false;
  const dirty = p.sync.dirty;
  const body = JSON.stringify(toRemote(p));
  try {
    keepalive &&= new TextEncoder().encode(body).length < KEEPALIVE_MAX;
    const res = await fetch(API(p.sync.code), { method: 'PUT', headers: { 'content-type': 'application/json' }, body, keepalive });
    if (!res.ok) throw new Error(res.status);
    const { sync } = state.profile;
    sync.lastPush = Date.now();
    if (sync.dirty === dirty) sync.dirty = false; // nothing new while uploading
    saveProfile(state.profile);
  } catch {
    pushPending = true;
  }
}

async function pull() {
  const p = state.profile;
  if (!p.sync.code) return false;
  try {
    const res = await fetch(API(p.sync.code), { cache: 'no-store' });
    if (res.status === 404) {
      await push();
      return false;
    }
    if (!res.ok) throw new Error(res.status);
    const remote = await res.json();
    // Merge into the current copy: the person may have changed something while this was loading.
    const local = state.profile;
    const merged = mergeProfiles(local, remote);
    merged.sync = { ...local.sync, lastPull: Date.now() };
    merged.seen = local.seen;
    state.profile = merged;
    saveProfile(merged);
    // Upload only when this device has changes the server lacks: a PUT on every pull would spend
    // the free KV quota (1,000 writes a day). Older profiles have no flag yet and push once.
    if (merged.sync.dirty !== false) await push();
    return true;
  } catch {
    return false;
  }
}

async function syncAction(act) {
  const p = state.profile;
  if (act === 'sync-on') {
    p.sync.code = newCode();
    persist();
    await push();
    toast('Sincronización activada');
  } else if (act === 'sync-off') {
    if (!confirm('¿Desactivar la sincronización en este dispositivo? Tus datos se quedan aquí.')) return;
    p.sync = { code: null, lastPull: 0, lastPush: 0 };
    saveProfile(p);
  } else if (act === 'sync-copy') {
    try {
      await navigator.clipboard.writeText(syncLink());
      toast('Enlace copiado');
    } catch {
      document.querySelector('input.code')?.select();
    }
    return;
  } else if (act === 'sync-share') {
    navigator.share({ title: 'Mi Diario: sincronizar', url: syncLink() }).catch(() => {});
    return;
  } else if (act === 'sync-now') {
    toast((await pull()) && !pushPending ? 'Sincronizado' : 'No se ha podido sincronizar');
  }
  render();
}

// Opening #sync=CODE on a new device joins it to that profile.
async function linkSync(code) {
  history.replaceState(null, '', location.pathname + '#/');
  state.route = { view: 'foryou' };
  if (state.account?.name) {
    // With login the account already syncs every device; a device link would replace it.
    toast('Ya sincronizas con tu cuenta: no hace falta el enlace');
    return render();
  }
  if (!/^[a-f0-9]{32}$/.test(code)) return toast('Enlace de sincronización no válido');
  state.profile.sync = { code, lastPull: 0, lastPush: 0 };
  saveProfile(state.profile);
  const ok = await pull();
  if (ok) state.profile.onboarded = true;
  persist({ sync: false });
  document.getElementById('onboarding').close?.();
  toast(ok ? 'Dispositivo unido: tus gustos ya están aquí' : 'No se ha podido sincronizar');
  render();
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden' && pushPending) push({ keepalive: true });
  if (document.visibilityState === 'visible') {
    showUpdated();
    if (Date.now() - lastCheck > 60e3) checkForUpdate();
  }
  if (document.visibilityState === 'visible' && state.profile.sync.code && Date.now() - state.profile.sync.lastPull > 20e3) {
    if (await pull()) render();
  }
});

// ---------- section corrections ----------

// "Esta noticia va en otra sección": pick where it belongs. Applies to this story and to similar ones.
function openReclass(story) {
  const dlg = document.getElementById('reclass');
  const current = new Set(story.sections ?? []);
  const pick = (key, label) => `<label class="pick"><input type="checkbox" name="s" value="${key}"${current.has(key) ? ' checked' : ''}><span>${esc(label)}</span></label>`;
  dlg.innerHTML = `<form method="dialog" class="onboarding">
    <h2>¿Dónde va esta noticia?</h2>
    <p class="small"><strong>${esc(story.title)}</strong></p>
    <p class="muted small">Marca sus secciones y desmarca las que sobran. Lo recordaré también para noticias parecidas (la misma historia en otros medios).</p>
    ${orderedSections(state.profile).map((s) => `<fieldset><legend>${s.label}</legend><div class="chips">${pick(s.id, `${s.label} (general)`)}${s.subs.map((sub) => pick(sub.key, sub.label)).join('')}</div></fieldset>`).join('')}
    <div class="actions"><button value="cancel" formnovalidate>Cancelar</button>${story.corrected === 'own' ? '<button value="reset">Volver a la original</button>' : ''}<button class="primary" value="ok">Guardar</button></div>
  </form>`;
  const form = dlg.querySelector('form');
  form.addEventListener('submit', (e) => {
    const choice = e.submitter?.value;
    if (choice === 'cancel') return;
    const picked = new FormData(form).getAll('s');
    // A subsection already implies its section, as the classifier does.
    const sections = picked.filter((k) => k.includes('/') || !picked.some((x) => x.startsWith(`${k}/`)));
    if (choice === 'reset') clearCorrection(state.profile, story.id);
    else setCorrection(state.profile, story, sections);
    persist();
    render();
    if (choice !== 'reset') toast(sections.length ? '🏷️ Anotado: la muevo de sección' : '🏷️ Anotado: queda solo en Para ti');
  });
  dlg.showModal();
}

function correctionsHtml() {
  const list = listCorrections(state.profile);
  if (!list.length) return '';
  const label = (keys) => (keys.length ? keys.map((k) => sectionLabel(k, { withParent: k.includes('/') })).join(', ') : 'ninguna');
  const rows = list
    .slice(0, 20)
    .map((c) => `<div class="row"><span class="small">${esc(c.ti)}<br><span class="muted">${esc(label(c.o))} → ${esc(label(c.s))}</span></span><button class="feat" data-act="unreclass" data-id="${esc(c.id)}" title="Deshacer">✕</button></div>`)
    .join('');
  return `<h2>Secciones corregidas</h2>
    <p class="muted small">Noticias que has movido de sección con 🏷️. También se aplican a noticias parecidas. Copia la lista y pásasela a quien mantiene la web para mejorar el clasificador para todos.</p>
    ${rows}
    <div class="actions"><button data-act="copy-reclass">Copiar la lista</button></div>`;
}

async function copyCorrections() {
  const text = listCorrections(state.profile)
    .map((c) => `- ${c.ti}\n  ${c.o.join(', ') || '—'} → ${c.s.join(', ') || '—'}`)
    .join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('Lista copiada');
  } catch {
    toast('No se ha podido copiar');
  }
}

// ---------- onboarding ----------

function openOnboarding() {
  const dlg = document.getElementById('onboarding');
  const p = state.profile;
  const pick = (key, label) => `<label class="pick"><input type="checkbox" name="s" value="${key}"${sectionPref(p, key) >= 3 ? ' checked' : ''}><span>${esc(label)}</span></label>`;
  dlg.innerHTML = `<form method="dialog" class="onboarding">
    <h2>Bienvenido a Mi Diario</h2>
    <p>Marca lo que más te interesa. Después, cada ❤️ que des enseñará a la web tus gustos.</p>
    ${orderedSections(p).map((s) => `<fieldset><legend>${s.label}</legend><div class="chips">${pick(s.id, `Todo ${s.label}`)}${s.subs.map((sub) => pick(sub.key, sub.label)).join('')}</div></fieldset>`).join('')}
    <fieldset><legend>Idiomas</legend><div class="chips">
      <label class="pick"><input type="checkbox" name="lang" value="es"${p.langs.includes('es') ? ' checked' : ''}><span>Español</span></label>
      <label class="pick"><input type="checkbox" name="lang" value="en"${p.langs.includes('en') ? ' checked' : ''}><span>Inglés</span></label>
    </div></fieldset>
    ${state.account?.name ? '' : '<p class="muted small">¿Ya la usas en otro dispositivo? Activa “Sincronizar” en sus Ajustes y abre aquí el enlace.</p>'}
    <button class="primary" value="ok">Empezar</button>
  </form>`;
  dlg.querySelector('form').addEventListener('submit', () => {
    // A sync pull while the dialog was open may have replaced the profile object: edit the current one.
    const p = state.profile;
    const f = new FormData(dlg.querySelector('form'));
    const picked = new Set(f.getAll('s'));
    for (const s of SECTIONS) {
      for (const key of [s.id, ...s.subs.map((x) => x.key)]) {
        if (picked.has(key)) p.sections[key] = 3;
        else if (p.sections[key] === 3) delete p.sections[key];
      }
    }
    const langs = f.getAll('lang');
    p.langs = langs.length ? langs : ['es', 'en'];
    p.onboarded = true;
    persist({ prefs: true });
    render();
  });
  dlg.showModal();
}

// ---------- boot ----------

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
state.route = parseRoute();
const boot = Promise.all([loadData(), initAccount()]);
if (location.hash.startsWith('#sync=')) boot.then(() => linkSync(location.hash.slice(6)));
else boot.then(([, pulled]) => pulled || pull()).then((changed) => changed && render());
