// Weekly archive ("Semanal"): the most important topics of each week, for the whole paper and for
// every section and subsection. Each edition only holds the last 48 h, so every run folds its
// stories into the week they started in (Monday to Sunday, Spain time).
//
// Each week keeps a pool of its stories (not published): every outlet that covered each one on each
// day, its links, the proper names of its headlines and its vector. The published week is rebuilt
// from the pool on every run:
//  - Topics: stories told on different days or split by the daily grouping (the truce, the
//    reactions, the first violations) join through their vectors and shared names, with average
//    linkage as in cluster.js but a whole week apart. A topic shows its most covered story, with
//    the others as its timeline.
//  - Continuity: a topic that goes on from the week before links to it (`prev`), matched the same
//    way as stories join a topic.
//  - Importance: distinct outlets over the whole week, plus a quarter of every further day an
//    outlet came back to it (a story that stays on the front pages for days beats a one-day one
//    with as many outlets), then the languages it was told in. Specialised outlets (sport, science,
//    technology) count half: their coverage says a story matters in its field, a general paper's
//    that it matters. Soft topics (memes, gossip, deals, lottery) weigh less, and service pieces
//    ("dónde ver", live pages, galleries) never head a topic.
//
// Files (web/data/weekly/): index.json lists the weeks; <week>.json is the published week and
// <week>.pool.json its pool (left out of the site by web/.assetsignore).

import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECTIONS, compileKeywords } from '../../web/lib/taxonomy.js';
import { isNbaStory } from '../../web/lib/spoilers.js';
import { averageLinkage, features, pairScore } from './cluster.js';
import { dot, fromInt8B64, normalizeVec, toInt8B64 } from './embed.js';
import { hash, normalize } from './text.js';

export const TOP_N = 10;
export const TOP_ALL = 20;
export const KEEP_WEEKS = 12;
// The pool keeps the stories of the topics shown and, with 2+ outlets, of the ones up to POOL_N in
// some list: room for a story to keep gathering outlets before it makes a list.
const POOL_N = 30;
const MAX_SOURCES = 6;
const MAX_RELATED = 8;
const MAX_IDS = 40;
const MAX_URLS = 60;
const MAX_ENTS = 40;
const MAX_EXTRACT = 280;
const TZ = 'Europe/Madrid';
// Topics. Calibrated by hand on the weeks of October 2026: lower thresholds, or a single shared
// name, join stories that only share a field (Spanish sport, Spanish politics).
export const TOPIC_LINK = 0.72;
export const TOPIC_MIN_SHARED = 2;
// Weight of every outlet-day after the first one of each outlet.
export const REPEAT_WEIGHT = 0.25;
// A section belongs to a topic when its stories hold this share of the topic's coverage, as in
// cluster.js; NBA is always kept (spoiler cover).
const MIN_SHARE = 0.25;
// Weight of an outlet whose feeds all belong to one field (SPECIALIST_FIELDS); `weight` on any feed
// of an outlet in sources.json overrides it.
export const SPECIALIST_WEIGHT = 0.5;
// Score of a topic whose stories are mostly soft (SOFT below).
export const SOFT_FACTOR = 0.6;

// ---------- outlets and headlines ----------

const FIELDS = [
  ['deportes', /^(deportes|espana\/deportes|eeuu\/(nba|nfl|universitario))(\/|$)/],
  ['ciencia', /^ciencia(\/|$)/],
  ['tecnologia', /^tecnologia(\/|$)/],
];
const fieldOf = (section) => FIELDS.find(([, re]) => re.test(section))?.[0] ?? 'general';

