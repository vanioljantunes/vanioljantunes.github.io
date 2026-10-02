/* Page entry point for the DICOM viewer.
 *
 * Four cascading pickers choose the study - imaging type, region, finding, sequence - and
 * the chosen series is streamed from the archive into a stack viewport.
 */

import { Enums, type Types } from '@cornerstonejs/core';

import { sourceById, type Source } from './sources';
import { TAG, isoDate, num, personName, str, type Dataset } from './dicomweb';
import {
  loadCatalog,
  lesionChoices,
  modalityChoices,
  reconcile,
  regionChoices,
  resolve,
  sequenceChoices,
  type Catalog,
  type CatalogEntry,
  type Choice,
  type Selection,
} from './catalog';
import {
  PRESETS,
  applyPreset,
  initCornerstone,
  loadSeries,
  mountStackViewport,
  purgeCache,
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
  catalog?: Catalog;
  selection: Selection;
  entry?: CatalogEntry;
  stack?: LoadedSeries;
  viewport?: Types.IStackViewport;
  /* Incremented on every load so a slow fetch cannot overwrite a newer one. */
  loadToken: number;
} = {
  source: sourceById('idc'),
  selection: {},
  loadToken: 0,
};

/* ---------- status ---------- */

function setStatus(message: string, kind: 'info' | 'error' | 'done' = 'info'): void {
  const node = el('dv-status');
  if (!node) return;
  node.textContent = message;
  node.dataset.kind = kind;
  node.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/* ---------- overlay ---------- */

function text(id: string, value: string): void {
  const node = el(id);
  if (node) node.textContent = value;
}

/* The corner readout a workstation shows. An absent tag renders as a dash rather than an
   empty gap, so it stays clear the field exists and the server simply did not fill it. */
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

/* ---------- the four pickers ---------- */

const PICKERS = [
  { id: 'dv-pick-modality', key: 'modality' as const },
  { id: 'dv-pick-region', key: 'region' as const },
  { id: 'dv-pick-lesion', key: 'lesion' as const },
  { id: 'dv-pick-sequence', key: 'sequence' as const },
];

function fillSelect(select: HTMLSelectElement, choices: Choice[], selected?: string): void {
  select.replaceChildren();
  for (const c of choices) {
    const option = document.createElement('option');
    option.value = c.value;
    /* The count tells the reader how much there is behind a choice before they commit. */
    option.textContent = c.count > 1 ? `${c.label} (${c.count})` : c.label;
    if (c.value === selected) option.selected = true;
    select.append(option);
  }
  select.disabled = choices.length <= 1;
}

function paintPickers(): void {
  const catalog = state.catalog;
  if (!catalog) return;
  const sel = state.selection;
  const entries = catalog.entries;

  const choices: Record<string, Choice[]> = {
    modality: modalityChoices(entries),
    region: regionChoices(entries, sel),
    lesion: lesionChoices(entries, sel),
    sequence: sequenceChoices(entries, sel),
  };

  for (const p of PICKERS) {
    const select = el<HTMLSelectElement>(p.id);
    if (select) fillSelect(select, choices[p.key] ?? [], sel[p.key]);
  }
}

function describeEntry(entry: CatalogEntry): string {
  const count = entry.instancesCapped
    ? `${entry.instances}+ images`
    : `${entry.instances} images`;
  return `${entry.patientId}, ${count}`;
}

async function openSelected(): Promise<void> {
  const { catalog, viewport } = state;
  if (!catalog || !viewport) return;

  const entry = resolve(catalog.entries, state.selection);
  if (!entry) {
    setStatus('No series matches that combination', 'error');
    return;
  }
  state.entry = entry;

  const token = state.loadToken + 1;
  state.loadToken = token;

  setStatus(`Loading ${entry.sequence} - ${describeEntry(entry)}`);
  text('dv-provenance', `${entry.collection} - ${entry.patientId}`);

  try {
    /* A previous series can be hundreds of megabytes of decoded pixels. */
    purgeCache();
    const stack = await loadSeries(state.source, entry.studyUID, entry.seriesUID);
    if (token !== state.loadToken) return; // a newer selection won

    state.stack = stack;
    await showSeries(viewport, stack);
    if (token !== state.loadToken) return;

    paintOverlay();
    setStatus(
      `${entry.lesion}, ${entry.sequence} - ${stack.imageIds.length} images` +
        (stack.uniformGeometry ? ', evenly spaced' : ', spacing uneven'),
      'done'
    );
  } catch (error) {
    if (token !== state.loadToken) return;
    setStatus(`Could not load that series: ${describe(error)}`, 'error');
  }
}

function wirePickers(): void {
  for (const p of PICKERS) {
    const select = el<HTMLSelectElement>(p.id);
    if (!select) continue;
    select.addEventListener('change', () => {
      const catalog = state.catalog;
      if (!catalog) return;
      /* Reconcile before repainting: changing the region can strand the finding below it. */
      state.selection = reconcile(catalog.entries, {
        ...state.selection,
        [p.key]: select.value,
      });
      paintPickers();
      void openSelected();
    });
  }
}

/* ---------- view controls ---------- */

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

  /* Arrow keys page through slices, so the stack is usable without a mouse. */
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

  const credit = el('dv-attribution');
  if (credit) credit.textContent = state.source.attribution ?? '';

  buildPresetButtons();
  wireControls(stage);
  wirePickers();

  setStatus('Starting the renderer');
  try {
    await initCornerstone();
  } catch (error) {
    setStatus(`The renderer would not start: ${describe(error)}`, 'error');
    return;
  }

  const viewport = mountStackViewport(stage, VIEWPORT_ID);
  state.viewport = viewport;

  stage.addEventListener(Enums.Events.STACK_NEW_IMAGE, paintOverlay);
  stage.addEventListener(Enums.Events.VOI_MODIFIED, paintOverlay);
  stage.addEventListener(Enums.Events.CAMERA_MODIFIED, paintOverlay);

  setStatus('Loading the case index');
  try {
    const catalog = await loadCatalog();
    state.catalog = catalog;
    state.selection = reconcile(catalog.entries, {});
    paintPickers();

    const summary = el('dv-catalog-summary');
    if (summary) {
      summary.textContent =
        `${catalog.counts.series} series from ${catalog.counts.collections} ` +
        `collections, indexed ${catalog.generated}.`;
    }
  } catch (error) {
    setStatus(`Could not load the case index: ${describe(error)}`, 'error');
    return;
  }

  await openSelected();
}

void start();
