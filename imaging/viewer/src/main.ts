/* Page entry point for the DICOM viewer.
 *
 * Phase one: open one public series, scroll it, window it. The study list, the series
 * rail, measurements and MPR come next, and the modules it imports are shaped to take them.
 */

import { Enums, type Types } from '@cornerstonejs/core';

import { DEMO, sourceById, type Source } from './sources';
import { TAG, isoDate, num, personName, str, type Dataset } from './dicomweb';
import {
  PRESETS,
  applyPreset,
  initCornerstone,
  loadSeries,
  mountStackViewport,
  readWindow,
  resetViewport,
  showSeries,
  type LoadedSeries,
  type PresetId,
} from './viewport';

const VIEWPORT_ID = 'dv-main';

const el = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

const state: {
  source: Source;
  stack?: LoadedSeries;
  viewport?: Types.IStackViewport;
} = {
  source: sourceById(DEMO.sourceId),
};

/* ---------- status ---------- */

function setStatus(message: string, kind: 'info' | 'error' | 'done' = 'info'): void {
  const node = el('dv-status');
  if (!node) return;
  node.textContent = message;
  node.dataset.kind = kind;
  /* An error is the one case a user may miss, having looked away while a series loaded. */
  node.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ---------- overlay ---------- */

function text(id: string, value: string): void {
  const node = el(id);
  if (node) node.textContent = value;
}

/* The corner readout a workstation shows. Patient and study on the left, geometry and
   display settings on the right. An absent tag renders as a dash rather than an empty
   gap, so it stays clear that the field exists and the server simply did not fill it. */
function paintOverlay(): void {
  const { viewport, stack } = state;
  if (!viewport || !stack) return;

  const index = viewport.getCurrentImageIdIndex();
  const ds: Dataset | undefined = stack.instances[index];
  const dash = (s: string): string => (s === '' ? '-' : s);

  text('dv-patient', dash(personName(ds, TAG.PatientName) || str(ds, TAG.PatientID)));
  text('dv-study', dash(str(ds, TAG.StudyDescription)));
  text('dv-series', dash(str(ds, TAG.SeriesDescription)));
  text('dv-date', dash(isoDate(ds, TAG.StudyDate)));
  text('dv-modality', dash(str(ds, TAG.Modality)));

  text('dv-slice', `${index + 1} / ${stack.imageIds.length}`);

  const thickness = num(ds, TAG.SliceThickness);
  text('dv-thickness', thickness === undefined ? '-' : `${thickness.toFixed(2)} mm`);

  const window = readWindow(viewport);
  text(
    'dv-window',
    window ? `C ${Math.round(window.center)} / W ${Math.round(window.width)}` : '-'
  );

  const zoom = viewport.getZoom();
  text('dv-zoom', Number.isFinite(zoom) ? `${(zoom * 100).toFixed(0)}%` : '-');
}

/* ---------- controls ---------- */

function buildPresetButtons(): void {
  const host = el('dv-presets');
  if (!host) return;
  host.replaceChildren();

  for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dv-chip';
    button.textContent = preset.label;
    button.dataset.preset = preset.id;
    button.title = `Centre ${preset.center}, width ${preset.width} HU`;
    button.addEventListener('click', () => {
      if (!state.viewport) return;
      applyPreset(state.viewport, preset.id as PresetId);
      paintOverlay();
    });
    host.append(button);
  }
}

function wireControls(stage: HTMLDivElement): void {
  el<HTMLButtonElement>('dv-reset')?.addEventListener('click', () => {
    const { viewport, stack } = state;
    if (!viewport || !stack) return;
    resetViewport(viewport, stack.instances[viewport.getCurrentImageIdIndex()]);
    paintOverlay();
  });

  el<HTMLButtonElement>('dv-invert')?.addEventListener('click', () => {
    const { viewport } = state;
    if (!viewport) return;
    viewport.setProperties({ invert: !viewport.getProperties().invert });
    viewport.render();
  });

  /* Arrow keys page through slices. The stage is focusable so this works without a mouse,
     which is the difference between a demo and something a reader can actually drive. */
  stage.addEventListener('keydown', (event) => {
    const { viewport, stack } = state;
    if (!viewport || !stack) return;

    let delta = 0;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') delta = 1;
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') delta = -1;
    if (event.key === 'PageDown') delta = 10;
    if (event.key === 'PageUp') delta = -10;
    if (delta === 0) return;

    event.preventDefault();
    const last = stack.imageIds.length - 1;
    const next = Math.min(last, Math.max(0, viewport.getCurrentImageIdIndex() + delta));
    void viewport.setImageIdIndex(next);
  });
}

/* ---------- start ---------- */

async function start(): Promise<void> {
  const stage = el<HTMLDivElement>('dv-stage');
  if (!stage) return;

  const node = el('dv-attribution');
  if (node) node.textContent = state.source.attribution ?? '';

  buildPresetButtons();
  wireControls(stage);

  setStatus('Starting the renderer');
  try {
    await initCornerstone();
  } catch (error) {
    setStatus(`The renderer would not start: ${describe(error)}`, 'error');
    return;
  }

  const viewport = mountStackViewport(stage, VIEWPORT_ID);
  state.viewport = viewport;

  /* Repaint the readout when the slice, the window or the camera changes, rather than
     polling. VOI_MODIFIED covers the window/level drag, CAMERA_MODIFIED zoom and pan. */
  stage.addEventListener(Enums.Events.STACK_NEW_IMAGE, paintOverlay);
  stage.addEventListener(Enums.Events.VOI_MODIFIED, paintOverlay);
  stage.addEventListener(Enums.Events.CAMERA_MODIFIED, paintOverlay);

  setStatus(`Loading ${DEMO.label}`);
  try {
    const stack = await loadSeries(
      state.source,
      DEMO.studyInstanceUID,
      DEMO.seriesInstanceUID
    );
    state.stack = stack;

    await showSeries(viewport, stack);
    paintOverlay();

    setStatus(
      stack.uniformGeometry
        ? `${stack.imageIds.length} slices, evenly spaced`
        : `${stack.imageIds.length} slices, spacing uneven so volume views stay off`,
      'done'
    );
  } catch (error) {
    setStatus(`Could not load that series: ${describe(error)}`, 'error');
  }
}

void start();
