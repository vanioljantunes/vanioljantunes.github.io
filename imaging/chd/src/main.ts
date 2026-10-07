/* Page entry point for the congenital heart CT project.
 *
 * One case, held here rather than streamed from an archive: a paediatric cardiac CT of a
 * tetralogy of Fallot, with the seven cardiac structures outlined by the radiologists who
 * published the dataset. The viewer pages browse a catalogue; this page argues a case, so it
 * opens on one series and spends its controls on the anatomy instead of on picking.
 *
 * The files are plain DICOM on this site, read through `wadouri:`, so the same engine that
 * streams the archive works unchanged against static files.
 */

import { Enums, type Types } from '@cornerstonejs/core';

import {
  applyPreset,
  initCornerstone,
  mountStackViewport,
  observeElementSize,
  presetsFor,
  readWindow,
  waitForElementSize,
  type Preset,
} from '../../viewer/src/viewport';
import {
  canvasPointToImage,
  hitTest,
  masksForSlice,
  paintMask,
  type SegCase,
  type SegmentInfo,
  type SliceMasks,
} from '../../viewer/src/segmentation';
import { prefetchStack } from '../../viewer/src/prefetch';

const CASE_DIR = '/imaging/chd/tof-1046';
const VIEWPORT_ID = 'chd-viewport';

interface CaseData extends SegCase {
  /* The masks are keyed by SOP Instance UID and only exist where something was drawn, so the
     series order cannot be recovered from them. The converter writes it out separately. */
  sops: string[];
}

const state: {
  viewport?: Types.IStackViewport;
  data?: CaseData;
  imageIds: string[];
  masks?: SliceMasks;
  sliceSop?: string;
  identifying: boolean;
} = { imageIds: [], identifying: false };

const el = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

function text(id: string, value: string): void {
  const node = el(id);
  if (node) node.textContent = value;
}

function status(message: string, kind: 'loading' | 'done' | 'error'): void {
  const node = el('dv-status');
  if (!node) return;
  node.textContent = message;
  node.dataset.kind = kind;
  node.hidden = kind === 'done';
}

/* ---------- what each structure is ---------- */

/* Written for the seven structures this dataset outlines. Each says what the thing is and
   how it reads on a contrast CT, not what is wrong with it: the outlines name anatomy, and
   turning them into a diagnosis would be a claim nobody in the dataset made. */
const EXPLANATIONS: Record<string, string> = {
  'Left ventricle':
    'The chamber that drives blood into the aorta, and the thickest-walled of the four. ' +
    'On a contrast study its cavity fills brightly, which is what separates the blood pool ' +
    'from the muscle around it.',
  'Right ventricle':
    'The chamber that sends blood to the lungs. It sits in front, immediately behind the ' +
    'sternum, and its wall is normally far thinner than the left. In a tetralogy it is the ' +
    'chamber under strain, because the route out of it towards the lungs is narrowed.',
  'Left atrium':
    'The chamber receiving blood back from the lungs, lying behind the others and against ' +
    'the oesophagus. Its four pulmonary veins enter at the corners.',
  'Right atrium':
    'The chamber receiving blood returning from the body through the venae cavae. It lies ' +
    'to the patient’s right, which is the left of the image.',
  Myocardium:
    'The heart muscle itself, as opposed to the blood inside it. It takes up contrast ' +
    'faintly and late, so on an arterial study it reads darker than the chambers it ' +
    'surrounds.',
  Aorta:
    'The vessel carrying blood from the left ventricle to the body: root, ascending, arch, ' +
    'then descending beside the spine. In a tetralogy it is displaced so that it sits over ' +
    'the defect between the ventricles rather than over the left alone.',
  'Pulmonary artery':
    'The vessel carrying blood to the lungs, dividing into left and right branches under ' +
    'the arch. A tetralogy narrows this route, which is what forces the right ventricle to ' +
    'work against a resistance it was not built for.',
};

function explain(segment: SegmentInfo): string {
  return (
    EXPLANATIONS[segment.label] ??
    'This structure is named by the published outlines; no description has been written for ' +
      'it yet.'
  );
}

/* ---------- overlay and controls ---------- */

function paintOverlay(): void {
  const { viewport, imageIds } = state;
  if (!viewport) return;
  const index = viewport.getCurrentImageIdIndex();
  text('dv-slice', `${index + 1} / ${imageIds.length}`);

  const window = readWindow(viewport);
  if (window) text('dv-window', `C ${Math.round(window.center)} / W ${Math.round(window.width)}`);

  const zoom = viewport.getZoom();
  text('dv-zoom', Number.isFinite(zoom) ? `${(zoom * 100).toFixed(0)}%` : '-');
}

