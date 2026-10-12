// Fills the weekly archive with older editions (news.json files), e.g. the ones each run of
// "Actualizar noticias" left in the Actions cache. The archive only grows from the editions it sees
// and each one covers 48 h, so this recovers the days before the archive existed (or after it was lost).
//
//   node scripts/ingest/backfill-weekly.js ediciones/*/news.json
//
// Editions are folded oldest first into web/data/weekly/; duplicates (same generatedAt) are skipped.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldStories, readWeeks, writeWeeks } from './weekly.js';

const WEEKLY = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/data/weekly');

const editions = new Map();
for (const file of process.argv.slice(2)) {
  try {
    const ed = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(ed.stories) && Date.parse(ed.generatedAt)) editions.set(ed.generatedAt, ed);
    else console.warn(`⚠ ${file}: no es una edición`);
  } catch (err) {
    console.warn(`⚠ ${file}: ${err.message}`);
  }
}

const weeks = await readWeeks(WEEKLY);
const changed = new Set();
const sorted = [...editions.values()].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
for (const ed of sorted) {
  try {
    for (const id of foldStories(weeks, ed.stories, Date.parse(ed.generatedAt))) changed.add(id);
  } catch (err) {
    console.warn(`⚠ Edición ${ed.generatedAt} saltada: ${err.message}`);
  }
}
console.log(`✓ ${sorted.length} ediciones (${sorted[0]?.generatedAt ?? '—'} → ${sorted.at(-1)?.generatedAt ?? '—'})`);
console.log(`  semanal: ${await writeWeeks(WEEKLY, weeks, changed)}`);
