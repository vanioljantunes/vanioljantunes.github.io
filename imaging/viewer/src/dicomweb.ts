/* A small DICOMweb client: QIDO-RS to find things, WADO-RS metadata to describe them.
 *
 * Pixels are not fetched here. Cornerstone's wadors image loader does that, given an
 * imageId and the instance metadata registered against it.
 *
 * Everything a DICOMweb server returns is "DICOM JSON": an object keyed by the eight
 * hex digits of the DICOM tag, each value `{ vr, Value: [...] }`, with the key absent
 * rather than null when the server has no value. The readers below exist so the rest of
 * the viewer never has to think about that shape.
 */

import type { Source } from './sources';

/* Tags the viewer reads, by name, so call sites stay legible. */
export const TAG = {
  SpecificCharacterSet: '00080005',
  SOPClassUID: '00080016',
  SOPInstanceUID: '00080018',
  StudyDate: '00080020',
  SeriesDate: '00080021',
  StudyTime: '00080030',
  AccessionNumber: '00080050',
  Modality: '00080060',
  ModalitiesInStudy: '00080061',
  Manufacturer: '00080070',
  InstitutionName: '00080080',
  StudyDescription: '00081030',
  SeriesDescription: '0008103E',
  PatientName: '00100010',
  PatientID: '00100020',
  PatientBirthDate: '00100030',
  PatientSex: '00100040',
  BodyPartExamined: '00180015',
  ScanningSequence: '00180020',
  SequenceVariant: '00180021',
  SliceThickness: '00180050',
  KVP: '00180060',
  ContrastBolusAgent: '00180010',
  RepetitionTime: '00180080',
  EchoTime: '00180081',
  MagneticFieldStrength: '00180087',
  ProtocolName: '00181030',
  ConvolutionKernel: '00181210',
  TransducerData: '00185010',
  ViewPosition: '00185101',
  Units: '00541001',
  Radiopharmaceutical: '00180031',
  StudyInstanceUID: '0020000D',
  SeriesInstanceUID: '0020000E',
  StudyID: '00200010',
  SeriesNumber: '00200011',
  InstanceNumber: '00200013',
  ImagePositionPatient: '00200032',
  ImageOrientationPatient: '00200037',
  FrameOfReferenceUID: '00200052',
  NumberOfStudyRelatedSeries: '00201206',
  NumberOfStudyRelatedInstances: '00201208',
  NumberOfSeriesRelatedInstances: '00201209',
  SamplesPerPixel: '00280002',
  PhotometricInterpretation: '00280004',
  NumberOfFrames: '00280008',
  Rows: '00280010',
  Columns: '00280011',
  PixelSpacing: '00280030',
  BitsAllocated: '00280100',
  BitsStored: '00280101',
  PixelRepresentation: '00280103',
  WindowCenter: '00281050',
  WindowWidth: '00281051',
  RescaleIntercept: '00281052',
  RescaleSlope: '00281053',
} as const;

/* A DICOM JSON element. PN values arrive as objects, everything else as primitives. */
interface Element {
  vr?: string;
  Value?: unknown[];
  BulkDataURI?: string;
  InlineBinary?: string;
}

export type Dataset = Record<string, Element | undefined>;

/* ---------- reading DICOM JSON ---------- */

export function firstValue(ds: Dataset | undefined, tag: string): unknown {
  const values = ds?.[tag]?.Value;
  if (!values || values.length === 0) return undefined;
  return values[0];
}

/** A string element, or '' when the server sent nothing. PN values yield the alphabetic form. */
export function str(ds: Dataset | undefined, tag: string): string {
  const v = firstValue(ds, tag);
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') {
    const alphabetic = (v as { Alphabetic?: unknown }).Alphabetic;
    return typeof alphabetic === 'string' ? alphabetic : '';
  }
  return String(v);
}

