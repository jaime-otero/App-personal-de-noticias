import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekOf, foldStories, weeklyIndex, TOP_N, KEEP_WEEKS } from '../scripts/ingest/weekly.js';

const NOW = Date.parse('2026-10-11T18:00:00Z'); // Sunday

function story(id, n, sections, at = '2026-10-09T10:00:00Z', extra = {}) {
  return {
    id,
    title: `Noticia ${id}`,
    summary: 'Extracto',
    lang: 'es',
    langs: ['es'],
    sections,
    publishedAt: at,
    sources: Array.from({ length: n }, (_, i) => ({ title: `T${i}`, url: `https://m${i}.es/${id}`, source: `Medio ${i}`, sourceId: `m${i}`, publishedAt: at })),
    ...extra,
  };
}

test('weekOf: ISO weeks, Monday to Sunday in Spain time', () => {
  assert.deepEqual(weekOf(NOW), { id: '2026-W41', start: '2026-10-05', end: '2026-10-11' });
  // 21:30 UTC on Sunday is 23:30 in Madrid (CEST): still that week.
  assert.equal(weekOf(Date.parse('2026-10-11T21:30:00Z')).id, '2026-W41');
  // 22:30 UTC on Sunday is 00:30 on Monday in Madrid: next week.
  assert.equal(weekOf(Date.parse('2026-10-11T22:30:00Z')).id, '2026-W42');
  // Year boundaries: 1 Jan 2027 is a Friday → week 53 of 2026; 4 Jan 2027 starts week 1.
  assert.equal(weekOf(Date.parse('2027-01-01T12:00:00Z')).id, '2026-W53');
  assert.equal(weekOf(Date.parse('2027-01-04T12:00:00Z')).id, '2027-W01');
  assert.equal(weekOf(Date.parse('2025-12-29T12:00:00Z')).id, '2026-W01');
});

test('foldStories keeps the most covered stories per section and subsection', () => {
  const weeks = new Map();
  const stories = [
    story('a', 9, ['espana/politica']),
    story('b', 2, ['espana/politica']),
    story('c', 5, ['ciencia/espacio']),
    ...Array.from({ length: TOP_N + 3 }, (_, i) => story(`d${i}`, 1, ['deportes/futbol'])),
  ];
  assert.deepEqual(foldStories(weeks, stories, NOW), ['2026-W41']);
  const w = weeks.get('2026-W41');
  assert.deepEqual(w.top.all.slice(0, 3), ['a', 'c', 'b']);
  assert.deepEqual(w.top.espana, ['a', 'b']);
  assert.deepEqual(w.top['espana/politica'], ['a', 'b']);
  assert.deepEqual(w.top['ciencia/espacio'], ['c']);
  assert.equal(w.top['deportes/futbol'].length, TOP_N);
  assert.equal(w.top['eeuu'], undefined);
  // Stories no list keeps are dropped; the rest are compact.
  const kept = new Set(Object.values(w.top).flat());
  assert.deepEqual(new Set(Object.keys(w.stories)), kept);
  assert.equal(w.stories.a.n, 9);
  assert.ok(w.stories.a.sources.length <= 6);
});

test('foldStories keeps the peak coverage and the AI summary across editions', () => {
  const weeks = new Map();
  foldStories(weeks, [story('a', 8, ['economia'], undefined, { aiSummary: 'Resumen' })], NOW);
  // Next edition: fewer outlets left in the 48 h window, no AI summary this time.
  foldStories(weeks, [story('a', 3, ['economia'])], NOW + 3.6e6);
  const a = weeks.get('2026-W41').stories.a;
  assert.equal(a.n, 8);
  assert.equal(a.aiSummary, 'Resumen');
  assert.equal(a.summary, undefined);
});

test('foldStories merges a story whose id changed (shared link)', () => {
  const weeks = new Map();
  foldStories(weeks, [story('a', 3, ['economia'])], NOW);
  // An older article joined: the story now has another id, but keeps a's links.
  const renamed = story('z', 4, ['economia']);
  renamed.sources.splice(0, 3, ...story('a', 3, ['economia']).sources);
  foldStories(weeks, [renamed], NOW);
  const w = weeks.get('2026-W41');
  assert.deepEqual(Object.keys(w.stories), ['z']);
  assert.equal(w.stories.z.n, 4);
});

test('foldStories files a story under the week it started and keeps a spoiler covered', () => {
  const weeks = new Map();
  const s = story('nba', 4, ['eeuu/nba'], '2026-10-05T10:00:00Z', { spoiler: true });
  s.sources[0].publishedAt = '2026-10-04T20:00:00Z'; // first article on the Sunday before
  foldStories(weeks, [s], NOW);
  assert.ok(weeks.get('2026-W40').stories.nba.spoiler);
  foldStories(weeks, [{ ...s, spoiler: undefined }], NOW);
  assert.ok(weeks.get('2026-W40').stories.nba.spoiler);
  assert.equal(weeks.has('2026-W41'), false);
});

test('old weeks are dropped and the index lists the newest first', () => {
  const weeks = new Map();
  const old = new Date(NOW - KEEP_WEEKS * 7 * 864e5).toISOString();
  foldStories(weeks, [story('old', 5, ['ciencia'], old), story('new', 2, ['ciencia'])], NOW);
  assert.deepEqual([...weeks.keys()], ['2026-W41']);
  foldStories(weeks, [story('prev', 2, ['ciencia'], '2026-10-01T10:00:00Z')], NOW);
  const index = weeklyIndex(weeks, NOW);
  assert.equal(index.current, '2026-W41');
  assert.deepEqual(index.weeks.map((w) => [w.id, w.stories]), [['2026-W41', 1], ['2026-W40', 1]]);
});