// Outlet name → weight, from the feeds of sources.json.
export function outletWeights(sources) {
  const feeds = new Map();
  for (const f of sources) feeds.set(f.name, [...(feeds.get(f.name) ?? []), f]);
  const weights = new Map();
  for (const [name, list] of feeds) {
    const explicit = list.find((f) => typeof f.weight === 'number')?.weight;
    const fields = new Set(list.flatMap((f) => f.sections ?? []).map(fieldOf));
    const specialist = fields.size === 1 && !fields.has('general');
    weights.set(name, explicit ?? (specialist ? SPECIALIST_WEIGHT : 1));
  }
  return weights;
}
const SOURCES = resolve(dirname(fileURLToPath(import.meta.url)), '../../sources.json');
const WEIGHTS = outletWeights(JSON.parse(readFileSync(SOURCES, 'utf8')));
const weightOf = (outlet) => WEIGHTS.get(outlet) ?? 1;

// Service pieces: the topic is real, the headline is not the one to lead it with.
const SERVICE = compileKeywords([
  'a que hora es', 'a que hora juega', 'horario y donde ver', 'donde ver', 'como ver', 'en directo', 'ultima hora', 'minuto a minuto',
  'asi te hemos contado', 'asi hemos contado', 'fotos', 'en imagenes', 'galeria', 'how to watch', 'where to watch', 'live stream*',
  'live updates', 'as it happened', 'in pictures', 'photos',
]);
// Soft topics: what goes viral, celebrities' lives, shopping, lottery.
const SOFT = compileKeywords([
  'memes', 'meme', 'se hace viral', 'se vuelve viral', 'se viraliza', 'viraliza*', 'goes viral', 'went viral', 'video viral',
  'las redes se llenan', 'arde en redes', 'incendia las redes', 'revoluciona las redes', 'estalla en redes', 'internet se rinde',
  'botox', 'famosos', 'famosas', 'celebrity', 'celebrities', 'influencer*', 'tiktoker*', 'youtuber*', 'reality show', 'prensa rosa',
  'boda', 'se casa', 'divorcio', 'ruptura sentimental', 'nueva novia', 'nuevo novio', 'horoscopo', 'loteria', 'sorteo extraordinario',
  'el gordo', 'chollo*', 'mejores ofertas', 'fiesta de ofertas', 'prime day', 'black friday', 'rebajas', 'best deals', 'deal of the day',
]);
const matches = (res, text) => {
  const t = normalize(text ?? '');
  return res.some((re) => re.test(t));
};
const isService = (title) => matches(SERVICE, title);
// A story is soft when its headline is, or half of its outlets' headlines are.
const isSoft = (e) => matches(SOFT, e.title) || e.sources.filter((x) => matches(SOFT, x.title)).length * 2 >= Math.max(e.sources.length, 2);

export const WEEKLY_KEYS = ['all', ...SECTIONS.flatMap((s) => [s.id, ...s.subs.map((x) => x.key)])];

const ymd = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return [Number(p.year), Number(p.month), Number(p.day)];
};
const iso = (d) => d.toISOString().slice(0, 10);
const dayOf = (ms) => ymd(ms).map((x, i) => String(x).padStart(i ? 2 : 4, '0')).join('-');

// ISO week of a moment in Spain: { id: '2026-W41', start: '2026-10-05', end: '2026-10-11' }.
export function weekOf(ms) {
  const [y, m, d] = ymd(ms);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = (date.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(date.getTime() - dow * 864e5);
  const thursday = new Date(monday.getTime() + 3 * 864e5); // the ISO year is the Thursday's
  const year = thursday.getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * 864e5));
  return { id: `${year}-W${String(week).padStart(2, '0')}`, start: iso(monday), end: iso(new Date(monday.getTime() + 6 * 864e5)) };
}

const inKey = (story, key) => key === 'all' || story.sections.some((s) => s === key || s.startsWith(`${key}/`));

// When the story started: its oldest article.
const firstSeen = (story) => story.sources.map((s) => s.publishedAt).filter(Boolean).sort()[0] ?? story.publishedAt;

// Proper names and numbers of all its headlines and its extract (cluster.js). The dash makes the
// first word of a headline count too: across a week, headlines are all a topic has in common.
function headlineEntities(titles, summary) {
  const out = new Set();
  for (const t of titles) for (const e of features({ title: `— ${t}` }).ents) out.add(e);
  for (const e of features({ title: '', summary: summary ?? '' }).ents) out.add(e);
  return [...out].slice(0, MAX_ENTS);
}