/** A numeric element. DICOM IS and DS arrive as strings about as often as numbers. */
export function num(ds: Dataset | undefined, tag: string): number | undefined {
  const v = firstValue(ds, tag);
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Every value of a multi-valued numeric element, such as PixelSpacing. */
export function nums(ds: Dataset | undefined, tag: string): number[] {
  const values = ds?.[tag]?.Value;
  if (!values) return [];
  const out: number[] = [];
  for (const v of values) {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Every value of a multi-valued string element, such as ModalitiesInStudy. */
export function strs(ds: Dataset | undefined, tag: string): string[] {
  const values = ds?.[tag]?.Value;
  if (!values) return [];
  const out: string[] = [];
  for (const v of values) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') {
      const alphabetic = (v as { Alphabetic?: unknown }).Alphabetic;
      if (typeof alphabetic === 'string' && alphabetic !== '') out.push(alphabetic);
      continue;
    }
    const s = String(v);
    if (s !== '') out.push(s);
  }
  return out;
}

/** DICOM DA is YYYYMMDD. Returns an ISO date, or '' if the value is absent or impossible. */
export function isoDate(ds: Dataset | undefined, tag: string): string {
  const raw = str(ds, tag).trim();
  if (!/^\d{8}$/.test(raw)) return '';
  const year = raw.slice(0, 4);
  const month = raw.slice(4, 6);
  const day = raw.slice(6, 8);
  const iso = `${year}-${month}-${day}`;
  /* Date() would roll 20001301 over into 2001-01-01, so check the parts came back intact. */
  const probe = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(probe.getTime())) return '';
  const sameMonth = probe.getUTCMonth() + 1 === Number(month);
  const sameDay = probe.getUTCDate() === Number(day);
  return sameMonth && sameDay ? iso : '';
}

/** A person name, "Family^Given" in DICOM, shown the way a reader expects it. */
export function personName(ds: Dataset | undefined, tag: string): string {
  const raw = str(ds, tag).trim();
  if (!raw) return '';
  const [family = '', given = ''] = raw.split('^');
  const joined = `${given} ${family}`.trim();
  return joined || raw;
}

/* ---------- requests ---------- */

export class DicomWebError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = 'DicomWebError';
    this.status = status;
    this.url = url;
  }
}

function trimRoot(root: string): string {
  return root.replace(/\/+$/, '');
}

async function getJson(url: string, signal?: AbortSignal): Promise<Dataset[]> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/dicom+json' },
      ...(signal ? { signal } : {}),
    });
  } catch {
    /* fetch rejects on DNS failure, connection refused and CORS denial alike, and the
       browser deliberately does not say which. All three mean the same thing here. */
    throw new DicomWebError(
      'could not reach the server - it may be offline, or may not allow this site',
      0,
      url
    );
  }
  /* QIDO answers 204 when a search matched nothing, and a 204 body is not JSON. */
  if (response.status === 204) return [];
  if (!response.ok) {
    throw new DicomWebError(`server answered ${response.status}`, response.status, url);
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new DicomWebError('expected a DICOM JSON array', response.status, url);
  }
  return body as Dataset[];
}

export interface StudyQuery {
  patientId?: string;
  modality?: string;
  studyDate?: string;
  limit?: number;
}

/** QIDO-RS study search. */
export async function searchStudies(
  source: Source,
  query: StudyQuery = {},
  signal?: AbortSignal
): Promise<Dataset[]> {
  const params = new URLSearchParams();
  if (query.patientId) params.set('PatientID', query.patientId);
  if (query.modality) params.set('ModalitiesInStudy', query.modality);
  if (query.studyDate) params.set('StudyDate', query.studyDate);
  params.set('limit', String(query.limit ?? 50));
  /* Without this, some servers return only the study UID and nothing worth listing. */
  if (source.needsIncludeField) params.set('includefield', 'all');
  return getJson(`${trimRoot(source.root)}/studies?${params.toString()}`, signal);
}

/** QIDO-RS series list for one study. */
export async function searchSeries(
  source: Source,
  studyInstanceUID: string,
  signal?: AbortSignal
): Promise<Dataset[]> {
  const params = new URLSearchParams();
  if (source.needsIncludeField) params.set('includefield', 'all');
  const qs = params.toString();
  const url =
    `${trimRoot(source.root)}/studies/${studyInstanceUID}/series` + (qs ? `?${qs}` : '');
  return getJson(url, signal);
}

/** WADO-RS series metadata: one dataset per instance, everything except the pixels. */
export async function seriesMetadata(
  source: Source,
  studyInstanceUID: string,
  seriesInstanceUID: string,
  signal?: AbortSignal
): Promise<Dataset[]> {
  const url =
    `${trimRoot(source.root)}/studies/${studyInstanceUID}` +
    `/series/${seriesInstanceUID}/metadata`;
  return getJson(url, signal);
}

