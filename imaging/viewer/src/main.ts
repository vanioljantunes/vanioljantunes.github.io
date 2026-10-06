/* Page entry point for the DICOM viewer.
 *
 * Four cascading pickers choose the study - imaging type, region, finding, sequence - and
 * the chosen series is streamed from the archive into a stack viewport.
 */

import { Enums, type Types } from '@cornerstonejs/core';

import { sourceById, type Source } from './sources';
import { TAG, isoDate, num, personName, str, type Dataset } from './dicomweb';
import {
  assignIds,
  caseChoices,
  modalityGroup,
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
import { prefetchStack, type PrefetchHandle } from './prefetch';
import { pageModality, profileFor, type ModalityProfile } from './modality';
import {
  canvasPointToImage,
  hitTest,
  loadSegCase,
  masksForSlice,
  paintMask,
  segmentationFor,
  type IndexEntry,
  type SegCase,
  type SegmentInfo,
  type SliceMasks,
} from './segmentation';
import {
  applyPreset,
  initCornerstone,
  loadSeries,
  mountStackViewport,
  observeElementSize,
  readWindow,
  resetViewport,
  presetsFor,
  showSeries,
  usesHounsfield,
  waitForElementSize,
  type LoadedSeries,
  type Preset,
} from './viewport';

const VIEWPORT_ID = 'dv-main';

const el = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

/* The modality the preset buttons and the guide cards were last drawn for, so they are
   rebuilt when the reader switches imaging type and not on every repaint. */
let paintedModality: string | undefined;

/* The modality of the series on screen, which is not always the modality of the page: the
   CT viewer also carries the PET half of a PET/CT, and a Hounsfield window means nothing
   there. The controls follow this rather than the page. */
let paintedSeriesModality: string | undefined;

const state: {
  source: Source;
  catalog?: Catalog;
  selection: Selection;
  entry?: CatalogEntry;
  stack?: LoadedSeries;
  viewport?: Types.IStackViewport;
  prefetch?: PrefetchHandle;
  /* Set on a single-modality page; undefined on the combined viewer. */
  profile?: ModalityProfile;
  /* The profile of the series actually displayed, which drives the controls and readouts. */
  seriesProfile?: ModalityProfile;
  /* Published segmentation for the series on screen, when one exists. */
  segEntry?: IndexEntry;
  segCase?: SegCase;
  segMasks?: SliceMasks;
  segSliceSop?: string;
  identifying: boolean;
  /* Incremented on every load so a slow fetch cannot overwrite a newer one. */
  loadToken: number;
} = {
  source: sourceById('idc'),
  selection: {},
  loadToken: 0,
  identifying: false,
};

/* ---------- status ---------- */

/* Status is a transient line, not a permanent panel. While something is loading or has
   failed it says so; once a series is on screen the overlay and the provenance line already
   carry everything it was repeating, so it gets out of the way. */
function setStatus(message: string, kind: 'info' | 'error' | 'done' = 'info'): void {
  const node = el('dv-status');
  if (!node) return;
  node.textContent = kind === 'done' ? '' : message;
  node.dataset.kind = kind;
  node.hidden = kind === 'done';
  node.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/* ---------- loading bar ---------- */

/* The bar reports the whole series, but says separately when the slices around the reader
   are in hand, because that is when scrolling actually becomes smooth. Waiting for 100%
   on a 277-slice study would mean waiting tens of seconds for something already usable. */
function setProgress(loaded: number, total: number, readyNearby: boolean): void {
  const wrap = el('dv-progress');
  const fill = el('dv-progress-fill');
  const label = el('dv-progress-text');
  if (!wrap || !fill || !label) return;

  const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
  wrap.hidden = false;
  wrap.setAttribute('aria-valuenow', String(pct));
  fill.style.width = `${pct}%`;
  label.textContent = readyNearby
    ? `Ready to scroll - caching the rest, ${pct}%`
    : `Loading slices, ${pct}%`;

  if (loaded >= total && total > 0) {
    wrap.dataset.state = 'complete';
    label.textContent = `All ${total} images cached`;
    /* Leave the finished bar up briefly, then let the image have the space back. */
    window.setTimeout(() => {
      if (wrap.dataset.state === 'complete') wrap.hidden = true;
    }, 1600);
  } else {
    wrap.dataset.state = 'loading';
  }
}

function hideProgress(): void {
  const wrap = el('dv-progress');
  if (wrap) {
    wrap.hidden = true;
    wrap.dataset.state = 'idle';
  }
}

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

  paintExtraFields(ds);
}

/* The fields that only matter for one modality: TR and TE on MR, kVp and kernel on CT, the
   view on a radiograph, the probe on ultrasound. A field the server left empty is dropped
   rather than shown as a dash, because unlike the shared rows these are not expected on
   every study and a column of dashes would just be noise. */
function paintExtraFields(ds: Dataset | undefined): void {
  const host = el('dv-extra');
  if (!host) return;
  host.replaceChildren();

  const profile = state.seriesProfile ?? state.profile;
  if (!profile) return;

  for (const field of profile.extra) {
    let value = '';
    if (field.decimals !== undefined) {
      const n = num(ds, field.tag);
      if (n !== undefined) value = n.toFixed(field.decimals);
    } else {
      value = str(ds, field.tag).trim();
    }
    if (!value) continue;

    const row = document.createElement('span');
    row.textContent = `${field.label} ${value}${field.unit ?? ''}`;
    host.append(row);
  }
}

/* ---------- the four pickers ---------- */

const PICKERS = [
  { id: 'dv-pick-modality', key: 'modality' as const, param: 'imaging' },
  { id: 'dv-pick-region', key: 'region' as const, param: 'region' },
  { id: 'dv-pick-lesion', key: 'lesion' as const, param: 'finding' },
  { id: 'dv-pick-sequence', key: 'sequence' as const, param: 'sequence' },
  { id: 'dv-pick-case', key: 'caseId' as const, param: 'case' },
];

/* The selection lives in the query string so a particular case can be bookmarked or sent to
   someone. replaceState rather than pushState: flipping through studies should not bury the
   previous page under a stack of history entries the back button has to walk out of. */
function selectionFromUrl(): Selection {
  const q = new URLSearchParams(window.location.search);
  const sel: Selection = {};
  for (const p of PICKERS) {
    const v = q.get(p.param);
    if (v) sel[p.key] = v;
  }
  return sel;
}

function selectionToUrl(sel: Selection): void {
  const q = new URLSearchParams();
  for (const p of PICKERS) {
    const v = sel[p.key];
    if (v) q.set(p.param, v);
  }
  const query = q.toString();
  window.history.replaceState(
    null,
    '',
    query ? `${window.location.pathname}?${query}` : window.location.pathname
  );
}

function fillSelect(select: HTMLSelectElement, choices: Choice[], selected?: string): void {
  select.replaceChildren();
  for (const c of choices) {
    const option = document.createElement('option');
    option.value = c.value;
    /* The count tells the reader how much there is behind a choice before they commit. */
    const counted = c.count > 1 ? `${c.label} (${c.count})` : c.label;
    /* Three series out of several hundred carry outlines. Without saying which, the reader
       has to open them one by one to find the structures. */
    option.textContent = c.outlined ? `${counted} - outlined` : counted;
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
    caseId: caseChoices(entries, sel),
  };

  for (const p of PICKERS) {
    const select = el<HTMLSelectElement>(p.id);
    if (select) fillSelect(select, choices[p.key] ?? [], sel[p.key]);
  }

  /* What the controls do depends on the modality: Hounsfield windows belong to CT, and the
     guide has to say something different about scrolling a 2-image mammogram. */
  selectionToUrl(sel);

  const group = sel.modality ?? 'CT';
  if (group !== paintedModality) {
    paintedModality = group;
    syncControlsTo(group);
  }
}

/* Point the window presets, the how-to cards and the extra readouts at one modality. */
function syncControlsTo(modalityCode: string): void {
  if (modalityCode === paintedSeriesModality) return;
  paintedSeriesModality = modalityCode;
  state.seriesProfile = profileFor(modalityCode);
  buildPresetButtons(modalityCode);
  buildGuide(modalityCode);

  const note = el('dv-modality-note');
  if (note) note.textContent = state.seriesProfile?.note ?? state.profile?.note ?? '';
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
  syncControlsTo(entry.modality);

  const token = state.loadToken + 1;
  state.loadToken = token;

  setStatus(`Loading ${entry.sequence} - ${describeEntry(entry)}`);
  text('dv-provenance', `${entry.collection} - ${entry.patientId}`);

  /* Stop the previous series pulling bandwidth away from the one now being asked for. */
  state.prefetch?.cancel();
  state.prefetch = undefined;
  hideProgress();

  try {
    const stack = await loadSeries(state.source, entry.studyUID, entry.seriesUID);
    if (token !== state.loadToken) return; // a newer selection won

    state.stack = stack;
    await showSeries(viewport, stack);
    if (token !== state.loadToken) return;

    paintOverlay();

    /* The first slice is on screen; pull the rest in behind it, nearest first, so that
       scrolling stops costing a round trip per slice. */
    void prepareSegmentation(entry.seriesUID, token);

    const startIndex = viewport.getCurrentImageIdIndex();
    state.prefetch = prefetchStack(stack.imageIds, startIndex, (p) => {
      if (token !== state.loadToken) return;
      setProgress(p.loaded, p.total, p.readyNearby);
    });
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

/* ---------- how to drive it ---------- */

/* Small line-art icons drawn here rather than pulled from an icon set, so the page keeps
   its single stylesheet and no third-party asset. Each is a 24x24 mouse or key outline with
   the relevant part filled. */
const MOUSE_BODY = '<rect x="7" y="2.5" width="10" height="19" rx="5" fill="none" stroke="currentColor" stroke-width="1.6"/>';

const ICONS: Record<string, string> = {
  left:
    MOUSE_BODY +
    '<path d="M7.8 7.5V8a4.2 4.2 0 0 1 4.2-4.2V7.5z" fill="currentColor"/>' +
    '<path d="M12 3.3v4.4H7.8" fill="currentColor"/>',
  right:
    MOUSE_BODY +
    '<path d="M12 3.3v4.4h4.2V7.5A4.2 4.2 0 0 0 12 3.3z" fill="currentColor"/>',
  wheel:
    MOUSE_BODY +
    '<rect x="11.1" y="6" width="1.8" height="4.5" rx="0.9" fill="currentColor"/>' +
    '<path d="M12 1 10.6 2.9h2.8zM12 23l1.4-1.9h-2.8z" fill="currentColor"/>',
  middle:
    MOUSE_BODY +
    '<rect x="11.1" y="6" width="1.8" height="4.5" rx="0.9" fill="currentColor"/>',
  keys:
    '<rect x="2" y="13" width="6" height="6" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<rect x="9" y="13" width="6" height="6" rx="1.4" fill="currentColor"/>' +
    '<rect x="16" y="13" width="6" height="6" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<rect x="9" y="5" width="6" height="6" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  window:
    '<circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
    '<path d="M12 3.6a8.4 8.4 0 0 1 0 16.8z" fill="currentColor"/>',
};

interface GuideCard {
  icon: keyof typeof ICONS | string;
  title: string;
  body: string;
}

const CARD_ZOOM: GuideCard = {
  icon: 'right',
  title: 'Right drag',
  body: 'Zoom in and out. The zoom percentage shows in the bottom right of the image.',
};

const CARD_PAN: GuideCard = {
  icon: 'middle',
  title: 'Middle drag',
  body: 'Slide the image around once you are zoomed in past the edge of the frame.',
};

const CARD_KEYS: GuideCard = {
  icon: 'keys',
  title: 'Arrow keys',
  body: 'Click the image first. Up and Down move one slice, Page Up and Page Down move ten.',
};

/* What the controls mean genuinely differs by modality, so the cards do too: windowing on CT
   is a statement about Hounsfield units, and on MR it is only brightness and contrast. */
const GUIDES: Record<string, GuideCard[]> = {
  CT: [
    {
      icon: 'left',
      title: 'Left drag',
      body:
        'Sets the window. Left and right moves the centre, up and down the width, choosing ' +
        'which Hounsfield units are black and which are white.',
    },
    {
      icon: 'wheel',
      title: 'Scroll wheel',
      body: 'Moves through the slices, from the top of the scan to the bottom.',
    },
    CARD_ZOOM,
    CARD_PAN,
    {
      icon: 'window',
      title: 'Window buttons',
      body:
        'Standard CT windows. Lung shows air and vessels, bone shows cortex and trabeculae, ' +
        'soft tissue shows organs. The same slice looks like a different study in each.',
    },
    CARD_KEYS,
  ],
  MR: [
    {
      icon: 'left',
      title: 'Left drag',
      body:
        'Sets brightness and contrast. MR pixel values have no absolute scale, so unlike CT ' +
        'there is no fixed window that means the same thing on every scan.',
    },
    {
      icon: 'wheel',
      title: 'Scroll wheel',
      body: 'Moves through the slices of the sequence you picked.',
    },
    CARD_ZOOM,
    CARD_PAN,
    {
      icon: 'window',
      title: 'Window buttons',
      body:
        'As acquired uses the window stored in the file. Full range maps the darkest and ' +
        'brightest pixel to black and white. High contrast narrows it to bring out subtle detail.',
    },
    CARD_KEYS,
  ],
  MG: [
    {
      icon: 'left',
      title: 'Left drag',
      body:
        'Adjusts brightness and contrast, which is how calcifications are made to stand out ' +
        'from the surrounding tissue.',
    },
    {
      icon: 'right',
      title: 'Right drag',
      body:
        'Zoom. Mammograms are very high resolution and the findings are often small, so this ' +
        'is the control that matters most here.',
    },
    CARD_PAN,
    {
      icon: 'wheel',
      title: 'Scroll wheel',
      body:
        'A mammogram study is only a handful of images, so scrolling moves between those few ' +
        'views rather than through a stack of slices.',
    },
    CARD_KEYS,
  ],
  PT: [
    {
      icon: 'left',
      title: 'Left drag',
      body:
        'Sets brightness and contrast. A PET carries counts rather than calibrated numbers, ' +
        'so there is no fixed window as there is on CT.',
    },
    {
      icon: 'wheel',
      title: 'Scroll wheel',
      body: 'Moves through the slices, usually head to thigh on a whole-body study.',
    },
    CARD_ZOOM,
    CARD_PAN,
    {
      icon: 'window',
      title: 'Window buttons',
      body:
        'Full range shows the brightest uptake in the study, which is often the bladder or ' +
        'the brain rather than the lesion. High contrast is usually the more useful of the two.',
    },
    CARD_KEYS,
  ],
  XR: [
    {
      icon: 'left',
      title: 'Left drag',
      body:
        'Adjusts brightness and contrast. On a chest radiograph this is what brings out lung ' +
        'markings or, pulled the other way, the spine behind the heart.',
    },
    CARD_ZOOM,
    CARD_PAN,
    {
      icon: 'wheel',
      title: 'Scroll wheel',
      body:
        'A radiograph study is one or two images, so there is usually nothing to scroll ' +
        'through here.',
    },
  ],
};

const guideFor = (modalityGroup: string): GuideCard[] => GUIDES[modalityGroup] ?? GUIDES.MR ?? [];

function buildGuide(modalityGroup: string): void {
  const host = el('dv-guide');
  if (!host) return;
  host.replaceChildren();

  for (const card of guideFor(modalityGroup)) {
    const item = document.createElement('li');
    item.className = 'dv-card';

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    icon.innerHTML = ICONS[card.icon] ?? '';

    const title = document.createElement('h3');
    title.textContent = card.title;

    const body = document.createElement('p');
    body.textContent = card.body;

    item.append(icon, title, body);
    host.append(item);
  }
}

/* ---------- identify a structure ---------- */

/* What each segment is. Written for the structures the two published cases actually
   contain, rather than generated, because a wrong sentence about anatomy is worse than no
   sentence. Nothing here is a diagnosis: it describes what the named structure is and how
   it behaves on this kind of image. */
const EXPLANATIONS: Record<string, string> = {
  Kidney:
    'A paired retroperitoneal organ. After intravenous contrast the cortex enhances first ' +
    'and brightly, the medulla a little later, which is why a kidney on a contrast scan can ' +
    'look striped depending on when the images were taken.',
  Mass:
    'A solid lesion occupying space within the organ. On CT what separates a solid mass from ' +
    'a cyst is enhancement: a mass takes up contrast and rises in density after injection, ' +
    'because it has a blood supply of its own.',
  Cyst:
    'A fluid-filled space. It sits close to water density, near zero Hounsfield units, has a ' +
    'thin wall, and does not enhance after contrast. That lack of enhancement is what marks ' +
    'it out from a solid mass.',
  Breast:
    'The whole breast volume. On MR it is imaged with the patient prone so the tissue hangs ' +
    'clear of the chest wall, which separates breast tissue from the muscle behind it.',
  'Breast Fibroglandular Tissue':
    'The glandular and supporting tissue, as opposed to fat. It takes up contrast gently and ' +
    'symmetrically, and how much of it there is varies greatly between women, which affects ' +
    'how easily a lesion can be seen against it.',
  Lung:
    'Aerated lung. It is mostly air, so it sits at the very bottom of the Hounsfield scale ' +
    'near -800, which is why it reads as black on a soft-tissue window and needs a lung ' +
    'window to show its internal structure.',
  'FDG-Avid Tumor':
    'Tissue taking up the injected glucose analogue quickly. Cells consuming a lot of ' +
    'glucose accumulate the tracer, so they appear bright on PET. Uptake marks metabolic ' +
    'activity, which is not the same thing as a diagnosis: inflammation and infection are ' +
    'avid too.',
};

function explain(segment: SegmentInfo): string {
  return (
    EXPLANATIONS[segment.label] ??
    'This structure is named by the published segmentation; no description has been written ' +
      'for it yet.'
  );
}

function segOverlayCanvas(): HTMLCanvasElement | null {
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

function clearSegOverlay(): void {
  const canvas = segOverlayCanvas();
  const ctx = canvas ? canvas.getContext('2d') : null;
  if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

/* Masks belong to one slice, so they are reloaded whenever the slice changes. */
function refreshSliceMasks(): void {
  const { viewport, stack, segCase } = state;
  if (!viewport || !stack || !segCase) {
    state.segMasks = undefined;
    return;
  }
  const index = viewport.getCurrentImageIdIndex();
  const sop = str(stack.instances[index], TAG.SOPInstanceUID);
  if (sop === state.segSliceSop) return;
  state.segSliceSop = sop;
  state.segMasks = masksForSlice(segCase, sop);
  clearSegOverlay();

  const count = Object.keys(state.segMasks).length;
  const hint = el('dv-seg-hint');
  if (hint) {
    hint.textContent = count
      ? count + ' structure' + (count > 1 ? 's' : '') + ' outlined on this slice'
      : 'Nothing is outlined on this slice; scroll to find one';
  }
}

/* Shown as soon as a series with published outlines opens, before anything is drawn. The
   reader otherwise has no way to know the structures are there at all. */
function showSegIdle(): void {
  const panel = el('dv-seg-panel');
  const body = el('dv-seg-body');
  const { segCase } = state;
  if (!panel || !body || !segCase) return;
  panel.hidden = false;
  body.replaceChildren();

  const how = document.createElement('p');
  how.textContent =
    'This study comes with published outlines. Press Identify, then drag a box round a ' +
    'structure in the image and it is named here.';

  const heading = document.createElement('h3');
  heading.textContent = 'Outlined in this study';

  const list = document.createElement('ul');
  list.className = 'dv-seg-list';
  for (const segment of segCase.segments) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = segment.label;
    const kind = document.createElement('span');
    kind.className = 'dv-seg-kind';
    kind.dataset.kind = segment.kind;
    kind.textContent = segment.kind === 'lesion' ? 'Lesion' : 'Normal structure';
    item.append(name, kind);
    list.append(item);
  }

  body.append(how, heading, list);
}

function showSegPanel(hits: ReturnType<typeof hitTest>): void {
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
      'Nothing segmented inside that box. Only the published structures can be identified, ' +
      'so an unmarked area returns nothing.';
    body.append(none);
    clearSegOverlay();
    return;
  }

  const heading = document.createElement('h3');
  heading.textContent = best.segment.label;

  const kind = document.createElement('p');
  kind.className = 'dv-seg-kind';
  kind.dataset.kind = best.segment.kind;
  kind.textContent = best.segment.kind === 'lesion' ? 'Lesion' : 'Normal structure';

  const text = document.createElement('p');
  text.textContent = explain(best.segment);

  body.append(heading, kind, text);

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

  /* Highlight what was named, so the words and the picture agree. */
  const { viewport, stack, segCase, segMasks } = state;
  const canvas = segOverlayCanvas();
  if (viewport && stack && segCase && segMasks && canvas) {
    const mask = segMasks[String(best.segment.number)];
    const imageId = stack.imageIds[viewport.getCurrentImageIdIndex()];
    if (mask && imageId) {
      paintMask(
        canvas,
        viewport,
        imageId,
        mask,
        segCase.case.rows,
        segCase.case.cols,
        best.segment.kind
      );
    }
  }
}

/* The box is drawn on a layer above the image, which also stops the drag reaching
   Cornerstone underneath and windowing the picture while a box is being drawn. */
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
    const panel = el('dv-seg-panel');
    if (panel && !state.identifying) panel.hidden = true;
    if (!state.identifying) clearSegOverlay();
  });

  let start: [number, number] | null = null;

  layer.addEventListener('pointerdown', (event) => {
    const rect = layer.getBoundingClientRect();
    start = [event.clientX - rect.left, event.clientY - rect.top];
    rubber.hidden = false;
    rubber.style.left = start[0] + 'px';
    rubber.style.top = start[1] + 'px';
    rubber.style.width = '0px';
    rubber.style.height = '0px';
    layer.setPointerCapture(event.pointerId);
  });

  layer.addEventListener('pointermove', (event) => {
    if (!start) return;
    const rect = layer.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    rubber.style.left = Math.min(start[0], x) + 'px';
    rubber.style.top = Math.min(start[1], y) + 'px';
    rubber.style.width = Math.abs(x - start[0]) + 'px';
    rubber.style.height = Math.abs(y - start[1]) + 'px';
  });

  layer.addEventListener('pointerup', (event) => {
    if (!start) return;
    const rect = layer.getBoundingClientRect();
    const end: [number, number] = [event.clientX - rect.left, event.clientY - rect.top];
    rubber.hidden = true;
    const from = start;
    start = null;

    const { viewport, stack, segCase, segMasks } = state;
    if (!viewport || !stack || !segCase || !segMasks) return;
    const imageId = stack.imageIds[viewport.getCurrentImageIdIndex()];
    if (!imageId) return;

    const a = canvasPointToImage(viewport, imageId, from);
    const b = canvasPointToImage(viewport, imageId, end);
    /* A box the engine cannot place still has to answer, otherwise the panel keeps the
       previous structure and reads as though it described this box. */
    if (!a || !b) {
      showSegPanel([]);
      return;
    }
    /* A click rather than a drag still means something: treat it as a small box. */
    const pad = Math.abs(b[0] - a[0]) < 3 && Math.abs(b[1] - a[1]) < 3 ? 4 : 0;

    const hits = hitTest(
      segMasks,
      segCase.segments,
      { x0: a[0] - pad, y0: a[1] - pad, x1: b[0] + pad, y1: b[1] + pad },
      segCase.case.rows,
      segCase.case.cols
    );
    showSegPanel(hits);

    /* Drawing on the layer takes focus off the stage, which is what the arrow keys scroll
       with. Give it back, so a box and then a slice change is one continuous gesture. */
    el('dv-stage')?.focus({ preventScroll: true });
  });
}