// ---------- pool ----------

// What the pool keeps of a story of an edition. The fields shown (title, sources…) all come from
// one copy of the story, the one with the most outlets (`best`), so a headline never shows with the
// outlets of another story. `cov`: day → outlets that published an article of it that day, by name
// (an outlet has several feeds: El País international one day and its front page the next is one).
function entryOf(story, now) {
  const at = firstSeen(story) ?? new Date(now).toISOString();
  // A service headline ("A qué hora es…") gives way to another outlet's, when there is one.
  const lead = isService(story.title) ? story.sources.find((x) => !isService(x.title)) : null;
  const sources = lead ? [lead, ...story.sources.filter((x) => x !== lead)] : story.sources;
  const cov = {};
  for (const s of story.sources) {
    const day = dayOf(Date.parse(s.publishedAt ?? story.publishedAt ?? at) || now);
    (cov[day] ??= new Set()).add(s.source ?? s.sourceId);
  }
  const e = {
    id: story.id,
    title: lead?.title ?? story.title,
    image: story.image,
    lang: story.lang,
    // Editions from before langs existed (the backfill reads old ones) only have lang.
    langs: story.langs ?? [story.lang].filter(Boolean),
    sections: story.sections ?? [],
    publishedAt: at,
    best: story.sources.length,
    sources: sources.slice(0, MAX_SOURCES).map(({ title, url, source, sourceId }) => ({ title, url, source, sourceId })),
    cov: Object.fromEntries(Object.entries(cov).map(([d, ids]) => [d, [...ids]])),
    urls: story.sources.map((s) => hash(s.url)).slice(0, MAX_URLS),
    ents: headlineEntities([story.title, ...story.sources.map((s) => s.title)], story.summary),
  };
  if (story.aiSummary) e.aiSummary = story.aiSummary;
  // The extract is the service piece's: it would not match the new headline.
  else if (story.summary && !lead) e.summary = story.summary.length > MAX_EXTRACT ? `${story.summary.slice(0, MAX_EXTRACT - 1)}…` : story.summary;
  if (story.spoiler) e.spoiler = true;
  if (story.vec) e.vec = toInt8B64(story.vec);
  return e;
}

const union = (a = [], b = [], max = Infinity) => [...new Set([...a, ...b])].slice(0, max);

// The same story seen again (or under another id, when an older article joined it): adds up what
// both copies saw and shows the most covered one.
function mergeEntries(old, cur) {
  const shown = cur.best >= old.best ? cur : old;
  const out = { ...shown, id: cur.id, best: Math.max(old.best, cur.best) };
  out.langs = union(old.langs, cur.langs);
  out.publishedAt = old.publishedAt < cur.publishedAt ? old.publishedAt : cur.publishedAt;
  out.cov = { ...old.cov };
  for (const [d, ids] of Object.entries(cur.cov)) out.cov[d] = union(out.cov[d], ids);
  out.urls = union(cur.urls, old.urls, MAX_URLS);
  out.ents = union(cur.ents, old.ents, MAX_ENTS);
  const ai = cur.aiSummary ?? old.aiSummary;
  if (ai) {
    out.aiSummary = ai;
    delete out.summary;
  }
  if (old.spoiler || cur.spoiler) out.spoiler = true; // once a spoiler, always covered
  if (cur.vec ?? old.vec) out.vec = cur.vec ?? old.vec;
  return out;
}

// Pool of a week saved before pools existed (or whose pool file was lost): its published stories,
// with the outlet count they kept (`n`) and the outlets listed, all on the day they started.
function legacyPool(week) {
  const pool = {};
  for (const s of Object.values(week.stories ?? {})) {
    const { n, days, score, soft, related, ids, prev, ...rest } = s;
    pool[s.id] = {
      ...rest,
      best: n ?? s.sources.length,
      cov: { [dayOf(Date.parse(s.publishedAt))]: union(s.sources.map((x) => x.source ?? x.sourceId)) },
      urls: s.sources.map((x) => hash(x.url)),
      ents: headlineEntities([s.title, ...s.sources.map((x) => x.title)], s.summary),
    };
  }
  return pool;
}

