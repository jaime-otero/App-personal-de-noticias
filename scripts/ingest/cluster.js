import { normalize, tokens } from './text.js';
import { dot, normalizeVec } from './embed.js';

// Groups articles about the same story across outlets. Two algorithms:
//  - With embeddings (the default in the ingest): multilingual vectors + shared names and numbers,
//    so "Medvedev descalificado en Pekín" and "Medvedev disqualified from China Open" go together.
//  - Without them (no model, or it failed to load): title word overlap, same language only.

// ---------- embeddings ----------
//
// Pair score = cosine + ENTITY_BONUS per shared proper noun or number (up to MAX_ENTITIES), minus
// SCORELINE_PENALTY when both carry different results ("2-1" vs "3-0": embeddings see a football
// match report as the same topic, not as the same match). Embeddings group topics; the names are what
// tell two events apart (Miranda et al. 2018, Saravanakumar et al. 2021).
// Calibrated on hand-labelled pairs of real headlines (scripts/eval/): see `link` in embed.js MODELS.
export const ENTITY_BONUS = 0.1;
export const MAX_ENTITIES = 3;
export const SCORELINE_PENALTY = 0.15;
export const WINDOW_HOURS = 36;
const MAX_COMPONENT = 300;

// Capitalised words that do not start the text, and numbers of 2+ digits that are not years, accent-
// free. English Title Case adds some noise ("Officials"), which stopwords and the cap keep small.
const CAPITALISED = /(?<=[\s“"'‘(«¿¡—–-])(\p{Lu}[\p{L}’'-]{2,})/gu;
export function entities(article) {
  const text = `${article.title}. ${article.summary ?? ''}`;
  const out = new Set();
  for (const [, w] of text.matchAll(CAPITALISED)) for (const t of tokens(w)) out.add(t);
  for (const [n] of text.matchAll(/(?<![\d.,])\d{2,}(?![\d.,]?\d)/g)) if (!/^(19|20)\d\d$/.test(n)) out.add(n);
  return out;
}

const scoreline = (article) => normalize(`${article.title} ${article.summary ?? ''}`).match(/(?<![\d/])(\d{1,3})\s?[-–]\s?(\d{1,3})(?![\d/])/)?.slice(1).join('-') ?? null;

// What pairScore needs from an article besides its vector.
export const features = (article) => ({ ents: entities(article), score: scoreline(article) });

export function pairScore(cos, a, b) {
  let shared = 0;
  for (const e of a.ents) if (b.ents.has(e)) shared++;
  const conflict = a.score && b.score && a.score !== b.score;
  return cos + ENTITY_BONUS * Math.min(shared, MAX_ENTITIES) - (conflict ? SCORELINE_PENALTY : 0);
}

// Average-linkage agglomerative clustering with a threshold, run inside each connected component of
// the graph of pairs that could link (blocking). Average linkage, unlike joining a story through its
// closest article, does not chain unrelated stories through a shared topic ("everything Trump").
function groupByEmbeddings(articles, vectors, link) {
  const items = articles.map((a) => ({ a, v: vectors.get(a.id), t: a.publishedAt ? Date.parse(a.publishedAt) : null, ...features(a) }));
  return averageLinkage(items, link).map((g) => g.map((i) => items[i].a));
}

// items: [{ v: normalised vector, t: ms or null, ents: Set, score: scoreline or null }]. Pairs more
// than `windowHours` apart never link; `pair(cos, a, b)` scores the rest. Returns groups of item
// indices. Also groups the stories of a week into topics (weekly.js), with its own window and score.
export function averageLinkage(items, link, { windowHours = WINDOW_HOURS, pair: pairFn = pairScore } = {}) {
  const n = items.length;
  const hoursApart = (a, b) => (a.t == null || b.t == null ? 0 : Math.abs(a.t - b.t) / 3.6e6);
  const score = (i, j) => (hoursApart(items[i], items[j]) > windowHours ? 0 : pairFn(dot(items[i].v, items[j].v), items[i], items[j]));
  // A pair can only reach the threshold with a cosine above link - max bonus.
  const minCos = link - ENTITY_BONUS * MAX_ENTITIES;
  const adj = Array.from({ length: n }, () => []);
  const known = new Map();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (hoursApart(items[i], items[j]) > windowHours) continue;
      const cos = dot(items[i].v, items[j].v);
      if (cos < minCos) continue;
      const s = pairFn(cos, items[i], items[j]);
      if (s < link) continue;
      known.set(i * n + j, s);
      adj[i].push([j, s]);
      adj[j].push([i, s]);
    }
  }
  const pair = (i, j) => known.get(i < j ? i * n + j : j * n + i) ?? score(i, j);

  // Connected components of the pairs scoring ≥ min. On a busy day one can hold hundreds of
  // loosely chained articles: it is split again with a stricter threshold until every piece is small
  // enough for the clustering below (cubic in its size).
  const componentsOf = (members, min) => {
    const inside = new Set(members);
    const seen = new Set();
    const out = [];
    for (const start of members) {
      if (seen.has(start)) continue;
      const comp = [start];
      seen.add(start);
      for (let k = 0; k < comp.length; k++) {
        for (const [j, s] of adj[comp[k]]) {
          if (s >= min && inside.has(j) && !seen.has(j)) {
            seen.add(j);
            comp.push(j);
          }
        }
      }
      out.push(comp.sort((a, b) => a - b));
    }
    return out;
  };
  const split = (members, min) => componentsOf(members, min).flatMap((c) => (c.length > MAX_COMPONENT ? split(c, min + 0.02) : [c]));

  const groups = [];
  for (const members of split(Array.from({ length: n }, (_, i) => i), link)) {
    if (members.length === 1) {
      groups.push(members);
      continue;
    }
    // sum[x][y] = sum of pair scores between clusters x and y; average = sum / (|x|·|y|).
    let clusters = members.map((i) => [i]);
    const sum = clusters.map((x) => clusters.map((y) => (x === y ? 0 : pair(x[0], y[0]))));
    for (;;) {
      let best = -Infinity;
      let bx = -1;
      let by = -1;
      for (let x = 0; x < clusters.length; x++) {
        for (let y = x + 1; y < clusters.length; y++) {
          const avg = sum[x][y] / (clusters[x].length * clusters[y].length);
          if (avg > best) [best, bx, by] = [avg, x, y];
        }
      }
      if (best < link) break;
      clusters[bx] = [...clusters[bx], ...clusters[by]];
      for (let z = 0; z < clusters.length; z++) {
        sum[bx][z] += sum[by][z];
        sum[z][bx] = sum[bx][z];
      }
      sum[bx][bx] = 0;
      clusters.splice(by, 1);
      sum.splice(by, 1);
      for (const row of sum) row.splice(by, 1);
    }
    groups.push(...clusters);
  }
  return groups;
}