/* Called when a series finishes loading: does it have a published segmentation? */
async function prepareSegmentation(seriesUID: string, token: number): Promise<void> {
  const button = el<HTMLButtonElement>('dv-identify');
  const wrap = el('dv-seg-controls');
  state.segEntry = undefined;
  state.segCase = undefined;
  state.segMasks = undefined;
  state.segSliceSop = undefined;
  state.identifying = false;
  clearSegOverlay();
  if (button) {
    button.setAttribute('aria-pressed', 'false');
    button.classList.remove('dv-chip--on');
  }
  const layer = el('dv-seg-layer');
  if (layer) layer.hidden = true;
  const panel = el('dv-seg-panel');
  if (panel) panel.hidden = true;
  if (wrap) wrap.hidden = true;

  const hint = el('dv-seg-hint');
  const entry = await segmentationFor(seriesUID);
  if (!entry || token !== state.loadToken) {
    if (hint && token === state.loadToken) {
      hint.textContent =
        'No published outlines for this series. The pickers mark the ones that have them.';
    }
    return;
  }

  try {
    const data = await loadSegCase(entry);
    if (token !== state.loadToken) return;
    state.segEntry = entry;
    state.segCase = data;
    if (wrap) wrap.hidden = false;
    refreshSliceMasks();
    showSegIdle();
  } catch {
    /* A missing segmentation file simply means the tool stays hidden. */
  }
}

