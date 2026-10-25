import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekOf, foldStories, weeklyIndex, embedMissing, TOP_N, KEEP_WEEKS } from '../scripts/ingest/weekly.js';
import { normalizeVec } from '../scripts/ingest/embed.js';

const NOW = Date.parse('2026-10-11T18:00:00Z'); // Sunday

// Hand-made vectors stand in for the model (cluster.test.js does the same).
const v = (...xs) => normalizeVec(Float32Array.from(xs));
const withVec = (story, vec) => Object.defineProperty(story, 'vec', { value: vec, enumerable: false });

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

test('readWeeks/writeWeeks round-trip and drop the files of weeks no longer kept', async () => {
  const { mkdtemp, readdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readWeeks, writeWeeks } = await import('../scripts/ingest/weekly.js');
  const dir = await mkdtemp(join(tmpdir(), 'weekly-'));
  try {
    await writeFile(join(dir, '2026-W01.json'), JSON.stringify({ id: '2026-W01', start: '2025-12-29', end: '2026-01-04', stories: {}, top: {} }));
    const weeks = await readWeeks(dir);
    assert.deepEqual([...weeks.keys()], ['2026-W01']);
    const changed = foldStories(weeks, [story('a', 3, ['ciencia'])], NOW); // also drops W01 (too old)
    await writeWeeks(dir, weeks, changed, NOW);
    assert.deepEqual((await readdir(dir)).sort(), ['2026-W41.json', '2026-W41.pool.json', 'index.json']);
    assert.deepEqual([...(await readWeeks(dir)).keys()], ['2026-W41']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('weeklyAIJobs: provisional once a day while the week is open, final once when it closes', async () => {
  const { weeklyAIJobs, applyWeeklyAI } = await import('../scripts/ingest/weekly.js');
  const weeks = new Map();
  foldStories(weeks, [
    story('a', 6, ['espana/politica']),
    story('b', 4, ['espana/economia']),
    story('n1', 5, ['eeuu/nba']),
    story('n2', 3, ['eeuu/nba'], undefined, { spoiler: true }),
    story('n3', 2, ['eeuu/nba']),
  ], NOW);
  const jobs = weeklyAIJobs(weeks, NOW);
  const byKey = Object.fromEntries(jobs.map((j) => [j.key, j]));
  // Only keys with 2+ stories: Para ti, España and the NBA.
  assert.deepEqual(Object.keys(byKey).sort(), ['all', 'eeuu/nba', 'espana']);
  assert.equal(byKey.all.final, false); // Sunday: the week is still open
  assert.deepEqual(byKey.all.stories.map((s) => s.id), ['a', 'b']); // NBA stories only in the NBA call
  assert.deepEqual(byKey['eeuu/nba'].stories.map((s) => s.id), ['n1', 'n3']); // no spoilers to the model
  assert.equal(byKey['eeuu/nba'].nba, true);
  assert.deepEqual(byKey.all.week, { start: '2026-10-05', end: '2026-10-11' });

  for (const j of jobs) applyWeeklyAI(weeks, j, { briefing: `Resumen ${j.key}`, summaries: { a: 'IA de a' }, model: 'm' }, NOW);
  const w = weeks.get('2026-W41');
  assert.equal(w.briefings.espana.text, 'Resumen espana');
  assert.equal(w.briefings.espana.final, undefined);
  assert.equal(w.stories.a.aiSummary, 'IA de a');
  assert.equal(w.stories.a.summary, undefined);
  assert.equal(w.pool.a.aiSummary, 'IA de a'); // kept for the next rebuild

  // Same day: nothing due. Next day (Monday, not closed yet): provisional again.
  assert.equal(weeklyAIJobs(weeks, NOW + 3 * 3.6e6).length, 0);
  const monday = NOW + 21 * 3.6e6;
  assert.ok(weeklyAIJobs(weeks, monday).every((j) => !j.final));
  // Tuesday: final, then never again.
  const tuesday = Date.parse('2026-10-13T08:00:00Z');
  const final = weeklyAIJobs(weeks, tuesday);
  assert.ok(final.length === 3 && final.every((j) => j.final));
  for (const j of final) applyWeeklyAI(weeks, j, { briefing: 'Final', summaries: {}, model: 'm' }, tuesday);
  assert.equal(w.briefings.all.final, true);
  assert.equal(weeklyAIJobs(weeks, tuesday + 5 * 864e5).length, 0);
  // A failed call leaves the briefing as it was, so it is retried.
  assert.equal(applyWeeklyAI(weeks, final[0], null, tuesday), false);
});

test('weeklyAIJobs does one week per run, the newest first', async () => {
  const { weeklyAIJobs } = await import('../scripts/ingest/weekly.js');
  const weeks = new Map();
  foldStories(weeks, [story('a', 3, ['ciencia']), story('b', 2, ['ciencia']), story('c', 3, ['ciencia'], '2026-10-01T10:00:00Z'), story('d', 2, ['ciencia'], '2026-10-01T11:00:00Z')], NOW);
  const ids = new Set(weeklyAIJobs(weeks, NOW).map((j) => j.weekId));
  assert.deepEqual([...ids], ['2026-W41']);
});

test('foldStories accepts stories from old editions without langs or sections', () => {
  const weeks = new Map();
  const old = story('old', 4, ['ciencia']);
  delete old.langs;
  const bare = story('bare', 2, []);
  delete bare.langs;
  delete bare.sections;
  foldStories(weeks, [old, bare, story('new', 4, ['ciencia'])], NOW);
  const w = weeks.get('2026-W41');
  assert.deepEqual(w.stories.old.langs, ['es']);
  assert.deepEqual(w.stories.bare.sections, []);
  assert.deepEqual(w.top.all, ['old', 'new', 'bare']);
});

test('outlets add up over the week: a topic that lasts beats a one-day one', () => {
  const weeks = new Map();
  foldStories(weeks, [story('long', 4, ['economia'], '2026-10-07T10:00:00Z'), story('one', 6, ['economia'], '2026-10-08T10:00:00Z')], NOW);
  // Two days later, the first story is back with two more outlets.
  foldStories(weeks, [story('long', 6, ['economia'], '2026-10-09T10:00:00Z')], NOW);
  const w = weeks.get('2026-W41');
  assert.deepEqual(w.top.all, ['long', 'one']);
  const long = w.stories.long;
  assert.equal(long.n, 6);
  assert.equal(long.days, 2);
  assert.equal(long.score, 6 + 0.25 * 4); // 4 outlets came back on the second day
  assert.equal(long.publishedAt, '2026-10-07T10:00:00Z');
  assert.equal(w.stories.one.score, 6);
});

test('an outlet counts once whatever feed it came through', () => {
  const weeks = new Map();
  const first = story('a', 2, ['internacional'], '2026-10-07T10:00:00Z');
  const second = story('a', 2, ['internacional'], '2026-10-08T10:00:00Z');
  second.sources[0].sourceId = 'm0-internacional'; // same outlet (Medio 0), another feed
  foldStories(weeks, [first], NOW);
  foldStories(weeks, [second], NOW);
  assert.equal(weeks.get('2026-W41').stories.a.n, 2);
});

test('the headline shown and its outlets come from the same copy of a story', () => {
  const weeks = new Map();
  foldStories(weeks, [story('a', 8, ['deportes'], undefined, { title: 'Messi se despide de Argentina' })], NOW);
  // A copy that shares one link but holds fewer outlets (one odd article the daily grouping put
  // together) does not lend its headline to the other's coverage.
  const odd = story('b', 2, ['deportes'], undefined, { title: 'Cristiano, a un periodista: deja el bótox' });
  odd.sources[0] = story('a', 1, [])['sources'][0];
  foldStories(weeks, [odd], NOW);
  const w = weeks.get('2026-W41');
  assert.deepEqual(Object.keys(w.stories), ['b']);
  assert.equal(w.stories.b.title, 'Messi se despide de Argentina');
  assert.equal(w.stories.b.sources[0].url, 'https://m0.es/a');
  assert.equal(w.stories.b.n, 8);
});

test('stories of one topic on different days become one entry with its timeline', () => {
  const weeks = new Map();
  foldStories(weeks, [
    withVec(story('truce', 5, ['internacional/europa'], '2026-10-10T10:00:00Z', { title: 'Trump anuncia una tregua entre Rusia y Ucrania' }), v(1, 0.1, 0)),
    withVec(story('attack', 3, ['internacional/europa'], '2026-10-09T08:00:00Z', { title: 'Rusia ataca Ucrania horas antes de hablar con Trump' }), v(1, 0, 0)),
    // Close vector, but nothing else in common: another topic.
    withVec(story('energy', 4, ['economia/energia'], '2026-10-09T09:00:00Z', { title: 'Sube el precio del gas en Europa' }), v(1, 0.05, 0)),
    withVec(story('liga', 2, ['deportes/futbol'], '2026-10-10T20:00:00Z', { title: 'El Barça gana al Sevilla' }), v(0, 0, 1)),
  ], NOW);
  const w = weeks.get('2026-W41');
  assert.deepEqual(w.top.all, ['truce', 'energy', 'liga']);
  const t = w.stories.truce;
  assert.equal(t.title, 'Trump anuncia una tregua entre Rusia y Ucrania'); // the most covered
  assert.deepEqual(t.ids, ['truce', 'attack']);
  assert.equal(t.related, undefined); // no timeline list: it mixed in stories that did not belong
  assert.equal(t.publishedAt, '2026-10-09T08:00:00Z');
  assert.equal(t.n, 5); // the same outlets m0–m2 told both
  assert.equal(t.days, 2);
  assert.ok(t.score > w.stories.energy.score);
  // Both stories stay in the pool, so the topic keeps adding up.
  assert.deepEqual(Object.keys(w.pool).sort(), ['attack', 'energy', 'liga', 'truce']);
});

test('weeks saved before pools become pools, get vectors and group into topics', async () => {
  const { mkdtemp, readdir, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readWeeks, writeWeeks } = await import('../scripts/ingest/weekly.js');
  const dir = await mkdtemp(join(tmpdir(), 'weekly-'));
  try {
    // As the archive saved them: compact stories with their peak outlet count (n).
    const old = (id, n, title, at) => {
      const { sources, ...s } = story(id, n, ['internacional'], at, { title });
      return { ...s, n, sources: sources.slice(0, 6).map(({ title, url, source, sourceId }) => ({ title: `${title} ${id}`, url, source, sourceId })) };
    };
    const stories = [old('a', 9, 'Trump anuncia una tregua entre Rusia y Ucrania', '2026-10-10T10:00:00Z'), old('b', 4, 'Rusia ataca Ucrania antes de hablar con Trump', '2026-10-08T10:00:00Z'), old('c', 3, 'El Barça gana al Sevilla', '2026-10-09T10:00:00Z')];
    const legacy = { id: '2026-W41', start: '2026-10-05', end: '2026-10-11', updatedAt: '2026-10-11T10:00:00Z', briefings: { all: { text: 'Resumen', at: '2026-10-11T10:00:00Z', final: true } }, stories: Object.fromEntries(stories.map((s) => [s.id, s])), top: { all: ['a', 'b', 'c'] } };
    await writeFile(join(dir, '2026-W41.json'), JSON.stringify(legacy));
    const weeks = await readWeeks(dir);
    assert.equal(weeks.get('2026-W41').pool, undefined);

    const embedder = { id: 'fake', embed: async (texts) => texts.map((t) => (/Barça/.test(t) ? v(0, 1) : v(1, 0))) };
    const changed = await embedMissing(weeks, embedder);
    assert.deepEqual(changed, ['2026-W41']);
    assert.deepEqual(await embedMissing(weeks, embedder), []); // nothing left to embed
    const w = weeks.get('2026-W41');
    assert.deepEqual(w.top.all, ['a', 'c']);
    assert.equal(w.stories.a.n, 9); // the peak count of the old week is kept
    assert.deepEqual(w.stories.a.ids.sort(), ['a', 'b']);
    assert.equal(w.briefings.all.text, 'Resumen');

    await writeWeeks(dir, weeks, changed, NOW);
    assert.deepEqual((await readdir(dir)).sort(), ['2026-W41.json', '2026-W41.pool.json', 'index.json']);
    const published = JSON.parse(await readFile(join(dir, '2026-W41.json'), 'utf8'));
    assert.equal(published.pool, undefined);
    assert.equal(published.model, undefined);
    const again = (await readWeeks(dir)).get('2026-W41');
    assert.equal(again.model, 'fake');
    assert.deepEqual(Object.keys(again.pool).sort(), ['a', 'b', 'c']);
    assert.ok(again.pool.a.vec);
    // Another model: its vectors are not comparable, so every story is embedded again.
    const other = { id: 'other', embed: async (texts) => texts.map(() => v(1, 0)) };
    assert.deepEqual(await embedMissing(new Map([['2026-W41', again]]), other), ['2026-W41']);
    assert.equal(again.model, 'other');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A story told by these outlets (by name), on one day.
function toldBy(id, outlets, extra = {}) {
  const s = story(id, outlets.length, ['espana'], undefined, extra);
  s.sources.forEach((x, i) => Object.assign(x, { source: outlets[i], sourceId: outlets[i].toLowerCase() }));
  return s;
}

test('outletWeights: specialised outlets weigh half, sources.json can override it', async () => {
  const { outletWeights } = await import('../scripts/ingest/weekly.js');
  const w = outletWeights([
    { name: 'Diario', sections: ['espana'] },
    { name: 'Diario', sections: ['espana/deportes'] }, // a sports feed of a general paper
    { name: 'Deportivo', sections: ['espana/deportes'] },
    { name: 'Deportivo', sections: ['eeuu/nba', 'deportes/tenis'] }, // NBA is sport too
    { name: 'Revista', sections: ['ciencia/espacio'] },
    { name: 'Divulga', sections: [], weight: 0.5 },
    { name: 'Agencia', sections: ['ciencia'], weight: 1 },
  ]);
  assert.deepEqual(Object.fromEntries(w), { Diario: 1, Deportivo: 0.5, Revista: 0.5, Divulga: 0.5, Agencia: 1 });
});

test('specialised outlets count half: a story that reaches the general papers ranks higher', () => {
  const weeks = new Map();
  foldStories(weeks, [
    toldBy('sport', ['Marca', 'AS', 'Mundo Deportivo', 'ESPN', 'BBC Sport', 'CBS Sports']),
    toldBy('news', ['El País', 'El Mundo', 'ABC', 'RTVE']),
  ], NOW);
  const w = weeks.get('2026-W41');
  assert.deepEqual(w.top.all, ['news', 'sport']);
  assert.equal(w.stories.sport.n, 6); // the count shown is still every outlet
  assert.equal(w.stories.sport.score, 3);
  assert.equal(w.stories.news.score, 4);
});

test('soft topics weigh less', () => {
  const weeks = new Map();
  foldStories(weeks, [
    toldBy('memes', ['El País', 'El Mundo', 'ABC', 'RTVE', '20minutos'], { title: 'Musk presenta su coche volador y las redes se llenan de memes' }),
    toldBy('law', ['El País', 'El Mundo', 'ABC', 'RTVE'], { title: 'El Congreso aprueba la ley de vivienda' }),
  ], NOW);
  const w = weeks.get('2026-W41');
  assert.deepEqual(w.top.all, ['law', 'memes']);
  assert.equal(w.stories.memes.soft, true);
  assert.equal(w.stories.memes.score, 3);
  assert.equal(w.stories.law.soft, undefined);
});

test('a service headline gives way to another outlet\'s', () => {
  const weeks = new Map();
  const s = toldBy('match', ['Marca', 'El País'], { title: 'A qué hora es el Alcaraz - Sinner: horario y dónde ver la final', summary: 'Horario y canal' });
  s.sources[0].title = s.title;
  s.sources[1].title = 'Alcaraz gana a Sinner y se lleva Shanghái';
  foldStories(weeks, [s], NOW);
  const shown = weeks.get('2026-W41').stories.match;
  assert.equal(shown.title, 'Alcaraz gana a Sinner y se lleva Shanghái');
  assert.equal(shown.sources[0].source, 'El País'); // the headline links to its own article
  assert.equal(shown.summary, undefined); // the extract was the service piece's
});

test('a topic that goes on from the week before links to it', () => {
  const weeks = new Map();
  const truce = (id, n, at, title) => withVec(story(id, n, ['internacional/europa'], at, { title }), v(1, 0.05, 0));
  foldStories(weeks, [
    truce('w40', 7, '2026-10-02T10:00:00Z', 'Rusia y Ucrania negocian una tregua con Trump'),
    withVec(story('quake', 5, ['internacional/latam'], '2026-10-02T11:00:00Z', { title: 'Terremoto en Panamá' }), v(0, 1, 0)),
  ], NOW);
  foldStories(weeks, [
    truce('w41a', 4, '2026-10-07T10:00:00Z', 'Trump anuncia la tregua entre Rusia y Ucrania'),
    truce('w41b', 3, '2026-10-08T10:00:00Z', 'Rusia rompe la tregua en Ucrania, dice Trump'),
    withVec(story('nobel', 6, ['ciencia'], '2026-10-07T12:00:00Z', { title: 'Nobel de Física para el IceCube' }), v(0, 0, 1)),
  ], NOW);
  const w41 = weeks.get('2026-W41');
  assert.deepEqual(w41.stories.w41a.prev, { week: '2026-W40', id: 'w40', title: 'Rusia y Ucrania negocian una tregua con Trump', n: 7 });
  assert.equal(w41.stories.nobel.prev, undefined);
  assert.deepEqual(w41.stories.w41a.ids.sort(), ['w41a', 'w41b']);
  // The week before does not link forward.
  assert.equal(weeks.get('2026-W40').stories.w40.prev, undefined);
});

test('embedMissing rebuilds a week when the one before gets its vectors', async () => {
  const weeks = new Map();
  // Stories without vectors (an old edition): no topics, no links yet.
  foldStories(weeks, [story('w40', 7, ['internacional'], '2026-10-02T10:00:00Z', { title: 'Rusia y Ucrania negocian una tregua con Trump' })], NOW);
  foldStories(weeks, [story('w41', 4, ['internacional'], '2026-10-07T10:00:00Z', { title: 'Trump anuncia la tregua entre Rusia y Ucrania' })], NOW);
  assert.equal(weeks.get('2026-W41').stories.w41.prev, undefined);
  const embedder = { id: 'fake', embed: async (texts) => texts.map(() => v(1, 0)) };
  assert.deepEqual(await embedMissing(weeks, embedder), ['2026-W40', '2026-W41']);
  assert.equal(weeks.get('2026-W41').stories.w41.prev.id, 'w40');
});