// ---------- topics ----------

function topicPair(cos, a, b) {
  let shared = 0;
  for (const e of a.ents) if (b.ents.has(e)) shared++;
  return shared < TOPIC_MIN_SHARED ? 0 : pairScore(cos, a, b);
}

// Groups of pool entries about the same topic. Entries without a vector stay on their own.
export function topicsOf(entries) {
  const withVec = entries.filter((e) => e.vec);
  const items = withVec.map((e) => ({ v: fromInt8B64(e.vec), t: Date.parse(e.publishedAt), ents: new Set(e.ents), score: features(e).score }));
  const groups = averageLinkage(items, TOPIC_LINK, { windowHours: 8 * 24, pair: topicPair }).map((g) => g.map((i) => withVec[i]));
  return [...groups, ...entries.filter((e) => !e.vec).map((e) => [e])];
}

// What a topic weighs: { n: distinct outlets, days, langs, score }. `weight`: outlet name → weight.
export function coverage(members, weight = weightOf) {
  const byDay = new Map();
  for (const m of members) for (const [d, ids] of Object.entries(m.cov)) byDay.set(d, union(byDay.get(d), ids));
  const outlets = new Set([...byDay.values()].flat());
  const sum = (names) => names.reduce((acc, o) => acc + weight(o), 0);
  const weighted = sum([...outlets]);
  const repeats = [...byDay.values()].reduce((acc, ids) => acc + sum(ids), 0) - weighted;
  // Pools from before outlets were tracked only know the peak count of each story: the outlets
  // they do not list weigh as much, on average, as the ones they do.
  const n = Math.max(outlets.size, ...members.map((m) => m.best));
  const base = outlets.size ? (weighted * n) / outlets.size : n;
  const soft = members.filter(isSoft).reduce((acc, m) => acc + m.best, 0) * 2 >= members.reduce((acc, m) => acc + m.best, 0);
  return {
    n,
    days: byDay.size,
    langs: [...new Set(members.flatMap((m) => m.langs))],
    score: (base + REPEAT_WEIGHT * repeats) * (soft ? SOFT_FACTOR : 1),
    soft,
  };
}

function topicSections(members, lead) {
  const total = members.reduce((sum, m) => sum + m.best, 0);
  const weight = new Map();
  for (const m of members) for (const s of new Set(m.sections)) weight.set(s, (weight.get(s) ?? 0) + m.best);
  return union(lead.sections, [...weight].filter(([s, w]) => w >= total * MIN_SHARE || s === 'eeuu/nba').map(([s]) => s));
}

// A topic as the app shows it: its most covered story (not a service piece, if it has another),
// with the others as its timeline.
function topicStory(members) {
  const better = (a, b) => isService(a.title) - isService(b.title) || b.best - a.best || a.publishedAt.localeCompare(b.publishedAt);
  const lead = [...members].sort(better)[0];
  const { n, days, langs, score, soft } = coverage(members);
  const out = {
    id: lead.id,
    title: lead.title,
    image: lead.image,
    lang: lead.lang,
    langs,
    sections: topicSections(members, lead),
    publishedAt: members.map((m) => m.publishedAt).sort()[0],
    n,
    days,
    score: Math.round(score * 100) / 100,
    sources: lead.sources,
  };
  if (lead.aiSummary) out.aiSummary = lead.aiSummary;
  else if (lead.summary) out.summary = lead.summary;
  // Every story id of the topic: the app knows a topic was read if any of them was.
  out.ids = members.map((m) => m.id).slice(0, MAX_IDS);
  if (soft) out.soft = true;
  if (members.some((m) => m.spoiler)) out.spoiler = true;
  // Twice the same headline (two copies the daily grouping kept apart) says nothing new.
  const seen = new Set([normalize(lead.title)]);
  const related = members
    .filter((m) => m !== lead && !seen.has(normalize(m.title)) && seen.add(normalize(m.title)))
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
    .slice(0, MAX_RELATED)
    .map((m) => ({ id: m.id, title: m.title, url: m.sources[0]?.url, source: m.sources[0]?.source, publishedAt: m.publishedAt, n: m.best }));
  if (related.length) out.related = related;
  return out;
}

