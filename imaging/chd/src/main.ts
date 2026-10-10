/* Page entry point for the congenital heart CT project.
 *
 * Two studies side by side, held here rather than streamed: a child's cardiac CT with a
 * tetralogy of Fallot, and a second child the dataset records no congenital defect for. Each
 * has the seven cardiac structures outlined by the radiologists who published them, and each
 * can be interrogated on its own with the identify tool.
 *
 * Only the slice is linked. Window, zoom and pan stay independent, because the point of the
 * pair is to compare anatomy at a level, not to force one reading onto both.
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

interface CaseData extends SegCase {
  /* The masks are keyed by SOP Instance UID and only exist where something was drawn, so the
     series order cannot be recovered from them. The converter writes it out separately. */
  sops: string[];
}

interface SideConfig {
  key: string;
  dir: string;
}

const SIDES: SideConfig[] = [
  { key: 'tof', dir: '/imaging/chd/tof-1046' },
  { key: 'ctl', dir: '/imaging/chd/control-1080' },
];

const el = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

function status(message: string, kind: 'loading' | 'done' | 'error'): void {
  const node = el('dv-status');
  if (!node) return;
  node.textContent = message;
  node.dataset.kind = kind;
  node.hidden = kind === 'done';
}

/* ---------- what each structure is ---------- */

/* Written for the seven structures these datasets outline. Each says what the thing is and
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

/* The standard soft-tissue window is wrong for these studies. They are angiograms: the blood
   pool sits around 600 HU, so a window centred on 40 drives every opacified chamber to pure
   white and the anatomy with it. This one is centred where the contrast actually is, and it
   is what each side opens on; the ordinary presets follow it for comparison. */
const HEART: Preset = { id: 'heart', label: 'Heart', kind: 'hu', center: 200, width: 700 };

const pagePresets = (): readonly Preset[] => [HEART, ...(presetsFor('CT') as readonly Preset[])];

/* ---------- one viewer ---------- */

interface Viewer {
  key: string;
  viewport: Types.IStackViewport;
  imageIds: string[];
  /* First and last slice carrying any outline: the heart, as the annotators marked it. */
  extent: [number, number];
  refresh(): void;
}

