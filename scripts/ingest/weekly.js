// Weekly archive ("Semanal"): the most important stories of each week, for the whole paper and
// for every section and subsection. Each edition only holds the last 48 h, so every run folds its
// stories into the archive of the week they started in (Monday to Sunday, Spain time).
//
// Importance = the most outlets that covered the story in any edition (its peak), then the
// languages it was told in. Peaks only grow and a story is re-added while it is in the edition,
// so keeping just the top TOP_N of every list on each run loses nothing that could still make it.
//
// Files (web/data/weekly/): index.json lists the weeks; one <week>.json per week.

import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SECTIONS } from '../../web/lib/taxonomy.js';
import { isNbaStory } from '../../web/lib/spoilers.js';

export const TOP_N = 10;
export const TOP_ALL = 20;
export const KEEP_WEEKS = 12;
const MAX_SOURCES = 6;
const MAX_EXTRACT = 280;
const TZ = 'Europe/Madrid';

export const WEEKLY_KEYS = ['all', ...SECTIONS.flatMap((s) => [s.id, ...s.subs.map((x) => x.key)])];

const ymd = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return [Number(p.year), Number(p.month), Number(p.day)];
};
const iso = (d) => d.toISOString().slice(0, 10);

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

// What the archive keeps of a story (news.json carries more).
function compact(story, now) {
  const out = {
    id: story.id,
    title: story.title,
    image: story.image,
    lang: story.lang,
    langs: story.langs,
    sections: story.sections,
    publishedAt: firstSeen(story) ?? new Date(now).toISOString(),
    n: story.sources.length,
    sources: story.sources.slice(0, MAX_SOURCES).map(({ title, url, source, sourceId }) => ({ title, url, source, sourceId })),
  };
  if (story.aiSummary) out.aiSummary = story.aiSummary;
  else if (story.summary) out.summary = story.summary.length > MAX_EXTRACT ? `${story.summary.slice(0, MAX_EXTRACT - 1)}…` : story.summary;
  if (story.spoiler) out.spoiler = true;
  return out;
}

const rank = (a, b) => b.n - a.n || b.langs.length - a.langs.length || a.publishedAt.localeCompare(b.publishedAt);

// The same story under another id (an older article joined it): any shared link.
function findSame(week, story) {
  if (week.stories[story.id]) return week.stories[story.id];
  const urls = new Set(story.sources.map((s) => s.url));
  return Object.values(week.stories).find((s) => s.sources.some((x) => urls.has(x.url)));
}

// Recompute every list and drop the stories no list keeps.
function prune(week) {
  const all = Object.values(week.stories).sort(rank);
  week.top = {};
  for (const key of WEEKLY_KEYS) {
    const ids = all.filter((s) => inKey(s, key)).slice(0, key === 'all' ? TOP_ALL : TOP_N).map((s) => s.id);
    if (ids.length) week.top[key] = ids;
  }
  const kept = new Set(Object.values(week.top).flat());
  week.stories = Object.fromEntries(all.filter((s) => kept.has(s.id)).map((s) => [s.id, s]));
}

// weeks: Map week id → week ({ id, start, end, updatedAt, stories, top }), updated in place.
// Returns the ids of the weeks that changed.
export function foldStories(weeks, stories, now = Date.now()) {
  const changed = new Set();
  const oldest = weekOf(now - (KEEP_WEEKS - 1) * 7 * 864e5).start;
  for (const story of stories) {
    if (!story.sources?.length) continue;
    const c = compact(story, now);
    const w = weekOf(Date.parse(c.publishedAt) || now);
    if (w.start < oldest) continue;
    let week = weeks.get(w.id);
    if (!week) weeks.set(w.id, (week = { ...w, stories: {}, top: {} }));
    const same = findSame(week, c);
    if (same) {
      delete week.stories[same.id];
      // Keep the peak coverage and the AI summary of whichever copy had them.
      if (same.n > c.n) Object.assign(c, { n: same.n, sources: same.sources });
      if (!c.aiSummary && same.aiSummary) {
        c.aiSummary = same.aiSummary;
        delete c.summary;
      }
      if (same.publishedAt < c.publishedAt) c.publishedAt = same.publishedAt;
      if (same.spoiler) c.spoiler = true; // once a spoiler, always covered
    }
    week.stories[c.id] = c;
    changed.add(w.id);
  }
  for (const id of changed) {
    const week = weeks.get(id);
    prune(week);
    week.updatedAt = new Date(now).toISOString();
  }
  for (const id of weeks.keys()) if (weeks.get(id).start < oldest) weeks.delete(id);
  return [...changed];
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
    const story = week.stories[id];
    if (story && !story.aiSummary) {
      story.aiSummary = text;
      delete story.summary;
    }
  }
  return true;
}

const WEEK_FILE = /^\d{4}-W\d{2}\.json$/;

// The archive in `dir` as a Map week id → week (empty if there is none yet; a broken file is skipped
// and its week rebuilt from what comes next).
export async function readWeeks(dir) {
  const weeks = new Map();
  for (const f of (await readdir(dir).catch(() => [])).filter((f) => WEEK_FILE.test(f))) {
    try {
      const week = JSON.parse(await readFile(resolve(dir, f), 'utf8'));
      weeks.set(week.id, week);
    } catch {}
  }
  return weeks;
}

// Writes the weeks in `changed` and index.json, and deletes the files of weeks no longer kept.
export async function writeWeeks(dir, weeks, changed, now = Date.now()) {
  await mkdir(dir, { recursive: true });
  for (const id of changed) if (weeks.has(id)) await writeFile(resolve(dir, `${id}.json`), JSON.stringify(weeks.get(id)));
  for (const f of await readdir(dir)) if (WEEK_FILE.test(f) && !weeks.has(f.slice(0, -5))) await rm(resolve(dir, f), { force: true });
  const index = weeklyIndex(weeks, now);
  await writeFile(resolve(dir, 'index.json'), JSON.stringify(index));
  return `${index.weeks.length} semanas (${index.weeks.map((w) => `${w.id} ${w.stories}`).join(', ')})`;
}