// The stories of a topic as items for the pair scores (the ones with a vector).
const itemsOf = (members) =>
  members.filter((m) => m.vec).map((m) => ({ v: fromInt8B64(m.vec), ents: new Set(m.ents), score: features(m).score }));

// Whether two topics of consecutive weeks are one: the same average linkage that joins stories into
// a topic, over every pair of their stories.
function sameTopic(a, b) {
  if (!a.length || !b.length) return 0;
  let sum = 0;
  for (const x of a) for (const y of b) sum += topicPair(dot(x.v, y.v), x, y);
  return sum / (a.length * b.length);
}

// The topic of the week before that this one goes on from, among the ones it showed.
function continuations(topics, prev) {
  if (!prev?.pool) return;
  const before = topicsOf(Object.values(prev.pool))
    .map((members) => ({ items: itemsOf(members), story: prev.stories?.[topicStory(members).id] }))
    .filter((t) => t.items.length && t.story);
  for (const t of topics) {
    const items = itemsOf(t.members);
    let best = null;
    let bestScore = TOPIC_LINK;
    for (const b of before) {
      const s = sameTopic(items, b.items);
      if (s >= bestScore) [best, bestScore] = [b.story, s];
    }
    if (best) t.story.prev = { week: prev.id, id: best.id, title: best.title, n: best.n };
  }
}

// The week before `week` in `weeks`, if it is kept.
export const prevOf = (weeks, week) => weeks.get(weekOf(Date.parse(week.start) - 3 * 864e5).id);

const rank = (a, b) => b.score - a.score || b.langs.length - a.langs.length || a.publishedAt.localeCompare(b.publishedAt);

// Rebuilds the published week from its pool, and drops from the pool the stories of topics no
// list could still reach. `prev`: the week before, for the topics that go on from it.
export function rebuild(week, prev = null) {
  const pool = Object.values(week.pool);
  const topics = topicsOf(pool)
    .map((members) => ({ members, story: topicStory(members) }))
    .sort((a, b) => rank(a.story, b.story));
  week.top = {};
  const keep = new Set();
  for (const key of WEEKLY_KEYS) {
    const inList = topics.filter((t) => inKey(t.story, key));
    const ids = inList.slice(0, key === 'all' ? TOP_ALL : TOP_N).map((t) => t.story.id);
    if (ids.length) week.top[key] = ids;
    inList.slice(0, POOL_N).forEach((t, i) => (i < ids.length || t.story.n > 1) && keep.add(t));
  }
  const shown = new Set(Object.values(week.top).flat());
  const published = topics.filter((t) => shown.has(t.story.id));
  continuations(published, prev);
  week.stories = Object.fromEntries(published.map((t) => [t.story.id, t.story]));
  week.pool = Object.fromEntries([...keep].flatMap((t) => t.members).map((e) => [e.id, e]));
}

function findSame(week, entry) {
  if (week.pool[entry.id]) return week.pool[entry.id];
  const urls = new Set(entry.urls);
  return Object.values(week.pool).find((e) => e.urls.some((u) => urls.has(u)));
}

