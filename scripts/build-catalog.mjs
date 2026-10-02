/* Builds imaging/viewer/catalog.json, the index behind the four dropdowns.
 *
 * The IDC proxy cannot be searched: it accepts exact PatientID, ModalitiesInStudy, limit
 * and offset, but rejects StudyDescription (400) and ignores wildcards (204). So the only
 * way to offer a picker is to walk the archive offline, classify what comes back, and ship
 * the result as a static file. Nothing here runs in the browser.
 *
 * Classification is by PatientID prefix, because that is what reliably identifies the
 * source collection. The disease attached to each collection below is its enrolment
 * criterion - every patient in TCGA-GBM has glioblastoma - so it describes the case
 * accurately. Anything whose collection is not in this table is left unclassified and
 * never shown under a disease label.
 *
 *   node scripts/build-catalog.mjs [--pages N] [--per-collection N] [--out FILE]
 */

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT =
  'https://proxy.imaging.datacommons.cancer.gov/current/' +
  'viewer-only-no-downloads-see-tinyurl-dot-com-slash-3j3d9jyp/dicomWeb';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const PAGES = Number(arg('--pages', 60));
const PAGE_SIZE = 100;
const PER_COLLECTION = Number(arg('--per-collection', 10));
const OUT = resolve(repoRoot, arg('--out', 'imaging/viewer/catalog.json'));
/* A cross-sectional series is only worth showing if it has enough slices to scroll, but a
   radiograph or a mammogram is one to four images by nature. A single floor of 20 silently
   excluded every CR, DX and MG study in the archive. */
const MIN_INSTANCES = { CR: 1, DX: 1, MG: 1, XA: 1, RF: 1, US: 4 };
const MIN_INSTANCES_DEFAULT = 20;
const minInstances = (modality) => MIN_INSTANCES[modality] ?? MIN_INSTANCES_DEFAULT;

/* PatientID prefix -> what that collection is. */
const COLLECTIONS = [
  { id: 'upenn-gbm', match: /^UPENN-GBM/i, region: 'Brain', lesion: 'Glioblastoma' },
  { id: 'remind', match: /^ReMIND/i, region: 'Brain', lesion: 'Brain tumour, intraoperative' },
  { id: 'lidc', match: /^LIDC-IDRI/i, region: 'Chest', lesion: 'Pulmonary nodules' },
  { id: 'nlst', match: /^\d{6}$/, region: 'Chest', lesion: 'Lung cancer screening' },
  { id: 'midrc', match: /^MIDRC-RICORD/i, region: 'Chest', lesion: 'COVID-19 pneumonia' },
  { id: 'fourd-lung', match: /^\d+_HM\d+/i, region: 'Chest', lesion: 'Lung cancer, 4D CT' },
  { id: 'hcc-tace', match: /^HCC_/i, region: 'Liver', lesion: 'Hepatocellular carcinoma' },
  { id: 'prostatex', match: /^ProstateX/i, region: 'Prostate', lesion: 'Prostate cancer, scored lesions' },
  { id: 'prostate-mri', match: /^Prostate-/i, region: 'Prostate', lesion: 'Prostate cancer' },
  { id: 'kits', match: /^C4KC-KiTS/i, region: 'Kidney', lesion: 'Renal tumour' },
  { id: 'duke-breast', match: /^Breast_MRI/i, region: 'Breast', lesion: 'Breast cancer' },
  { id: 'ispy', match: /^ISPY/i, region: 'Breast', lesion: 'Breast cancer, neoadjuvant' },
  { id: 'cbis-mass', match: /^Mass-(Training|Test)/i, region: 'Breast', lesion: 'Breast mass' },
  { id: 'cbis-calc', match: /^Calc-(Training|Test)/i, region: 'Breast', lesion: 'Breast calcifications' },
];

/* In TCGA the two characters after the dash are the tissue source site, which determines
   the tumour type. Only sites I can state are listed; any other TCGA case falls through to
   unclassified rather than being guessed at. */
const TCGA_BY_SITE = [
  { re: /^TCGA-(02|06|08|12|14|19|27|28|76)-/i, region: 'Brain', lesion: 'Glioblastoma', id: 'tcga-gbm' },
  { re: /^TCGA-(CS|DU|DB|FG|HT|TQ)-/i, region: 'Brain', lesion: 'Lower-grade glioma', id: 'tcga-lgg' },
  { re: /^TCGA-(BH|AR|E2|D8)-/i, region: 'Breast', lesion: 'Breast carcinoma', id: 'tcga-brca' },
  { re: /^TCGA-(DD|G3|2V|ED|K7)-/i, region: 'Liver', lesion: 'Hepatocellular carcinoma', id: 'tcga-lihc' },
  { re: /^TCGA-(B0|CJ|CZ|KL|KM)-/i, region: 'Kidney', lesion: 'Renal cell carcinoma', id: 'tcga-kirc' },
  { re: /^TCGA-(EJ|HC|G9|CH|J4)-/i, region: 'Prostate', lesion: 'Prostate adenocarcinoma', id: 'tcga-prad' },
  { re: /^TCGA-(AA|AZ|CM|DM|F4)-/i, region: 'Colorectal', lesion: 'Colorectal adenocarcinoma', id: 'tcga-coad' },
  { re: /^TCGA-(BJ|DJ|EM|ET|EL|KS)-/i, region: 'Thyroid', lesion: 'Thyroid carcinoma', id: 'tcga-thca' },
  { re: /^TCGA-(CV|BA|CN|CR|DQ)-/i, region: 'Head and neck', lesion: 'Head and neck squamous carcinoma', id: 'tcga-hnsc' },
  { re: /^TCGA-(05|38|49|50|55|78|J2)-/i, region: 'Chest', lesion: 'Lung adenocarcinoma', id: 'tcga-luad' },
  { re: /^TCGA-(18|22|33|34|43|52|56)-/i, region: 'Chest', lesion: 'Lung squamous carcinoma', id: 'tcga-lusc' },
];

