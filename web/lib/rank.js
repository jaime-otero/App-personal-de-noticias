import { normalize, tokens } from './tokens.js';
import { SECTION_BY_ID, sectionLabel } from './taxonomy.js';

// Personal ranking.
//
// Score = explicit preference (section weights from Ajustes)
//       + learned interest (online logistic regression over story features)
//       + editorial signals (how many outlets cover it, freshness)
// then a diversity pass and a little exploration so the feed does not become a bubble.

const HOUR = 3.6e6;
const MAX_FEATURES = 2000;
const LEARNING_RATE = 0.35;
const L2 = 0.002;
const DAILY_DECAY = 0.97;

// ---------- features ----------

// Starts at a word boundary that also works before accented capitals (\b is ASCII-only): Óscar, Ángel.
const ENTITY_RE = /(?<![\p{L}\p{N}])(?:\p{Lu}[\p{L}'’.-]+|[A-Z]{2,}\d*)(?:\s+(?:de\s+(?:la\s+|los\s+)?)?(?:\p{Lu}[\p{L}'’.-]+|[A-Z]{2,}\d*))*/gu;
const ENTITY_STOP = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'the', 'a', 'an', 'en', 'in', 'por', 'how', 'why', 'what', 'who', 'this', 'es', 'se']);

// Proper names in the title ("Golden State", "CERN", "Pedro Sánchez"), skipping the
// capitalised first word of the sentence when it is a lone common word.
export function entities(title) {
  const out = new Set();
  for (const m of title.matchAll(ENTITY_RE)) {
    const words = m[0].split(/\s+/);
    if (m.index === 0 && words.length === 1 && !/^[A-Z]{2,}/.test(words[0])) continue;
    const e = normalize(m[0]).replace(/[’'.]+$/, '').replace(/^(el|la|los|las|the) /, '');
    if (e.length > 2 && !ENTITY_STOP.has(e)) out.add(e);
  }
  return [...out];
}

// Feature name → value. Values are scaled so long titles do not outweigh short ones.
export function featuresOf(story) {
  const f = {};
  for (const s of story.sections ?? []) {
    f[`s:${s}`] = 1;
    if (s.includes('/')) f[`s:${s.split('/')[0]}`] = 0.6;
  }
  for (const src of new Set((story.sources ?? []).map((s) => s.sourceId))) f[`src:${src}`] = 0.5;
  const words = tokens(story.title ?? '');
  const scale = 1 / Math.sqrt(words.length || 1);
  for (const w of new Set(words)) f[`w:${w}`] = scale;
  for (let i = 0; i < words.length - 1; i++) f[`b:${words[i]} ${words[i + 1]}`] = scale;
  for (const e of entities(story.title ?? '')) f[`e:${e}`] = 0.8;
  return f;
}

// Signals and the label/weight they teach the model with.
// 'skip' = shown near the top several times and never opened: only blames section and outlet.
export const SIGNALS = {
  like: { y: 1, weight: 2 },
  save: { y: 1, weight: 1.5 },
  open: { y: 1, weight: 0.6 },
  unlike: { y: 0, weight: 1 },
  dislike: { y: 0, weight: 2 },
  hide: { y: 0, weight: 1 },
  skip: { y: 0, weight: 0.25, only: /^(s|src):/ },
};

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

export function emptyModel(now = Date.now()) {
  return { w: {}, b: 0, n: 0, updatedAt: now };
}

export function logit(model, feats) {
  let z = model.b;
  for (const [k, v] of Object.entries(feats)) z += (model.w[k] ?? 0) * v;
  return z;
}

// One step of stochastic gradient descent on the logistic loss.
export function train(model, story, signal, now = Date.now()) {
  const sig = SIGNALS[signal];
  if (!sig) return model;
  decay(model, now);
  let feats = featuresOf(story);
  if (sig.only) feats = Object.fromEntries(Object.entries(feats).filter(([k]) => sig.only.test(k)));
  const p = sigmoid(logit(model, feats));
  const g = LEARNING_RATE * sig.weight * (sig.y - p);
  for (const [k, v] of Object.entries(feats)) {
    const w = model.w[k] ?? 0;
    model.w[k] = clamp(w * (1 - L2) + g * v, -6, 6);
  }
  model.b = clamp(model.b + g * 0.05, -2, 2);
  model.n++;
  model.t = now;
  prune(model);
  return model;
}

function decay(model, now) {
  const days = (now - (model.updatedAt ?? now)) / 864e5;
  if (days >= 1) {
    const f = Math.pow(DAILY_DECAY, days);
    for (const k of Object.keys(model.w)) {
      model.w[k] *= f;
      if (Math.abs(model.w[k]) < 0.02) delete model.w[k];
    }
    model.updatedAt = now;
  }
}

function prune(model) {
  const keys = Object.keys(model.w);
  if (keys.length <= MAX_FEATURES) return;
  keys.sort((a, b) => Math.abs(model.w[b]) - Math.abs(model.w[a]));
  for (const k of keys.slice(MAX_FEATURES)) delete model.w[k];
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- explicit preferences ----------

// Weight of a section key: its own setting, else its parent's, else 1 (normal).
export function sectionPref(profile, key) {
  const v = profile.sections[key] ?? profile.sections[key.split('/')[0]];
  return v ?? 1;
}

const containsKeyword = (text, kw) => kw && normalize(text).includes(normalize(kw));

// ---------- scoring ----------

// Returns { score, interest, learned, reasons } or null when the story must not be shown.
// `interest`: the part of the score that is about the person (sections, what was learned, keywords,
// outlets), without the editorial signals (coverage, freshness).
export function scoreStory(story, profile, now = Date.now()) {
  if (profile.hidden[story.id] || profile.disliked[story.id]) return null;
  // A story told in both languages shows if any of its outlets writes in one the person reads.
  if (!(story.langs ?? [story.lang]).some((l) => profile.langs.includes(l))) return null;
  const sourceWeights = story.sources.map((s) => profile.sources[s.sourceId] ?? 0);
  if (sourceWeights.every((w) => w < 0)) return null;
  const text = `${story.title} ${story.summary ?? ''}`;
  if (profile.muteKeywords.some((k) => containsKeyword(text, k))) return null;

  const prefs = (story.sections ?? []).map((s) => sectionPref(profile, s));
  if (prefs.length && prefs.every((p) => p <= -2)) return null;
  const pref = prefs.length ? Math.max(...prefs) : 0.5;

  const feats = featuresOf(story);
  const learned = clamp(logit(profile.model, feats), -5, 5);
  const boost = profile.boostKeywords.filter((k) => containsKeyword(text, k)).length * 3;
  const sourceScore = Math.max(...sourceWeights) * 1.5;
  const coverage = Math.log2(story.sources.length) * 1.2;
  const ageH = story.publishedAt ? Math.max(0, (now - Date.parse(story.publishedAt)) / HOUR) : 36;
  const recency = -ageH / 8;
  const readPenalty = profile.read[story.id] ? -4 : 0;

  const interest = pref * 1.5 + learned + boost + sourceScore;
  const score = interest + coverage + recency + readPenalty + (story.aiSummary ? 0.3 : 0);
  return { score, interest, learned, reasons: reasons(profile, feats) };
}

// The two learned features that pull this story up the most, in words.
function reasons(profile, feats) {
  const top = Object.entries(feats)
    .map(([k, v]) => [k, (profile.model.w[k] ?? 0) * v])
    .filter(([, c]) => c > 0.25)
    .sort((a, b) => b[1] - a[1]);
  const out = [];
  for (const [k] of top) {
    const label = featureLabel(k);
    if (label && !out.includes(label)) out.push(label);
    if (out.length === 2) break;
  }
  return out;
}

export function featureLabel(key, sourceNames = {}) {
  const [kind, ...rest] = key.split(':');
  const v = rest.join(':');
  if (kind === 's') return SECTION_BY_ID[v.split('/')[0]] ? sectionLabel(v) : null;
  if (kind === 'src') return sourceNames[v] ?? v;
  if (kind === 'e' || kind === 'b' || kind === 'w') return v;
  return null;
}

// Sort by score, keep topics varied and slot in an exploration pick every EXPLORE_EVERY
// positions (a well-covered story the model does not expect you to like).
const EXPLORE_EVERY = 10;

export function rankStories(stories, profile, now = Date.now(), { explore = false } = {}) {
  const scored = [];
  for (const story of stories) {
    const r = scoreStory(story, profile, now);
    if (r) scored.push({ story, ...r });
  }
  scored.sort((a, b) => b.score - a.score);

  const pool = scored.slice(0, 400);
  const result = [];
  const seenSections = {};
  const explorePool = explore
    ? pool.filter((s) => s.story.sources.length >= 2 && s.learned <= 0 && !profile.read[s.story.id]).sort((a, b) => b.story.sources.length - a.story.sources.length)
    : [];
  while (pool.length) {
    if (explore && result.length % EXPLORE_EVERY === EXPLORE_EVERY - 1) {
      const pick = explorePool.find((s) => pool.includes(s));
      if (pick) {
        pool.splice(pool.indexOf(pick), 1);
        result.push({ ...pick, explore: true });
        continue;
      }
    }
    result.push(pickVaried(pool, seenSections));
  }
  return result.concat(scored.slice(400));
}

// Takes from `pool` (sorted by score) the best of its first 15 once each section already shown
// costs 0.9 per story, so one section does not fill the feed.
function pickVaried(pool, seenSections) {
  let bestI = 0;
  let bestVal = -Infinity;
  for (let i = 0; i < Math.min(pool.length, 15); i++) {
    const main = pool[i].story.sections[0];
    const val = pool[i].score - 0.9 * (seenSections[main] ?? 0);
    if (val > bestVal) {
      bestVal = val;
      bestI = i;
    }
  }
  const [picked] = pool.splice(bestI, 1);
  const main = picked.story.sections[0];
  seenSections[main] = (seenSections[main] ?? 0) + 1;
  return picked;
}

// "Para mí" in Semana: the topics of a week in the person's order. Interest as in the feed, plus
// WEEK_IMPORTANCE per doubling of the topic's importance (its weekly score): twice the coverage is
// worth a little more than one level of a section, so a topic the person loves gets in with a third
// of the coverage of the general ones, and one eight times bigger stays above it. Freshness does
// not count: the whole week is the window.
export const WEEK_IMPORTANCE = 2;

export function rankWeek(stories, profile) {
  const pool = [];
  for (const story of stories) {
    const r = scoreStory(story, profile);
    if (!r) continue;
    const importance = Math.max(story.score ?? story.n ?? story.sources.length, 1);
    pool.push({ story, score: r.interest + WEEK_IMPORTANCE * Math.log2(importance), reasons: r.reasons });
  }
  pool.sort((a, b) => b.score - a.score);
  const result = [];
  const seenSections = {};
  while (pool.length) result.push(pickVaried(pool, seenSections));
  return result;
}

// What the model has learned, for the Ajustes page.
export function topFeatures(model, n = 12) {
  const entries = Object.entries(model.w).filter(([k]) => featureLabel(k));
  const pos = entries.filter(([, w]) => w > 0.3).sort((a, b) => b[1] - a[1]).slice(0, n);
  const neg = entries.filter(([, w]) => w < -0.3).sort((a, b) => a[1] - b[1]).slice(0, n);
  return { pos, neg };
}

// Alternative orders for a ranked list (filters already applied): newest first, or the
// stories covered by the most outlets first. 'foryou' keeps the personalised order.
export const SORTS = [
  ['foryou', 'Para ti'],
  ['recent', 'Más recientes'],
  ['coverage', 'Más medios'],
];

export function sortEntries(entries, mode) {
  if (mode !== 'recent' && mode !== 'coverage') return entries;
  const time = (e) => Date.parse(e.story.publishedAt) || 0;
  const byTime = (a, b) => time(b) - time(a);
  const cmp = mode === 'recent' ? byTime : (a, b) => b.story.sources.length - a.story.sources.length || byTime(a, b);
  return entries.map(({ explore, ...e }) => e).sort(cmp);
}