// weeks: Map week id → week ({ id, start, end, updatedAt, pool, stories, top, briefings }), updated
// in place. Returns the ids of the weeks that changed.
export function foldStories(weeks, stories, now = Date.now()) {
  const changed = new Set();
  const oldest = weekOf(now - (KEEP_WEEKS - 1) * 7 * 864e5).start;
  for (const story of stories) {
    if (!story.sources?.length) continue;
    let e = entryOf(story, now);
    const w = weekOf(Date.parse(e.publishedAt) || now);
    if (w.start < oldest) continue;
    let week = weeks.get(w.id);
    if (!week) weeks.set(w.id, (week = { ...w, pool: {}, stories: {}, top: {} }));
    week.pool ??= legacyPool(week);
    const same = findSame(week, e);
    if (same) {
      delete week.pool[same.id];
      e = mergeEntries(same, e);
    }
    week.pool[e.id] = e;
    changed.add(w.id);
  }
  // Oldest first: a week links to the topics of the one before as just rebuilt.
  for (const id of [...changed].sort()) {
    const week = weeks.get(id);
    rebuild(week, prevOf(weeks, week));
    week.updatedAt = new Date(now).toISOString();
  }
  for (const id of weeks.keys()) if (weeks.get(id).start < oldest) weeks.delete(id);
  return [...changed];
}

// Vectors for the pool stories that have none (pools from before topics, editions without
// embeddings), so they can join topics: the mean of their outlets' headlines, like the story
// vectors of cluster.js. embedder: embed.js's. Returns the ids of the weeks that changed, already
// rebuilt.
export async function embedMissing(weeks, embedder) {
  if (!embedder) return [];
  const changed = [];
  // Oldest first; a week is rebuilt too when the one before changed (its links to it may change).
  for (const week of [...weeks.values()].sort((a, b) => a.start.localeCompare(b.start))) {
    week.pool ??= legacyPool(week);
    // Vectors of another model cannot be compared with this one's.
    if (week.model && week.model !== embedder.id) for (const e of Object.values(week.pool)) delete e.vec;
    week.model = embedder.id;
    const todo = Object.values(week.pool).filter((e) => !e.vec);
    if (!todo.length) {
      const prev = prevOf(weeks, week);
      if (prev && changed.includes(prev.id)) {
        rebuild(week, prev);
        changed.push(week.id);
      }
      continue;
    }
    const titles = todo.map((e) => e.sources.map((s) => s.title).filter(Boolean));
    const vecs = await embedder.embed(titles.flat());
    let k = 0;
    todo.forEach((e, i) => {
      const own = vecs.slice(k, (k += titles[i].length));
      if (!own.length) return;
      const mean = new Float32Array(own[0].length);
      for (const v of own) for (let d = 0; d < v.length; d++) mean[d] += v[d];
      e.vec = toInt8B64(normalizeVec(mean));
    });
    rebuild(week, prevOf(weeks, week));
    changed.push(week.id);
  }
  return changed;
}

// index.json: newest week first, with how many stories each one keeps.
export function weeklyIndex(weeks, now = Date.now()) {
  return {
    generatedAt: new Date(now).toISOString(),
    current: weekOf(now).id,
    weeks: [...weeks.values()]
      .sort((a, b) => b.start.localeCompare(a.start))
      .map(({ id, start, end, updatedAt, stories }) => ({ id, start, end, updatedAt, stories: Object.keys(stories).length })),
  };
}

// ---------- weekly AI summaries ----------
//
// "La semana en …" for Para ti, every section and the NBA (without results). A week still open gets
// a provisional summary once a day; when it closes (Tuesday: stories started on Sunday can still
// gain outlets on Monday) it gets the final one, which never changes again.

export const AI_KEYS = [
  { key: 'all', label: 'Portada', nba: false },
  ...SECTIONS.map((s) => ({ key: s.id, label: s.label, nba: false })),
  { key: 'eeuu/nba', label: 'NBA', nba: true },
];
const PROVISIONAL_EVERY = 20 * 3.6e6;
const MAX_WEEKS_PER_RUN = 1; // 9 calls at most: a run with AI already takes ~4 of its 8 minutes
const AI_STORIES = 12;

export const isClosed = (week, now) => now >= Date.parse(week.end) + 2 * 864e5;