/* The standard soft-tissue window is wrong for this study. It is an angiogram: the blood
   pool sits around 600 HU, so a window centred on 40 drives every opacified chamber to pure
   white and the anatomy with it. This one is centred where the contrast actually is, and it
   is what the page opens on; the ordinary presets follow it for comparison. */
const HEART: Preset = { id: 'heart', label: 'Heart', kind: 'hu', center: 200, width: 700 };

function pagePresets(): readonly Preset[] {
  return [HEART, ...(presetsFor('CT') as readonly Preset[])];
}

function buildPresets(viewport: Types.IStackViewport): void {
  const host = el('dv-presets');
  if (!host) return;
  host.replaceChildren();
  for (const preset of pagePresets()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dv-chip';
    button.textContent = preset.label;
    button.addEventListener('click', () => {
      applyPreset(viewport, preset);
      paintOverlay();
    });
    host.append(button);
  }
}

/* ---------- the identify tool ---------- */

function segCanvas(): HTMLCanvasElement | null {
  const canvas = el<HTMLCanvasElement>('dv-seg-canvas');
  const stage = el<HTMLDivElement>('dv-stage');
  if (!canvas || !stage) return null;
  const rect = stage.getBoundingClientRect();
  if (canvas.width !== Math.round(rect.width) || canvas.height !== Math.round(rect.height)) {
    canvas.width = Math.round(rect.width);
    canvas.height = Math.round(rect.height);
  }
  return canvas;
}

function clearOverlayPaint(): void {
  const canvas = segCanvas();
  const ctx = canvas ? canvas.getContext('2d') : null;
  if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

/* Masks belong to one slice, so they are reloaded whenever the slice changes. */
function refreshMasks(): void {
  const { viewport, data } = state;
  if (!viewport || !data) return;
  const sop = data.sops[viewport.getCurrentImageIdIndex()];
  if (!sop || sop === state.sliceSop) return;
  state.sliceSop = sop;
  state.masks = masksForSlice(data, sop);
  clearOverlayPaint();

  const count = Object.keys(state.masks).length;
  text(
    'dv-seg-hint',
    count
      ? `${count} structure${count > 1 ? 's' : ''} outlined on this slice`
      : 'Nothing is outlined on this slice; scroll to find one'
  );
}

function showIdle(): void {
  const panel = el('dv-seg-panel');
  const body = el('dv-seg-body');
  const { data } = state;
  if (!panel || !body || !data) return;
  panel.hidden = false;
  body.replaceChildren();

  const how = document.createElement('p');
  how.textContent =
    'Press Identify, then drag a box round a structure in the image and it is named here.';

  const heading = document.createElement('h3');
  heading.textContent = 'Outlined in this study';

  const list = document.createElement('ul');
  list.className = 'dv-seg-list';
  for (const segment of data.segments) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = segment.label;
    item.append(name);
    list.append(item);
  }
  body.append(how, heading, list);
}

function showPanel(hits: ReturnType<typeof hitTest>): void {
  const panel = el('dv-seg-panel');
  const body = el('dv-seg-body');
  if (!panel || !body) return;
  panel.hidden = false;
  body.replaceChildren();

  const best = hits[0];
  if (!best) {
    const none = document.createElement('p');
    none.className = 'dv-seg-none';
    none.textContent =
      'Nothing outlined inside that box. Only the seven published structures can be ' +
      'identified, so an unmarked area returns nothing.';
    body.append(none);
    clearOverlayPaint();
    return;
  }

  const heading = document.createElement('h3');
  heading.textContent = best.segment.label;

  const what = document.createElement('p');
  what.textContent = explain(best.segment);
  body.append(heading, what);

  if (hits.length > 1) {
    const also = document.createElement('p');
    also.className = 'dv-seg-also';
    also.textContent =
      'Also in the box: ' + hits.slice(1).map((h) => h.segment.label).join(', ') + '.';
    body.append(also);
  }

  const source = document.createElement('p');
  source.className = 'dv-seg-source';
  source.textContent =
    'Outline from the published segmentation of this study, not drawn by this page.';
  body.append(source);

  const { viewport, data, masks } = state;
  const canvas = segCanvas();
  if (viewport && data && masks && canvas) {
    const mask = masks[String(best.segment.number)];
    const imageId = state.imageIds[viewport.getCurrentImageIdIndex()];
    if (mask && imageId) {
      paintMask(canvas, viewport, imageId, mask, data.case.rows, data.case.cols, 'normal');
    }
  }
}