// ---------- words (fallback) ----------

const SIMILARITY = 0.4;

// Mix of Jaccard and overlap coefficient: headlines of the same story vary a lot in length
// ("Merz visits Kyiv" vs "German chancellor visits Ukraine in show of support").
function similarity(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  if (inter < 2) return 0;
  const jaccard = inter / (a.size + b.size - inter);
  const overlap = inter / Math.min(a.size, b.size);
  return Math.max(jaccard, inter >= 3 ? overlap * 0.7 : 0);
}

// Same language only (title overlap does not work across languages). Greedy single pass, newest first.
function groupByWords(articles) {
  const clusters = [];
  for (const art of articles) {
    const tk = new Set(tokens(`${art.title}`));
    let best = null;
    let bestScore = SIMILARITY;
    for (const c of clusters) {
      if (c.lang !== art.lang || tk.size < 3) continue;
      const s = Math.max(...c.articleTokens.map((t) => similarity(tk, t)));
      if (s >= bestScore) {
        best = c;
        bestScore = s;
      }
    }
    const sameOutlet = best?.articles.find((a) => a.source === art.source);
    if (sameOutlet) sameOutlet.sections = [...new Set([...sameOutlet.sections, ...art.sections])];
    else if (best) {
      best.articles.push(art);
      best.articleTokens.push(tk);
    } else clusters.push({ lang: art.lang, articleTokens: [tk], articles: [art] });
  }
  return clusters.map((c) => c.articles);
}

