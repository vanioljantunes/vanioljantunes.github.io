/* The catalog behind the four pickers.
 *
 * catalog.json is built offline by scripts/build-catalog.mjs, because the IDC proxy cannot
 * be searched: it takes exact PatientID, ModalitiesInStudy, limit and offset, and nothing
 * else. Everything the dropdowns offer therefore has to be indexed in advance.
 *
 * On the labels: `lesion` is the enrolment criterion of the collection the study came from,
 * not a diagnosis read off these pixels. Every patient in TCGA-GBM has glioblastoma, so the
 * label describes the case correctly, but it is a statement about the cohort rather than a
 * report on the image in front of you. The page says so, and so does this comment, because
 * it is the kind of thing that quietly turns into a false claim if nobody writes it down.
 */

export interface CatalogEntry {
  collection: string;
  modality: string;
  region: string;
  lesion: string;
  sequence: string;
  rawDescription: string;
  patientId: string;
  studyDate: string;
  studyUID: string;
  seriesUID: string;
  instances: number;
  instancesCapped?: boolean;
}

export interface Catalog {
  generated: string;
  sourceId: string;
  note: string;
  counts: {
    studiesSeen: number;
    studiesKept: number;
    series: number;
    collections: number;
  };
  entries: CatalogEntry[];
}

/* DICOM modality codes are not what a reader calls them. */
const MODALITY_NAMES: Record<string, string> = {
  CT: 'CT',
  MR: 'MRI',
  PT: 'PET',
  NM: 'Nuclear medicine',
  CR: 'X-ray',
  DX: 'X-ray',
  MG: 'Mammography',
  US: 'Ultrasound',
};

export const modalityName = (code: string): string => MODALITY_NAMES[code] ?? code;

/* CR and DX are both plain radiography and a reader has no reason to tell them apart in a
   picker, so they share one entry; the real code stays on the entry. */
export const modalityGroup = (code: string): string =>
  code === 'CR' || code === 'DX' ? 'XR' : code;

const groupName = (group: string): string =>
  group === 'XR' ? 'X-ray' : modalityName(group);

export async function loadCatalog(url = '/imaging/viewer/catalog.json'): Promise<Catalog> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`catalog unavailable (${res.status})`);
  const data = (await res.json()) as Catalog;
  if (!Array.isArray(data.entries) || data.entries.length === 0) {
    throw new Error('catalog is empty');
  }
  return data;
}

export interface Choice {
  value: string;
  label: string;
  count: number;
}

export interface Selection {
  modality?: string;
  region?: string;
  lesion?: string;
  sequence?: string;
}

/* Each level lists only what is still reachable given the levels above it, so the picker
   can never land on a combination with no series behind it. */
function tally(entries: CatalogEntry[], key: (e: CatalogEntry) => string): Choice[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const k = key(e);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function filterEntries(entries: CatalogEntry[], sel: Selection): CatalogEntry[] {
  return entries.filter(
    (e) =>
      (!sel.modality || modalityGroup(e.modality) === sel.modality) &&
      (!sel.region || e.region === sel.region) &&
      (!sel.lesion || e.lesion === sel.lesion) &&
      (!sel.sequence || e.sequence === sel.sequence)
  );
}

export function modalityChoices(entries: CatalogEntry[]): Choice[] {
  return tally(entries, (e) => modalityGroup(e.modality)).map((c) => ({
    ...c,
    label: groupName(c.value),
  }));
}

export const regionChoices = (entries: CatalogEntry[], sel: Selection): Choice[] =>
  tally(filterEntries(entries, { modality: sel.modality }), (e) => e.region);

export const lesionChoices = (entries: CatalogEntry[], sel: Selection): Choice[] =>
  tally(
    filterEntries(entries, { modality: sel.modality, region: sel.region }),
    (e) => e.lesion
  );

export const sequenceChoices = (entries: CatalogEntry[], sel: Selection): Choice[] =>
  tally(
    filterEntries(entries, {
      modality: sel.modality,
      region: sel.region,
      lesion: sel.lesion,
    }),
    (e) => e.sequence
  );

/* Changing one level can strand the levels below it. Rather than blanking them and making
   the reader choose everything again, keep whatever still survives and otherwise fall to
   the first option that remains valid. */
export function reconcile(entries: CatalogEntry[], sel: Selection): Selection {
  const next: Selection = {};

  const mods = modalityChoices(entries);
  next.modality =
    sel.modality && mods.some((m) => m.value === sel.modality)
      ? sel.modality
      : mods[0]?.value;

  const regions = regionChoices(entries, next);
  next.region =
    sel.region && regions.some((r) => r.value === sel.region)
      ? sel.region
      : regions[0]?.value;

  const lesions = lesionChoices(entries, next);
  next.lesion =
    sel.lesion && lesions.some((l) => l.value === sel.lesion)
      ? sel.lesion
      : lesions[0]?.value;

  /* The default sequence follows the same ranking as resolve(), so the dropdown shows what
     is actually about to be displayed rather than the first entry alphabetically. */
  const sequences = sequenceChoices(entries, next);
  next.sequence =
    sel.sequence && sequences.some((s) => s.value === sel.sequence)
      ? sel.sequence
      : resolve(entries, next)?.sequence ?? sequences[0]?.value;

  return next;
}

/* How useful a sequence is to open on, lower being better. Picking purely by slice count
   lands on things like a 93-image diffusion mosaic for a glioblastoma, which is real data
   but shows a grid of thumbnails rather than the enhancing tumour a reader came to see.
   Anything unlisted sits in the middle, so an unrecognised sequence is neither promoted
   nor buried. */
const SEQUENCE_RANK: Record<string, number> = {
  'T1 post-contrast': 0,
  FLAIR: 1,
  T2: 2,
  'Dynamic contrast': 3,
  'Soft-tissue kernel': 3,
  'Lung kernel': 3,
  'Arterial phase': 3,
  'Routine reconstruction': 4,
  'Low-dose CT': 4,
  T1: 5,
  'Venous phase': 5,
  'Delayed phase': 6,
  'Multiphase contrast': 6,
  'ADC map': 8,
  Diffusion: 9,
  Perfusion: 9,
  'Parametric map': 10,
  'Respiratory-gated phase': 11,
  Localizer: 12,
  'PET, not attenuation corrected': 12,
};

const DEFAULT_RANK = 7;
const rankOf = (e: CatalogEntry): number => SEQUENCE_RANK[e.sequence] ?? DEFAULT_RANK;

/* The series a selection resolves to. Best-ranked sequence first, and among equals the one
   with the most slices. When the reader has named a sequence themselves that choice is
   already in the filter, so the ranking only decides what they land on by default. */
export function resolve(entries: CatalogEntry[], sel: Selection): CatalogEntry | undefined {
  const matches = filterEntries(entries, sel);
  if (matches.length === 0) return undefined;
  return matches.reduce((best, e) => {
    const d = rankOf(e) - rankOf(best);
    if (d !== 0) return d < 0 ? e : best;
    return e.instances > best.instances ? e : best;
  });
}