function wireIdentify(): void {
  const layer = el<HTMLDivElement>('dv-seg-layer');
  const rubber = el<HTMLDivElement>('dv-seg-box');
  const button = el<HTMLButtonElement>('dv-identify');
  if (!layer || !rubber || !button) return;

  button.addEventListener('click', () => {
    state.identifying = !state.identifying;
    button.setAttribute('aria-pressed', String(state.identifying));
    button.classList.toggle('dv-chip--on', state.identifying);
    layer.hidden = !state.identifying;
    if (!state.identifying) {
      clearOverlayPaint();
      showIdle();
    }
  });

  let start: [number, number] | null = null;

  layer.addEventListener('pointerdown', (event) => {
    const rect = layer.getBoundingClientRect();
    start = [event.clientX - rect.left, event.clientY - rect.top];
    rubber.hidden = false;
    rubber.style.left = `${start[0]}px`;
    rubber.style.top = `${start[1]}px`;
    rubber.style.width = '0px';
    rubber.style.height = '0px';
    layer.setPointerCapture(event.pointerId);
  });

  layer.addEventListener('pointermove', (event) => {
    if (!start) return;
    const rect = layer.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    rubber.style.left = `${Math.min(start[0], x)}px`;
    rubber.style.top = `${Math.min(start[1], y)}px`;
    rubber.style.width = `${Math.abs(x - start[0])}px`;
    rubber.style.height = `${Math.abs(y - start[1])}px`;
  });

  layer.addEventListener('pointerup', (event) => {
    if (!start) return;
    const rect = layer.getBoundingClientRect();
    const end: [number, number] = [event.clientX - rect.left, event.clientY - rect.top];
    rubber.hidden = true;
    const from = start;
    start = null;

    const { viewport, data, masks } = state;
    if (!viewport || !data || !masks) return;
    const imageId = state.imageIds[viewport.getCurrentImageIdIndex()];
    if (!imageId) return;

    const a = canvasPointToImage(viewport, imageId, from);
    const b = canvasPointToImage(viewport, imageId, end);
    /* A box the engine cannot place still has to answer, or the panel keeps the previous
       structure and reads as though it described this one. */
    if (!a || !b) {
      showPanel([]);
      return;
    }
    const pad = Math.abs(b[0] - a[0]) < 3 && Math.abs(b[1] - a[1]) < 3 ? 4 : 0;

    showPanel(
      hitTest(
        masks,
        data.segments,
        { x0: a[0] - pad, y0: a[1] - pad, x1: b[0] + pad, y1: b[1] + pad },
        data.case.rows,
        data.case.cols
      )
    );
    el('dv-stage')?.focus({ preventScroll: true });
  });
}

/* ---------- start ---------- */

async function start(): Promise<void> {
  const stage = el<HTMLDivElement>('dv-stage');
  if (!stage) return;

  status('Reading the study…', 'loading');
  let data: CaseData;
  try {
    const response = await fetch(`${CASE_DIR}/segmentation.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = (await response.json()) as CaseData;
  } catch (err) {
    console.error(err);
    status('The study could not be read. Reload the page.', 'error');
    return;
  }

  state.data = data;
  state.imageIds = data.sops.map(
    (_sop, n) => `wadouri:${CASE_DIR}/dicom/${String(n + 1).padStart(4, '0')}.dcm`
  );

  await initCornerstone();
  await waitForElementSize(stage);
  observeElementSize(stage);

  const viewport = mountStackViewport(stage, VIEWPORT_ID);
  state.viewport = viewport;

  const middle = Math.floor(state.imageIds.length / 2);
  await viewport.setStack(state.imageIds, middle);

  buildPresets(viewport);
  applyPreset(viewport, HEART);
  viewport.render();

  stage.addEventListener(Enums.Events.STACK_NEW_IMAGE, () => {
    paintOverlay();
    refreshMasks();
  });
  stage.addEventListener(Enums.Events.CAMERA_MODIFIED, () => {
    paintOverlay();
    clearOverlayPaint();
  });

  el('dv-invert')?.addEventListener('click', () => {
    const current = viewport.getProperties().invert ?? false;
    viewport.setProperties({ invert: !current });
    viewport.render();
  });
  el('dv-reset')?.addEventListener('click', () => {
    viewport.resetCamera();
    applyPreset(viewport, HEART);
    viewport.render();
    paintOverlay();
  });

  wireIdentify();
  paintOverlay();
  refreshMasks();
  showIdle();
  status('', 'done');

  /* The rest of the stack is fetched in the background, outwards from the slice on screen,
     so scrolling does not stall on a request. */
  prefetchStack(state.imageIds, middle, (done, total) => {
    const bar = el('dv-progress-bar');
    if (bar) bar.style.width = `${Math.round((done / total) * 100)}%`;
    const wrap = el('dv-progress');
    if (wrap) wrap.hidden = done >= total;
  });
}

void start();
