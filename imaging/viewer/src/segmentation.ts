/* Published segmentations, loaded on demand and hit-tested against a box the reader draws.
 *
 * Nothing is computed here. The masks were extracted offline by scripts/extract-seg.py from
 * DICOM SEG objects the archive already publishes, so what the panel names is what an
 * annotation effort recorded, not something this page decided about the pixels.
 *
 * Masks arrive run-length encoded, row-major, starting with a run of zeros. That decodes far
 * faster than an image would and gzips to a fraction of its size.
 */

import { utilities as csUtils, type Types } from '@cornerstonejs/core';

export interface SegmentInfo {
  number: number;
  label: string;
  kind: 'lesion' | 'normal';
}

export interface IndexEntry {
  file: string;
  caseId: string;
  segments: SegmentInfo[];
}

export interface SegCase {
  case: {
    id: string;
    collection: string;
    region: string;
    lesion: string;
    patientId: string;
    rows: number;
    cols: number;
    sourceSeriesUID?: string;
  };
  segments: SegmentInfo[];
  slices: Record<string, Record<string, number[]>>;
}

const INDEX_URL = '/imaging/viewer/seg/index.json';

let indexPromise: Promise<Record<string, IndexEntry>> | undefined;
const caseCache = new Map<string, Promise<SegCase>>();

/** Which series have a published segmentation. Fetched once, then reused. */
export function loadSegIndex(): Promise<Record<string, IndexEntry>> {
  if (!indexPromise) {
    indexPromise = fetch(INDEX_URL)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return indexPromise;
}

export async function segmentationFor(seriesUID: string): Promise<IndexEntry | undefined> {
  const index = await loadSegIndex();
  return index[seriesUID];
}

export function loadSegCase(entry: IndexEntry): Promise<SegCase> {
  let pending = caseCache.get(entry.file);
  if (!pending) {
    pending = fetch(entry.file).then((r) => {
      if (!r.ok) throw new Error(`segmentation unavailable (${r.status})`);
      return r.json() as Promise<SegCase>;
    });
    caseCache.set(entry.file, pending);
  }
  return pending;
}

/** Expand a run-length encoded mask back into one byte per pixel. */
export function decodeMask(rle: number[], rows: number, cols: number): Uint8Array {
  const out = new Uint8Array(rows * cols);
  let at = 0;
  let value = 0;
  for (const run of rle) {
    if (value) out.fill(1, at, at + run);
    at += run;
    value ^= 1;
  }
  return out;
}

export interface SliceMasks {
  [segmentNumber: string]: Uint8Array;
}

/** Every segment drawn on one source slice, by segment number. */
export function masksForSlice(data: SegCase, sopInstanceUID: string): SliceMasks {
  const encoded = data.slices[sopInstanceUID];
  if (!encoded) return {};
  const out: SliceMasks = {};
  for (const [number, rle] of Object.entries(encoded)) {
    out[number] = decodeMask(rle, data.case.rows, data.case.cols);
  }
  return out;
}

export interface Hit {
  segment: SegmentInfo;
  /** Pixels of this segment inside the box. */
  inside: number;
  /** Share of the box the segment covers, 0 to 1. */
  coverage: number;
}

/**
 * Which segments fall inside a box, best first.
 *
 * A lesion inside the box always ranks above a normal structure, and only then does the
 * share of the box each one fills decide the order. Coverage alone is the wrong rule here:
 * a cyst of a few hundred pixels sitting against a kidney of several thousand can never
 * out-cover the organ, so a box drawn tightly round the cyst would still answer "kidney".
 * The outlines exist to show the lesions, so the lesion is named and the organ is listed
 * after it as also being in the box.
 */
export function hitTest(
  masks: SliceMasks,
  segments: SegmentInfo[],
  box: { x0: number; y0: number; x1: number; y1: number },
  rows: number,
  cols: number
): Hit[] {
  const x0 = Math.max(0, Math.min(box.x0, box.x1));
  const x1 = Math.min(cols - 1, Math.max(box.x0, box.x1));
  const y0 = Math.max(0, Math.min(box.y0, box.y1));
  const y1 = Math.min(rows - 1, Math.max(box.y0, box.y1));
  if (x1 < x0 || y1 < y0) return [];
  const area = Math.max(1, (x1 - x0 + 1) * (y1 - y0 + 1));

  const byNumber = new Map(segments.map((s) => [String(s.number), s]));
  const hits: Hit[] = [];

  for (const [number, mask] of Object.entries(masks)) {
    const segment = byNumber.get(number);
    if (!segment) continue;
    let inside = 0;
    for (let y = y0; y <= y1; y += 1) {
      const row = y * cols;
      for (let x = x0; x <= x1; x += 1) {
        if (mask[row + x]) inside += 1;
      }
    }
    if (inside > 0) hits.push({ segment, inside, coverage: inside / area });
  }

  return hits.sort((a, b) => {
    const kind = Number(b.segment.kind === 'lesion') - Number(a.segment.kind === 'lesion');
    return kind !== 0 ? kind : b.coverage - a.coverage;
  });
}

/* Lesions are drawn warm and normal structures cool, so the two read apart at a glance
   before any text is read. */
export const SEGMENT_COLOURS: Record<string, [number, number, number]> = {
  lesion: [229, 72, 58],
  normal: [56, 150, 240],
};

/**
 * Paint one segment onto a canvas sitting over the image.
 *
 * The mask is drawn at image resolution onto a scratch canvas, then placed using the two
 * corners of the image in canvas space, which keeps it aligned through pan and zoom.
 */
export function paintMask(
  canvas: HTMLCanvasElement,
  viewport: Types.IStackViewport,
  imageId: string,
  mask: Uint8Array,
  rows: number,
  cols: number,
  kind: 'lesion' | 'normal'
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const colour = SEGMENT_COLOURS[kind] ?? SEGMENT_COLOURS['normal'];
  const [r, g, b] = colour as [number, number, number];

  const scratch = document.createElement('canvas');
  scratch.width = cols;
  scratch.height = rows;
  const sctx = scratch.getContext('2d');
  if (!sctx) return;

  const pixels = sctx.createImageData(cols, rows);
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    const edge = !mask[i - 1] || !mask[i + 1] || !mask[i - cols] || !mask[i + cols];
    const o = i * 4;
    pixels.data[o] = r;
    pixels.data[o + 1] = g;
    pixels.data[o + 2] = b;
    /* A solid edge over a translucent interior: the boundary carries the information, and
       the anatomy underneath should stay readable through the fill. */
    pixels.data[o + 3] = edge ? 235 : 90;
  }
  sctx.putImageData(pixels, 0, 0);

  const topLeft = viewport.worldToCanvas(
    csUtils.imageToWorldCoords(imageId, [0, 0]) as Types.Point3
  );
  const bottomRight = viewport.worldToCanvas(
    csUtils.imageToWorldCoords(imageId, [cols, rows]) as Types.Point3
  );
  if (!topLeft || !bottomRight) return;

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    scratch,
    topLeft[0],
    topLeft[1],
    bottomRight[0] - topLeft[0],
    bottomRight[1] - topLeft[1]
  );
}

/** Image pixel coordinates for a point given in canvas space. */
export function canvasPointToImage(
  viewport: Types.IStackViewport,
  imageId: string,
  canvasPoint: [number, number]
): [number, number] | undefined {
  const world = viewport.canvasToWorld(canvasPoint);
  if (!world) return undefined;
  const image = csUtils.worldToImageCoords(imageId, world);
  if (!image) return undefined;
  return [Math.round(image[0]), Math.round(image[1])];
}
