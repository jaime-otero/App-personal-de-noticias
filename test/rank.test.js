import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultProfile } from '../web/lib/profile.js';
import { rankStories, rankWeek, scoreStory, train, featuresOf, entities, topFeatures, sortEntries } from '../web/lib/rank.js';

const NOW = Date.parse('2026-10-04T12:00:00Z');
let n = 0;
const story = (title, sections, extra = {}) => ({
  id: `s${n++}`, title, sections, lang: 'es', summary: '', publishedAt: '2026-10-04T11:00:00Z',
  sources: [{ sourceId: 'elpais', source: 'El País', url: 'https://x', title }], ...extra,
});
const ids = (entries) => entries.map((e) => e.story.id);

test('entities picks proper names, not the first word of the sentence', () => {
  assert.deepEqual(entities('Los Golden State Warriors fichan a un base del CERN'), ['golden state warriors', 'cern']);
  assert.deepEqual(entities('Pedro Sánchez se reúne con Merz'), ['pedro sanchez', 'merz']);
  assert.deepEqual(entities('Óscar Puente se reúne con Ángel Víctor Torres'), ['oscar puente', 'angel victor torres']);
});

test('features include sections, parent section, outlet, words, pairs and entities', () => {
  const f = featuresOf(story('Gran noche de Wembanyama en San Antonio', ['eeuu/nba']));
  for (const k of ['s:eeuu/nba', 's:eeuu', 'src:elpais', 'w:wembanyama', 'b:noche wembanyama', 'e:wembanyama', 'e:san antonio']) assert.ok(k in f, k);
});

test('section preferences reorder the feed; subsections inherit from their section', () => {
  const p = defaultProfile(NOW);
  p.sections['ciencia'] = 3;
  p.sections['espana'] = 0;
  const a = story('El Madrid gana la liga', ['espana/deportes']);
  const b = story('Nuevo récord cuántico', ['ciencia/fisica']);
  assert.deepEqual(ids(rankStories([a, b], p, NOW)), [b.id, a.id]);
  p.sections['espana/deportes'] = 3;
  p.sections['ciencia/fisica'] = 0;
  assert.deepEqual(ids(rankStories([a, b], p, NOW)), [a.id, b.id]);
});

test('hidden sections, muted outlets/keywords, dislikes and languages filter stories out', () => {
  const p = defaultProfile(NOW);
  p.sections['espana/deportes'] = -2;
  assert.equal(scoreStory(story('Partido', ['espana/deportes']), p, NOW), null);
  const q = defaultProfile(NOW);
  q.sources.elpais = -1;
  assert.equal(scoreStory(story('Algo', ['ciencia']), q, NOW), null);
  const r = defaultProfile(NOW);
  r.muteKeywords = ['horóscopo'];
  assert.equal(scoreStory(story('Tu horoscopo de hoy', []), r, NOW), null);
  const d = story('No me interesa', ['ciencia']);
  r.disliked[d.id] = NOW;
  assert.equal(scoreStory(d, r, NOW), null);
  r.langs = ['es'];
  assert.equal(scoreStory(story('Hello', [], { lang: 'en' }), r, NOW), null);
  // A story told by English and Spanish outlets still shows to someone who only reads Spanish.
  assert.equal(scoreStory(story('Hello', [], { lang: 'en', langs: ['en', 'es'] }), r, NOW) === null, false);
  assert.equal(scoreStory(story('Hello', [], { lang: 'en', langs: ['en'] }), r, NOW), null);
});

test('a like lifts similar stories, not unrelated ones; a dislike pushes them down', () => {
  const p = defaultProfile(NOW);
  const liked = story('Wembanyama renueva con los San Antonio Spurs', ['eeuu/nba']);
  const similar = story('Los San Antonio Spurs preparan la temporada de Wembanyama', ['eeuu/nba']);
  const other = story('El Gobierno aprueba los presupuestos', ['espana/politica'], { sources: [{ sourceId: 'abc', source: 'ABC', url: 'https://x', title: 'x' }] });
  const before = { s: scoreStory(similar, p, NOW).score, o: scoreStory(other, p, NOW).score };
  train(p.model, liked, 'like', NOW);
  const after = { s: scoreStory(similar, p, NOW).score, o: scoreStory(other, p, NOW).score };
  assert.ok(after.s > before.s + 0.5, 'similar story goes up');
  assert.ok(Math.abs(after.o - before.o) < 0.1, 'unrelated story barely moves');
  assert.ok(scoreStory(similar, p, NOW).reasons.length > 0, 'and says why');
  for (let i = 0; i < 3; i++) train(p.model, liked, 'dislike', NOW);
  assert.ok(scoreStory(similar, p, NOW).score < before.s);
});

test('several likes in a subsection make it win over fresher news', () => {
  const p = defaultProfile(NOW);
  for (let i = 0; i < 6; i++) train(p.model, story(`Noticia de física número ${i} sobre materiales`, ['ciencia/fisica']), 'like', NOW);
  const physics = story('Un láser revela correlaciones ocultas', ['ciencia/fisica'], { publishedAt: '2026-10-04T05:00:00Z' });
  const fresh = story('Atasco en la M-30 por obras', ['espana/sociedad']);
  assert.equal(rankStories([fresh, physics], p, NOW)[0].story.id, physics.id);
  const { pos } = topFeatures(p.model);
  assert.ok(pos.some(([k]) => k === 's:ciencia/fisica'));
});

