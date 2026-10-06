/* Re-apply the sequence naming rules to an existing catalogue.
 *
 * The crawler stores each series' raw SeriesDescription alongside the name it derived from
 * it, so improving the rules does not require crawling the archive again: the same function
 * is imported from the crawler and run over what is already on disk.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sequenceLabel } from './build-catalog.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(repo, 'imaging/viewer/catalog.json');

const catalog = JSON.parse(readFileSync(path, 'utf8'));
const changes = [];

for (const entry of catalog.entries) {
  const next = sequenceLabel(entry.rawDescription, entry.modality);
  if (next !== entry.sequence) {
    changes.push(`${entry.modality}  ${entry.sequence}  ->  ${next}`);
    entry.sequence = next;
  }
}

writeFileSync(path, JSON.stringify(catalog, null, 1), 'utf8');

const counts = new Map();
for (const c of changes) counts.set(c, (counts.get(c) ?? 0) + 1);
console.log(`${changes.length} of ${catalog.entries.length} series relabelled`);
for (const [line, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${line}`);
}