// ---------- stories ----------

// Same outlet twice in a story (another section feed, or a live page next to the article): a
// duplicate, but keep every section it was filed under.
function dedupeOutlets(group) {
  const kept = [];
  for (const art of group) {
    const same = kept.find((a) => a.source === art.source);
    if (same) same.sections = [...new Set([...same.sections, ...art.sections])];
    else kept.push({ ...art });
  }
  return kept;
}

// A section belongs to the story when at least a quarter of its outlets filed it there, so in a big
// story one odd feed (Puigdemont told by Mundo Deportivo) does not drag it into Deportes; small
// stories keep every section. NBA is always kept: the spoiler cover and the AI's no-spoiler rules
// hang off it.
const MIN_SHARE = 0.25;
const ALWAYS = new Set(['eeuu/nba']);
function storySections(group) {
  const count = new Map();
  for (const a of group) for (const s of new Set(a.sections)) count.set(s, (count.get(s) ?? 0) + 1);
  const min = Math.max(1, Math.ceil(group.length * MIN_SHARE));
  const kept = [...count].filter(([s, c]) => c >= min || ALWAYS.has(s)).map(([s]) => s);
  return kept.length ? kept : [...count.keys()];
}

function toStory(group, vectors) {
  // The interface is in Spanish: a mixed-language story is led by a Spanish outlet when possible.
  const lead = group.find((a) => a.image && a.lang === 'es') ?? group.find((a) => a.image) ?? group.find((a) => a.lang === 'es') ?? group[0];
  const story = {
    // The oldest article: stable across editions, AI summaries, likes and corrections hang off it.
    id: group[group.length - 1].id,
    title: lead.title,
    summary: lead.summary,
    image: lead.image,
    lang: lead.lang,
    langs: [...new Set(group.map((a) => a.lang))],
    sections: storySections(group),
    publishedAt: group.map((a) => a.publishedAt).filter(Boolean).sort().at(-1) ?? null,
    // The lead first: the card shows its outlet and links its headline to it.
    sources: [lead, ...group.filter((a) => a !== lead)].map(({ title, url, source, sourceId, publishedAt }) => ({ title, url, source, sourceId, publishedAt })),
  };
  if (vectors) {
    // Story vector (for vectors.json): normalised mean of its articles.
    const vs = group.map((a) => vectors.get(a.id)).filter(Boolean);
    const mean = new Float32Array(vs[0].length);
    for (const v of vs) for (let i = 0; i < v.length; i++) mean[i] += v[i];
    Object.defineProperty(story, 'vec', { value: normalizeVec(mean), enumerable: false });
  }
  return story;
}

// `vectors`: Map article id → normalised Float32Array (every article must have one), `link`: the
// model's threshold. Without vectors, the word-overlap algorithm.
export function clusterArticles(articles, { vectors = null, link = 0.67 } = {}) {
  const sorted = [...articles].sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  const groups = vectors ? groupByEmbeddings(sorted, vectors, link) : groupByWords(sorted);
  // Keep each group newest first, like the input.
  const order = new Map(sorted.map((a, i) => [a.id, i]));
  return groups.map((g) => {
    const story = toStory(dedupeOutlets(g.sort((a, b) => order.get(a.id) - order.get(b.id))), vectors);
    // Every article grouped here, same-outlet duplicates included (not written to news.json).
    Object.defineProperty(story, 'articleIds', { value: g.map((a) => a.id), enumerable: false });
    return story;
  });
}