// [{ weekId, key, label, nba, final, week: {start, end}, stories }], newest week first. Spoilers never
// reach the model and NBA stories only go to the NBA call, as in the daily summaries (jobs.js).
export function weeklyAIJobs(weeks, now = Date.now()) {
  const jobs = [];
  let n = 0;
  for (const week of [...weeks.values()].sort((a, b) => b.start.localeCompare(a.start))) {
    const final = isClosed(week, now);
    const due = AI_KEYS.filter(({ key }) => {
      const b = week.briefings?.[key];
      return final ? !b?.final : !b || now - Date.parse(b.at) > PROVISIONAL_EVERY;
    });
    const weekJobs = due
      .map(({ key, label, nba }) => {
        const stories = (week.top[key] ?? [])
          .map((id) => week.stories[id])
          .filter((s) => s && !s.spoiler && (nba || !isNbaStory(s)))
          .slice(0, AI_STORIES);
        return { weekId: week.id, key, label, nba, final, week: { start: week.start, end: week.end }, stories };
      })
      .filter((j) => j.stories.length >= 2);
    if (!weekJobs.length) continue;
    jobs.push(...weekJobs);
    if (++n === MAX_WEEKS_PER_RUN) break;
  }
  return jobs;
}

// Stores a job's answer: the week's summary for that key, and a summary for its stories that had none.
export function applyWeeklyAI(weeks, job, ai, now = Date.now()) {
  const week = weeks.get(job.weekId);
  if (!week || !ai?.briefing) return false;
  week.briefings ??= {};
  week.briefings[job.key] = { text: ai.briefing, at: new Date(now).toISOString(), model: ai.model, ...(job.final && { final: true }) };
  for (const [id, text] of Object.entries(ai.summaries ?? {})) {
    // In the pool too: the published week is rebuilt from it on every run.
    for (const story of [week.stories[id], week.pool?.[id]]) {
      if (story && !story.aiSummary) {
        story.aiSummary = text;
        delete story.summary;
      }
    }
  }
  return true;
}

const WEEK_FILE = /^\d{4}-W\d{2}\.json$/;
const ANY_WEEK_FILE = /^(\d{4}-W\d{2})(?:\.pool)?\.json$/;

// The archive in `dir` as a Map week id → week (empty if there is none yet; a broken file is skipped
// and its week rebuilt from what comes next; without its pool file, the pool starts again from the
// published week).
export async function readWeeks(dir) {
  const weeks = new Map();
  const files = await readdir(dir).catch(() => []);
  for (const f of files.filter((f) => WEEK_FILE.test(f))) {
    try {
      const week = JSON.parse(await readFile(resolve(dir, f), 'utf8'));
      try {
        const { model, stories } = JSON.parse(await readFile(resolve(dir, `${week.id}.pool.json`), 'utf8'));
        Object.assign(week, { pool: stories, model });
      } catch {}
      weeks.set(week.id, week);
    } catch {}
  }
  return weeks;
}

// Writes the weeks in `changed` and index.json, and deletes the files of weeks no longer kept.
export async function writeWeeks(dir, weeks, changed, now = Date.now()) {
  await mkdir(dir, { recursive: true });
  for (const id of changed) {
    if (!weeks.has(id)) continue;
    const { pool, model, ...week } = weeks.get(id);
    await writeFile(resolve(dir, `${id}.json`), JSON.stringify(week));
    if (pool) await writeFile(resolve(dir, `${id}.pool.json`), JSON.stringify({ model, stories: pool }));
  }
  for (const f of await readdir(dir)) if (ANY_WEEK_FILE.test(f) && !weeks.has(ANY_WEEK_FILE.exec(f)[1])) await rm(resolve(dir, f), { force: true });
  const index = weeklyIndex(weeks, now);
  await writeFile(resolve(dir, 'index.json'), JSON.stringify(index));
  return `${index.weeks.length} semanas (${index.weeks.map((w) => `${w.id} ${w.stories}`).join(', ')})`;
}