/* ---------- view controls ---------- */

/* The dataset under the slice on screen, which 'As acquired' needs to read its window from. */
function currentDataset(): Dataset | undefined {
  const { viewport, stack } = state;
  if (!viewport || !stack) return undefined;
  return stack.instances[viewport.getCurrentImageIdIndex()];
}

function buildPresetButtons(modalityGroup: string): void {
  const host = el('dv-presets');
  if (!host) return;
  host.replaceChildren();

  const hu = usesHounsfield(modalityGroup);
  const label = el('dv-presets-label');
  if (label) label.textContent = hu ? 'Window (HU)' : 'Window';

  for (const preset of presetsFor(modalityGroup)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dv-chip';
    button.textContent = preset.label;
    button.dataset.preset = preset.id;
    button.title =
      preset.kind === 'hu'
        ? `Centre ${preset.center}, width ${preset.width} HU`
        : (preset.hint ?? preset.label);
    button.addEventListener('click', () => {
      if (!state.viewport) return;
      applyPreset(state.viewport, preset as Preset, currentDataset());
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

  wireControls(stage);
  wirePickers();
  wireIdentify();

  setStatus('Starting the renderer');
  try {
    await initCornerstone();
  } catch (error) {
    setStatus(`The renderer would not start: ${describe(error)}`, 'error');
    return;
  }

  /* Mount only once the frame has a real size. Enabling a viewport on a zero-height element
     makes Cornerstone give up on rendering it permanently. */
  const sized = await waitForElementSize(stage);
  if (!sized) {
    setStatus('The viewer could not measure its own frame; the image may not appear', 'error');
  }

  const viewport = mountStackViewport(stage, VIEWPORT_ID);
  state.viewport = viewport;
  observeElementSize(stage);

  stage.addEventListener(Enums.Events.STACK_NEW_IMAGE, paintOverlay);
  stage.addEventListener(Enums.Events.STACK_NEW_IMAGE, refreshSliceMasks);
  stage.addEventListener(Enums.Events.CAMERA_MODIFIED, clearSegOverlay);
  stage.addEventListener(Enums.Events.VOI_MODIFIED, paintOverlay);
  stage.addEventListener(Enums.Events.CAMERA_MODIFIED, paintOverlay);

  setStatus('Loading the case index');
  try {
    const catalog = await loadCatalog();
    assignIds(catalog.entries);

    /* A single-modality page keeps only its own series, so every picker below it counts and
       filters within that modality and the imaging picker itself has nothing left to do. */
    const locked = pageModality();
    if (locked) {
      state.profile = profileFor(locked);
      catalog.entries = catalog.entries.filter((e) => modalityGroup(e.modality) === locked);
      if (catalog.entries.length === 0) {
        setStatus('No studies of this kind are in the index yet', 'error');
        return;
      }
      const picker = el('dv-pick-modality')?.closest('.dv-pick');
      if (picker instanceof HTMLElement) picker.hidden = true;

      const label = document.querySelector('label[for="dv-pick-sequence"]');
      if (label && state.profile) label.textContent = state.profile.pickerLabel;

      const note = el('dv-modality-note');
      if (note && state.profile?.note) note.textContent = state.profile.note;
    }

    state.catalog = catalog;
    /* A link may already name a case; reconcile keeps whatever part of it is still valid. */
    state.selection = reconcile(catalog.entries, selectionFromUrl());
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