function classify(patientId) {
  const pid = (patientId || '').trim();
  if (!pid) return undefined;
  for (const c of TCGA_BY_SITE) {
    if (c.re.test(pid)) return { id: c.id, region: c.region, lesion: c.lesion };
  }
  for (const c of COLLECTIONS) {
    if (c.match.test(pid)) return { id: c.id, region: c.region, lesion: c.lesion };
  }
  return undefined;
}

/* A short name for the acquisition, matched against SeriesDescription.
   Descriptions are scanner strings, so they are normalised first: underscores and hyphens
   become spaces, otherwise a word boundary never falls between "AX" and "T2" in a name
   like 2D_AX_T2 and every such series goes unlabelled.
   Order matters - the first match wins, so specific rules precede general ones. When
   nothing matches, the raw description is kept rather than a label being invented. */
const SEQUENCE_RULES = [
  [/gated|\d+(\.\d+)?\s*%/i, 'Respiratory-gated phase'],
  [/\b(3 plane|localizer|scout|topogram|ssfse|loc)\b/i, 'Localizer'],
  [/uncorrected|\bnac\b/i, 'PET, not attenuation corrected'],
  [/\bpet\b.*\bwb\b|whole\s*body/i, 'PET whole body'],
  [/attenuation|\bctac\b/i, 'Attenuation corrected'],
  [/flair/i, 'FLAIR'],
  [/\badc\b/i, 'ADC map'],
  [/\b(dti|dwi|diffusion|advdiff|bval)\b/i, 'Diffusion'],
  [/\b(perf|bolus|perfusion)\b/i, 'Perfusion'],
  [/\bswi\b|susceptibility/i, 'Susceptibility'],
  [/\bt1\b.*(post|gad|contrast)|post.*\bt1\b/i, 'T1 post-contrast'],
  [/\bt1\b/i, 'T1'],
  [/\bt2\b/i, 'T2'],
  [/\bvolser\b|\bser\b|\bpe\d\b|parametric/i, 'Parametric map'],
  /* 6DYN and similar: a digit runs straight into the word, so \b never falls before it. */
  [/\d*dyn\b|dynamic|\bdce\b|vibrant/i, 'Dynamic contrast'],
  [/\btomo\b|\bdbt\b/i, 'Tomosynthesis'],
  [/\bmlo\b/i, 'Mammogram MLO'],
  [/\bcc\b.*\b(mammo|breast|view)\b|\b(mammo|breast)\b.*\bcc\b/i, 'Mammogram CC'],
  [/3 phase|triphasic/i, 'Multiphase contrast'],
  [/arterial/i, 'Arterial phase'],
  [/venous|portal/i, 'Venous phase'],
  [/delay/i, 'Delayed phase'],
  [/runoff|angio/i, 'CT angiography'],
  [/\blung\b/i, 'Lung kernel'],
  [/\bbone\b/i, 'Bone kernel'],
  [/standard|\bsoft\b/i, 'Soft-tissue kernel'],
  [/a\/p\b|abdomen|pelvi/i, 'Abdomen and pelvis'],
  [/helical|spiral|recon|\bchest\b|\babd\b/i, 'Routine reconstruction'],
];

/* NLST series descriptions are comma-separated acquisition parameters such as
   "1,OPA,PH,MX8000,C,332,3.2,120,45,36,1.2". They carry no readable name, and every NLST
   scan is the same study type, so they are named for what they are. */
const PARAMETER_STRING = /^[\d.]+(,[^,]*){6,}$/;

function sequenceLabel(description, modality) {
  const raw = (description || '').trim();
  if (!raw) return modality + ' series';
  if (PARAMETER_STRING.test(raw)) return 'Low-dose CT';
  const d = raw.replace(/[_\-]+/g, ' ');
  for (const rule of SEQUENCE_RULES) {
    if (rule[0].test(d)) return rule[1];
  }
  return raw.length > 44 ? raw.slice(0, 42) + '...' : raw;
}