/** Cheap reachability check, so a dead source can be labelled instead of hanging the UI. */
export async function probe(source: Source, timeoutMs = 12000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await searchStudies(source, { limit: 1 }, controller.signal);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- image ids ---------- */

/* Cornerstone's wadors loader takes a frame URL prefixed with its scheme. Frames are
   numbered from 1, and a single-frame instance still has frame 1. */
export function frameImageId(
  root: string,
  studyInstanceUID: string,
  seriesInstanceUID: string,
  sopInstanceUID: string,
  frame = 1
): string {
  return (
    `wadors:${trimRoot(root)}/studies/${studyInstanceUID}` +
    `/series/${seriesInstanceUID}/instances/${sopInstanceUID}/frames/${frame}`
  );
}

/** Dot product, for projecting a slice position onto the stack axis. */
function dot(a: readonly number[], b: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    total += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return total;
}

/** Cross product of the row and column direction cosines, giving the slice normal. */
function sliceNormal(orientation: readonly number[]): [number, number, number] | undefined {
  if (orientation.length < 6) return undefined;
  const [rx = 0, ry = 0, rz = 0, cx = 0, cy = 0, cz = 0] = orientation;
  return [ry * cz - rz * cy, rz * cx - rx * cz, rx * cy - ry * cx];
}

export interface SeriesStack {
  imageIds: string[];
  /* Instance datasets in the same order as imageIds, for the overlay and for MPR checks. */
  instances: Dataset[];
  /* False when slice spacing is uneven or geometry is missing, which rules out MPR. */
  uniformGeometry: boolean;
}

/* Instances come back from WADO-RS in whatever order the server likes, so they are sorted
   along the slice normal. That is the only ordering that stays correct for an oblique
   series; InstanceNumber is the fallback for series carrying no position at all. */
export function buildStack(
  root: string,
  studyInstanceUID: string,
  seriesInstanceUID: string,
  instances: Dataset[]
): SeriesStack {
  const normal = sliceNormal(nums(instances[0], TAG.ImageOrientationPatient));

  const decorated = instances.map((ds, index) => {
    const position = nums(ds, TAG.ImagePositionPatient);
    const along =
      normal && position.length >= 3
        ? dot(position, normal)
        : (num(ds, TAG.InstanceNumber) ?? index);
    return { ds, along, index };
  });

  const positioned =
    normal !== undefined &&
    decorated.every((d) => nums(d.ds, TAG.ImagePositionPatient).length >= 3);

  if (positioned) {
    /* Ties keep their original order, so duplicate positions do not shuffle. */
    decorated.sort((a, b) => a.along - b.along || a.index - b.index);
  } else {
    decorated.sort(
      (a, b) =>
        (num(a.ds, TAG.InstanceNumber) ?? a.index) -
        (num(b.ds, TAG.InstanceNumber) ?? b.index)
    );
  }

  const imageIds: string[] = [];
  const ordered: Dataset[] = [];
  for (const { ds } of decorated) {
    const sop = str(ds, TAG.SOPInstanceUID);
    if (!sop) continue;
    const frames = num(ds, TAG.NumberOfFrames) ?? 1;
    for (let frame = 1; frame <= frames; frame += 1) {
      imageIds.push(frameImageId(root, studyInstanceUID, seriesInstanceUID, sop, frame));
      ordered.push(ds);
    }
  }

  return {
    imageIds,
    instances: ordered,
    uniformGeometry: positioned && hasEvenSpacing(decorated.map((d) => d.along)),
  };
}

/* A volume can only be reconstructed from evenly spaced slices. One percent of the mean
   gap is tight enough to catch a gapped or gantry-tilted series, loose enough to accept
   the rounding that real scanners leave in ImagePositionPatient. */
function hasEvenSpacing(positions: number[]): boolean {
  if (positions.length < 3) return false;
  const gaps: number[] = [];
  for (let i = 1; i < positions.length; i += 1) {
    gaps.push((positions[i] ?? 0) - (positions[i - 1] ?? 0));
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (Math.abs(mean) < 1e-6) return false;
  return gaps.every((g) => Math.abs(g - mean) <= Math.abs(mean) * 0.01);
}
