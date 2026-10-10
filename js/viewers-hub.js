/* Real counts on the viewer picker.
 *
 * The rows ship with the numbers that were true when the page was written, so the page
 * reads correctly with scripting off. The index is regenerated whenever the archive is
 * walked again, so those numbers drift; this replaces them with what the index actually
 * holds. The grouping matches the viewer: PET rides with CT, CR and DX are both X-ray.
 */

const GROUP = { PT: 'CT', CR: 'XR', DX: 'XR' };

const listRegions = (regions) => [...regions].map((r) => r.toLowerCase()).sort().join(', ');

try {
  const res = await fetch('/imaging/viewer/catalog.json');
  if (!res.ok) throw new Error(String(res.status));
  const catalog = await res.json();

  const byGroup = new Map();
  for (const entry of catalog.entries ?? []) {
    const group = GROUP[entry.modality] ?? entry.modality;
    const seen = byGroup.get(group) ?? { series: 0, regions: new Set() };
    seen.series += 1;
    if (entry.region) seen.regions.add(entry.region);
    byGroup.set(group, seen);
  }

  for (const row of document.querySelectorAll('[data-pick]')) {
    const seen = byGroup.get(row.dataset.pick);
    if (!seen) continue;
    const count = row.querySelector('[data-pick-count]');
    const regions = row.querySelector('[data-pick-regions]');
    if (count) count.textContent = String(seen.series);
    if (regions) regions.textContent = listRegions(seen.regions);
  }

  const all = document.querySelector('[data-pick-count-all]');
  const collections = document.querySelector('[data-pick-collections]');
  if (all && catalog.counts?.series) all.textContent = String(catalog.counts.series);
  if (collections && catalog.counts?.collections) {
    collections.textContent = String(catalog.counts.collections);
  }
} catch {
  /* The written-in numbers stand. A picker that cannot reach the index still picks. */
}