async function createViewer(config: SideConfig): Promise<Viewer> {
  const id = (suffix: string): string => `${config.key}-${suffix}`;

  const response = await fetch(`${config.dir}/segmentation.json`);
  if (!response.ok) throw new Error(`${config.dir}: HTTP ${response.status}`);
  const data = (await response.json()) as CaseData;

  const imageIds = data.sops.map(
    (_sop, n) => `wadouri:${config.dir}/dicom/${String(n + 1).padStart(4, '0')}.dcm`
  );

  const marked = data.sops.map((sop, n) => (data.slices[sop] ? n : -1)).filter((n) => n >= 0);
  const extent: [number, number] = marked.length
    ? [marked[0] as number, marked[marked.length - 1] as number]
    : [0, imageIds.length - 1];

  const stage = el<HTMLDivElement>(id('stage'));
  if (!stage) throw new Error(`${config.key}: no stage element`);
  await waitForElementSize(stage);
  observeElementSize(stage);

  const viewport = mountStackViewport(stage, `chd-${config.key}`);
  await viewport.setStack(imageIds, Math.floor(imageIds.length / 2));
  applyPreset(viewport, HEART);
  viewport.render();

  let masks: SliceMasks | undefined;
  let sliceSop: string | undefined;
  let identifying = false;

  function text(suffix: string, value: string): void {
    const node = el(id(suffix));
    if (node) node.textContent = value;
  }

  function overlayCanvas(): HTMLCanvasElement | null {
    const canvas = el<HTMLCanvasElement>(id('seg-canvas'));
    if (!canvas) return null;
    const rect = stage.getBoundingClientRect();
    if (canvas.width !== Math.round(rect.width) || canvas.height !== Math.round(rect.height)) {
      canvas.width = Math.round(rect.width);
      canvas.height = Math.round(rect.height);
    }
    return canvas;
  }

  function clearPaint(): void {
    const canvas = overlayCanvas();
    const ctx = canvas ? canvas.getContext('2d') : null;
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function paintReadout(): void {
    const index = viewport.getCurrentImageIdIndex();
    text('slice', `${index + 1} / ${imageIds.length}`);
    const window = readWindow(viewport);
    if (window) text('window', `C ${Math.round(window.center)} / W ${Math.round(window.width)}`);
    const zoom = viewport.getZoom();
    text('zoom', Number.isFinite(zoom) ? `${(zoom * 100).toFixed(0)}%` : '-');
  }

  /* Masks belong to one slice, so they are reloaded whenever the slice changes. */
  function refreshMasks(): void {
    const sop = data.sops[viewport.getCurrentImageIdIndex()];
    if (!sop || sop === sliceSop) return;
    sliceSop = sop;
    masks = masksForSlice(data, sop);
    clearPaint();
    const count = Object.keys(masks).length;
    text(
      'hint',
      count
        ? `${count} structure${count > 1 ? 's' : ''} outlined here`
        : 'Nothing outlined on this slice'
    );
  }

  function showIdle(): void {
    const panel = el(id('panel'));
    const body = el(id('body'));
    if (!panel || !body) return;
    panel.hidden = false;
    body.replaceChildren();

    const how = document.createElement('p');
    how.textContent = 'Press Identify, then drag a box round a structure.';

    const list = document.createElement('ul');
    list.className = 'dv-seg-list';
    for (const segment of data.segments) {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = segment.label;
      item.append(name);
      list.append(item);
    }
    body.append(how, list);
  }

  function showPanel(hits: ReturnType<typeof hitTest>): void {
    const panel = el(id('panel'));
    const body = el(id('body'));
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
      clearPaint();
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
    source.textContent = 'Outline from the published segmentation, not drawn by this page.';
    body.append(source);

    const canvas = overlayCanvas();
    const mask = masks ? masks[String(best.segment.number)] : undefined;
    const imageId = imageIds[viewport.getCurrentImageIdIndex()];
    if (canvas && mask && imageId) {
      paintMask(canvas, viewport, imageId, mask, data.case.rows, data.case.cols, 'normal');
    }
  }

  /* ---------- controls ---------- */

  const presetHost = el(id('presets'));
  if (presetHost) {
    presetHost.replaceChildren();
    for (const preset of pagePresets()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dv-chip';
      button.textContent = preset.label;
      button.addEventListener('click', () => {
        applyPreset(viewport, preset);
        paintReadout();
      });
      presetHost.append(button);
    }
  }

  el(id('invert'))?.addEventListener('click', () => {
    viewport.setProperties({ invert: !(viewport.getProperties().invert ?? false) });
    viewport.render();
  });
  el(id('reset'))?.addEventListener('click', () => {
    viewport.resetCamera();
    applyPreset(viewport, HEART);
    viewport.render();
    paintReadout();
  });

  /* ---------- the identify tool ---------- */

  const layer = el<HTMLDivElement>(id('seg-layer'));
  const rubber = el<HTMLDivElement>(id('seg-box'));
  const identifyButton = el<HTMLButtonElement>(id('identify'));

  if (layer && rubber && identifyButton) {
    identifyButton.addEventListener('click', () => {
      identifying = !identifying;
      identifyButton.setAttribute('aria-pressed', String(identifying));
      identifyButton.classList.toggle('dv-chip--on', identifying);
      layer.hidden = !identifying;
      if (!identifying) {
        clearPaint();
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

      const imageId = imageIds[viewport.getCurrentImageIdIndex()];
      if (!imageId || !masks) return;

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
      stage.focus({ preventScroll: true });
    });
  }

  stage.addEventListener(Enums.Events.CAMERA_MODIFIED, () => {
    paintReadout();
    clearPaint();
  });

  paintReadout();
  refreshMasks();
  showIdle();

  return {
    key: config.key,
    viewport,
    imageIds,
    extent,
    refresh() {
      paintReadout();
      refreshMasks();
    },
  };
}

/* ---------- linking the two ---------- */

/* The two children are different sizes and their scans start and stop at different levels, so
   a slice number means nothing across them. What both studies share is an outlined heart, so
   the link maps proportionally between those two ranges: the top of one heart meets the top of
   the other, the bottom the bottom. Outside the heart the same scale carries on, which keeps
   the movement continuous instead of sticking at the ends. It is an approximation, and the
   page says so rather than implying the two are registered. */
function mapIndex(from: Viewer, to: Viewer, index: number): number {
  const [fromLow, fromHigh] = from.extent;
  const [toLow, toHigh] = to.extent;
  const fromSpan = Math.max(1, fromHigh - fromLow);
  const toSpan = Math.max(1, toHigh - toLow);
  const mapped = toLow + ((index - fromLow) * toSpan) / fromSpan;
  return Math.max(0, Math.min(to.imageIds.length - 1, Math.round(mapped)));
}

function link(viewers: Viewer[]): void {
  let syncing = false;
  for (const viewer of viewers) {
    const stage = el<HTMLDivElement>(`${viewer.key}-stage`);
    if (!stage) continue;
    stage.addEventListener(Enums.Events.STACK_NEW_IMAGE, () => {
      viewer.refresh();
      /* Moving the other viewer fires its own event, which would move this one back. */
      if (syncing) return;
      syncing = true;
      try {
        const index = viewer.viewport.getCurrentImageIdIndex();
        for (const other of viewers) {
          if (other === viewer) continue;
          const target = mapIndex(viewer, other, index);
          if (other.viewport.getCurrentImageIdIndex() !== target) {
            void other.viewport.setImageIdIndex(target);
          }
        }
      } finally {
        syncing = false;
      }
    });
  }
}

/* ---------- start ---------- */

async function start(): Promise<void> {
  status('Reading both studies…', 'loading');

  const viewers: Viewer[] = [];
  try {
    await initCornerstone();
    /* One after the other: both mount into the same engine, and setting the second stack
       while the first is still settling leaves the second sized wrongly. */
    for (const side of SIDES) viewers.push(await createViewer(side));
  } catch (err) {
    console.error(err);
    status('The studies could not be read. Reload the page.', 'error');
    return;
  }

  link(viewers);

  /* Start both at the same level rather than each on its own middle slice. */
  const [first, second] = viewers as [Viewer, Viewer];
  void second.viewport.setImageIdIndex(
    mapIndex(first, second, first.viewport.getCurrentImageIdIndex())
  );

  status('', 'done');

  /* One side is fetched before the other, so the two do not compete for the connection
     while someone is already scrolling the first. */
  const bar = el('dv-progress-bar');
  const wrap = el('dv-progress');
  const total = viewers.reduce((sum, viewer) => sum + viewer.imageIds.length, 0);
  let done = 0;
  const step = (): void => {
    done += 1;
    if (bar) bar.style.width = `${Math.round((done / total) * 100)}%`;
    if (wrap) wrap.hidden = done >= total;
  };

  for (const viewer of viewers) {
    await prefetchStack(viewer.imageIds, viewer.viewport.getCurrentImageIdIndex(), step);
  }
}

void start();