test('skip only blames section and outlet, never words', () => {
  const p = defaultProfile(NOW);
  train(p.model, story('Wembanyama habla', ['eeuu/nba']), 'skip', NOW);
  assert.ok(Object.keys(p.model.w).every((k) => /^(s|src):/.test(k)));
});

test('exploration slots a well-covered unusual story every 10 positions', () => {
  const p = defaultProfile(NOW);
  p.sections['espana'] = 3;
  const many = Array.from({ length: 12 }, (_, i) => story(`Política número ${i}`, ['espana/politica']));
  const covered = story('Gran noticia internacional', ['internacional/asia'], {
    publishedAt: '2026-10-03T06:00:00Z',
    sources: ['a', 'b', 'c', 'd'].map((s) => ({ sourceId: s, source: s, url: 'https://x', title: 'x' })),
  });
  p.sections['internacional'] = -1;
  const ranked = rankStories([...many, covered], p, NOW, { explore: true });
  assert.equal(ranked[9].story.id, covered.id);
  assert.equal(ranked[9].explore, true);
});

test('sortEntries orders by recency or by coverage and drops exploration marks', () => {
  const mk = (id, h, n) => ({ story: { id, publishedAt: new Date(Date.UTC(2026, 0, 1, h)).toISOString(), sources: Array.from({ length: n }, () => ({})) } });
  const entries = [mk('a', 1, 3), { ...mk('b', 5, 1), explore: true }, mk('c', 3, 3)];
  const ids = (list) => list.map((e) => e.story.id);
  assert.deepEqual(ids(sortEntries(entries, 'foryou')), ['a', 'b', 'c']);
  assert.deepEqual(ids(sortEntries(entries, 'recent')), ['b', 'c', 'a']);
  assert.deepEqual(ids(sortEntries(entries, 'coverage')), ['c', 'a', 'b']);
  assert.ok(sortEntries(entries, 'recent').every((e) => !e.explore));
  assert.deepEqual(ids(entries), ['a', 'b', 'c']);
});

// Weekly topics: an importance score (weekly.js) and no freshness that matters.
const topic = (title, sections, score) => story(title, sections, { score, n: Math.round(score), publishedAt: '2026-09-29T10:00:00Z' });

// The three biggest topics of a week, which "Para mí" always puts first.
const big = () => [topic('Rusia y Ucrania firman una tregua', ['internacional/europa'], 40), topic('Terremoto en Panamá', ['internacional/latam'], 35), topic('El papa sale del hospital', ['internacional'], 30)];

test('rankWeek: the three biggest topics first, then the person\'s sections reorder the rest', () => {
  const p = defaultProfile(NOW);
  const top = big();
  const politics = topic('El Gobierno convoca elecciones', ['espana/politica'], 16);
  const nba = topic('Doncic firma con los Lakers', ['eeuu/nba'], 8);
  assert.deepEqual(ids(rankWeek([nba, politics, ...top], p)), [...ids(top.map((story) => ({ story }))), politics.id, nba.id]);
  p.sections['eeuu/nba'] = 3; // Me encanta
  p.sections['espana'] = 0; // Poco
  p.sections['internacional'] = 0;
  // The big three stay first even outside the person's sections; below, 4.5 of interest beat 2 of importance.
  assert.deepEqual(ids(rankWeek([politics, nba, ...top], p)).slice(3), [nba.id, politics.id]);
  assert.deepEqual(ids(rankWeek([politics, nba, ...top], p)).slice(0, 3), ids(top.map((story) => ({ story }))));
  const war = topic('Bruselas aprueba el presupuesto', ['espana/politica'], 128);
  assert.equal(ids(rankWeek([nba, war], p))[0], war.id);
});

test('rankWeek: a much bigger topic stays above a loved one beyond the first three', () => {
  const p = defaultProfile(NOW);
  p.sections['eeuu/nba'] = 3;
  p.sections['espana'] = 0;
  const nba = topic('Doncic firma con los Lakers', ['eeuu/nba'], 2);
  const budget = topic('El Congreso aprueba los presupuestos', ['espana/politica'], 16);
  assert.deepEqual(ids(rankWeek([nba, budget, ...big()], p)).slice(3), [budget.id, nba.id]); // 8 times the coverage: 6 points of importance
});

test('rankWeek leaves out what the person filtered and says why a topic is there', () => {
  const p = defaultProfile(NOW);
  const a = topic('Wembanyama lidera a los Spurs', ['eeuu/nba'], 4);
  const b = topic('Nuevo récord cuántico', ['ciencia/fisica'], 4);
  for (let i = 0; i < 5; i++) train(p.model, topic('Wembanyama vuelve a brillar', ['eeuu/nba'], 4), 'like', NOW);
  p.hidden[b.id] = NOW;
  const ranked = rankWeek([a, b], p);
  assert.deepEqual(ids(ranked), [a.id]);
  assert.ok(ranked[0].reasons.length);
});