/* Series holding annotations or presentation state rather than viewable pixels. */
const NON_IMAGE = new Set([
  'SEG', 'SR', 'PR', 'KO', 'RTSTRUCT', 'RTPLAN', 'RTDOSE', 'REG', 'SC',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function qido(path, attempt = 0) {
  try {
    const res = await fetch(ROOT + path, {
      headers: { Accept: 'application/dicom+json' },
      signal: AbortSignal.timeout(120000),
    });
    if (res.status === 204) return [];
    if (!res.ok) throw new Error('http ' + res.status);
    return await res.json();
  } catch (err) {
    if (attempt < 2) {
      await sleep(1500 * (attempt + 1));
      return qido(path, attempt + 1);
    }
    throw err;
  }
}

function val(o, tag) {
  const v = o && o[tag] && o[tag].Value;
  if (!v || v.length === 0) return '';
  const x = v[0];
  if (x && typeof x === 'object') return x.Alphabetic || '';
  return String(x);
}

async function main() {
  console.log(
    'crawling ' + PAGES + ' pages of ' + PAGE_SIZE +
      ', keeping up to ' + PER_COLLECTION + ' studies per collection'
  );

  /* Offsets are spread across the archive rather than walked from zero: the first tens of
     thousands of studies are overwhelmingly NLST, and an even spread is what finds the
     smaller collections the picker actually needs. */
  const SPAN = 133000;
  const picked = new Map();
  let seenStudies = 0;

  for (let p = 0; p < PAGES; p += 1) {
    const offset = Math.round((p / PAGES) * SPAN);
    let rows;
    try {
      rows = await qido('/studies?limit=' + PAGE_SIZE + '&offset=' + offset + '&includefield=all');
    } catch (err) {
      console.warn('  page ' + p + ' (offset ' + offset + ') failed: ' + err.message);
      continue;
    }
    seenStudies += rows.length;

    for (const r of rows) {
      const patientId = val(r, '00100020');
      const cls = classify(patientId);
      if (!cls) continue;
      const bucket = picked.get(cls.id) || [];
      if (bucket.length >= PER_COLLECTION) continue;
      bucket.push({
        collection: cls.id,
        region: cls.region,
        lesion: cls.lesion,
        patientId,
        studyUID: val(r, '0020000D'),
        studyDate: val(r, '00080020'),
        studyDescription: val(r, '00081030'),
      });
      picked.set(cls.id, bucket);
    }

    if (p % 10 === 0) {
      let total = 0;
      for (const b of picked.values()) total += b.length;
      console.log(
        '  page ' + p + '/' + PAGES + ' offset ' + offset +
          '  seen ' + seenStudies + '  kept ' + total + ' in ' + picked.size + ' collections'
      );
    }
  }

  const candidates = [];
  for (const b of picked.values()) for (const s of b) candidates.push(s);
  console.log('\nresolving series for ' + candidates.length + ' studies');

  const entries = [];
  let done = 0;
  for (const c of candidates) {
    done += 1;
    let series;
    try {
      series = await qido('/studies/' + c.studyUID + '/series?includefield=all');
    } catch (err) {
      console.warn('  series failed for ' + c.patientId + ': ' + err.message);
      continue;
    }

    const imageSeries = series
      .map((s) => ({
        seriesUID: val(s, '0020000E'),
        modality: val(s, '00080060'),
        description: val(s, '0008103E'),
      }))
      .filter((s) => s.seriesUID && s.modality && !NON_IMAGE.has(s.modality));

    /* Counting instances is the only way this server will say how long a series is, so it
       happens here, offline, rather than letting the browser discover duds. */
    for (const s of imageSeries.slice(0, 4)) {
      let count = 0;
      try {
        const inst = await qido(
          '/studies/' + c.studyUID + '/series/' + s.seriesUID + '/instances'
        );
        count = inst.length;
      } catch {
        continue;
      }
      if (count < minInstances(s.modality)) continue;
      /* The server caps an unfiltered /instances query at 1000, so a count on that
         boundary is a floor, not a measurement. */
      const capped = count >= 1000;
      entries.push({
        collection: c.collection,
        modality: s.modality,
        region: c.region,
        lesion: c.lesion,
        sequence: sequenceLabel(s.description, s.modality),
        rawDescription: s.description,
        patientId: c.patientId,
        studyDate: c.studyDate,
        studyUID: c.studyUID,
        seriesUID: s.seriesUID,
        instances: count,
        instancesCapped: capped,
      });
    }

    if (done % 10 === 0) {
      console.log(
        '  ' + done + '/' + candidates.length + ' studies, ' + entries.length + ' series kept'
      );
    }
  }

  entries.sort(
    (a, b) =>
      a.modality.localeCompare(b.modality) ||
      a.region.localeCompare(b.region) ||
      a.lesion.localeCompare(b.lesion) ||
      b.instances - a.instances
  );

  const catalog = {
    generated: new Date().toISOString().slice(0, 10),
    sourceId: 'idc',
    note:
      'Lesion labels describe the enrolment criterion of the source collection, not a ' +
      'per-image diagnosis read off these pixels.',
    counts: {
      studiesSeen: seenStudies,
      studiesKept: candidates.length,
      series: entries.length,
      collections: picked.size,
    },
    entries,
  };

  await writeFile(OUT, JSON.stringify(catalog, null, 1), 'utf8');
  console.log('\nwrote ' + OUT);
  console.log('  ' + entries.length + ' series across ' + picked.size + ' collections');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
