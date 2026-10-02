/* The rendering side: start Cornerstone once, put a stack viewport on an element, and
 * feed it a series.
 *
 * Cornerstone is started exactly once per page. Its own init functions tolerate being
 * called twice, but the tool registration below does not, so the guard matters.
 */

import {
  init as coreInit,
  RenderingEngine,
  Enums,
  cache,
  type Types,
} from '@cornerstonejs/core';
import { init as loaderInit, wadors } from '@cornerstonejs/dicom-image-loader';
import {
  init as toolsInit,
  addTool,
  ToolGroupManager,
  PanTool,
  ZoomTool,
  StackScrollTool,
  WindowLevelTool,
  Enums as ToolEnums,
} from '@cornerstonejs/tools';

import { TAG, buildStack, num, seriesMetadata, type Dataset } from './dicomweb';
import type { Source } from './sources';

export const ENGINE_ID = 'dv-engine';
export const TOOL_GROUP_ID = 'dv-tools';

const { MouseBindings } = ToolEnums;

let engine: RenderingEngine | undefined;
let started = false;

/* Window presets, per modality.
 *
 * A Hounsfield unit is a CT quantity: it is defined against water and air, and a CT scanner
 * is calibrated so that -1000 is air and 0 is water. MR, mammography and plain radiography
 * have no such absolute scale - their pixel values are whatever the detector and the
 * reconstruction produced - so a "soft tissue 40/400" button is meaningless on them. Those
 * modalities get presets derived from the image actually on screen instead.
 */

export type PresetKind = 'hu' | 'scan' | 'full' | 'tight';

export interface Preset {
  id: string;
  label: string;
  kind: PresetKind;
  /* Only for 'hu' presets. */
  center?: number;
  width?: number;
  hint?: string;
}

const CT_PRESETS: readonly Preset[] = [
  { id: 'soft', label: 'Soft tissue', kind: 'hu', center: 40, width: 400 },
  { id: 'lung', label: 'Lung', kind: 'hu', center: -600, width: 1500 },
  { id: 'bone', label: 'Bone', kind: 'hu', center: 300, width: 1500 },
  { id: 'brain', label: 'Brain', kind: 'hu', center: 40, width: 80 },
  { id: 'mediastinum', label: 'Mediastinum', kind: 'hu', center: 50, width: 350 },
  { id: 'liver', label: 'Liver', kind: 'hu', center: 60, width: 160 },
];

/* For everything without an absolute scale: what the scan itself asked for, the whole
   range of the image, and a deliberately narrow window for low-contrast detail. */
const RELATIVE_PRESETS: readonly Preset[] = [
  { id: 'scan', label: 'As acquired', kind: 'scan', hint: 'The window stored in the file' },
  { id: 'full', label: 'Full range', kind: 'full', hint: 'Darkest to brightest pixel' },
  { id: 'tight', label: 'High contrast', kind: 'tight', hint: 'Narrow window, more contrast' },
];

const PRESET_SETS: Record<string, readonly Preset[]> = {
  CT: CT_PRESETS,
  MR: RELATIVE_PRESETS,
  MG: RELATIVE_PRESETS,
  XR: RELATIVE_PRESETS,
  PT: RELATIVE_PRESETS,
  NM: RELATIVE_PRESETS,
  US: RELATIVE_PRESETS,
};

export const presetsFor = (modalityGroup: string): readonly Preset[] =>
  PRESET_SETS[modalityGroup] ?? RELATIVE_PRESETS;

/* Hounsfield units only mean anything on CT, so only CT may describe a window in them. */
export const usesHounsfield = (modalityGroup: string): boolean => modalityGroup === 'CT';

/* Starting Cornerstone means core, then the DICOM loader (which spins up decode workers),
   then the tools library.
   The worker count is deliberately halved and capped: the decoders are CPU-bound, and
   saturating every core on a laptop makes the whole page stutter while a series loads.
   Nothing here asks for SharedArrayBuffer-backed threading, because that would require
   the site to send COOP and COEP headers, and those would break the cross-origin proxies
   vercel.json already declares for /tools/ssHelper/ and /tools/triageHelper/. */
export async function initCornerstone(): Promise<RenderingEngine> {
  if (started && engine) return engine;

  await coreInit();
  await loaderInit({
    maxWebWorkers: Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) >> 1)),
  });
  await toolsInit();

  addTool(StackScrollTool);
  addTool(WindowLevelTool);
  addTool(ZoomTool);
  addTool(PanTool);

  const group = ToolGroupManager.createToolGroup(TOOL_GROUP_ID);
  if (!group) throw new Error('could not create the tool group');

  group.addTool(WindowLevelTool.toolName);
  group.addTool(PanTool.toolName);
  group.addTool(ZoomTool.toolName);
  group.addTool(StackScrollTool.toolName);

  /* Left drag windows, middle pans, right zooms, wheel scrolls the stack. That is what a
     reporting workstation does, so it is what a radiologist's hands expect. */
  group.setToolActive(WindowLevelTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary }],
  });
  group.setToolActive(PanTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Auxiliary }],
  });
  group.setToolActive(ZoomTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Secondary }],
  });
  group.setToolActive(StackScrollTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Wheel }],
  });

  engine = new RenderingEngine(ENGINE_ID);
  started = true;
  return engine;
}

function requireEngine(): RenderingEngine {
  if (!engine) throw new Error('initCornerstone() has not finished yet');
  return engine;
}

/** Turn a div into a stack viewport and attach it to the shared tool group. */
export function mountStackViewport(
  element: HTMLDivElement,
  viewportId: string
): Types.IStackViewport {
  const renderingEngine = requireEngine();

  renderingEngine.enableElement({
    viewportId,
    type: Enums.ViewportType.STACK,
    element,
  });

  ToolGroupManager.getToolGroup(TOOL_GROUP_ID)?.addViewport(viewportId, ENGINE_ID);

  return renderingEngine.getViewport(viewportId) as Types.IStackViewport;
}

export interface LoadedSeries {
  imageIds: string[];
  instances: Dataset[];
  uniformGeometry: boolean;
}

/* Cornerstone's wadors loader does not fetch metadata itself: every imageId it will later
   be asked for must already be registered against its instance dataset. So the series
   metadata is pulled once, the stack is ordered, and each frame is registered before the
   viewport is handed the list. */
export async function loadSeries(
  source: Source,
  studyInstanceUID: string,
  seriesInstanceUID: string,
  signal?: AbortSignal
): Promise<LoadedSeries> {
  const instances = await seriesMetadata(source, studyInstanceUID, seriesInstanceUID, signal);
  if (instances.length === 0) {
    throw new Error('that series has no instances');
  }

  const stack = buildStack(source.root, studyInstanceUID, seriesInstanceUID, instances);
  if (stack.imageIds.length === 0) {
    throw new Error('that series has no readable frames');
  }

  for (let i = 0; i < stack.imageIds.length; i += 1) {
    const imageId = stack.imageIds[i];
    const ds = stack.instances[i];
    if (imageId && ds) {
      wadors.metaDataManager.add(imageId, ds as never);
    }
  }

  return stack;
}

/** Show a loaded series, starting in the middle, which is where the anatomy usually is. */
export async function showSeries(
  viewport: Types.IStackViewport,
  stack: LoadedSeries,
  startIndex = Math.floor(stack.imageIds.length / 2)
): Promise<void> {
  await viewport.setStack(stack.imageIds, startIndex);
  applyDefaultWindow(viewport, stack.instances[startIndex]);
  viewport.render();
}

/* A series usually carries the window the scanner or the technologist chose. Honour it.
   When the tags are absent, fall back to the full range of the image rather than to a CT
   soft-tissue window: that window is in Hounsfield units, and on an MR or a mammogram,
   which have no such scale, it can map the whole image to flat black. */
export function applyDefaultWindow(
  viewport: Types.IStackViewport,
  ds: Dataset | undefined
): void {
  const center = num(ds, TAG.WindowCenter);
  const width = num(ds, TAG.WindowWidth);
  if (center !== undefined && width !== undefined && width > 0) {
    setWindow(viewport, center, width);
    return;
  }
  const range = pixelRange(viewport);
  if (!range) return;
  setWindow(viewport, (range.min + range.max) / 2, range.max - range.min);
}

export function setWindow(
  viewport: Types.IStackViewport,
  center: number,
  width: number
): void {
  const half = width / 2;
  viewport.setProperties({ voiRange: { lower: center - half, upper: center + half } });
  viewport.render();
}

/* The displayed range of the image on screen. Large volumes are sampled rather than fully
   scanned: this runs on a button press and an exact extreme is not worth a pause. */
function pixelRange(
  viewport: Types.IStackViewport
): { min: number; max: number } | undefined {
  const data = viewport.getImageData();
  const scalar = data?.scalarData as ArrayLike<number> | undefined;
  if (!scalar || scalar.length === 0) return undefined;

  const step = Math.max(1, Math.floor(scalar.length / 200000));
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < scalar.length; i += step) {
    const v = scalar[i] as number;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return undefined;
  return { min, max };
}

export function applyPreset(
  viewport: Types.IStackViewport,
  preset: Preset,
  ds?: Dataset
): void {
  if (preset.kind === 'hu') {
    if (preset.center !== undefined && preset.width !== undefined) {
      setWindow(viewport, preset.center, preset.width);
    }
    return;
  }

  if (preset.kind === 'scan') {
    applyDefaultWindow(viewport, ds);
    return;
  }

  const range = pixelRange(viewport);
  if (!range) {
    /* Nothing to measure yet, so leave the window alone rather than blanking the image. */
    return;
  }
  const centre = (range.min + range.max) / 2;
  const span = range.max - range.min;
  setWindow(viewport, centre, preset.kind === 'tight' ? span * 0.45 : span);
}

/** Current window as centre and width, for the overlay. */
export function readWindow(
  viewport: Types.IStackViewport
): { center: number; width: number } | undefined {
  const range = viewport.getProperties().voiRange;
  if (!range) return undefined;
  return {
    center: (range.upper + range.lower) / 2,
    width: range.upper - range.lower,
  };
}

export function resetViewport(viewport: Types.IStackViewport, ds?: Dataset): void {
  viewport.resetCamera();
  applyDefaultWindow(viewport, ds);
  viewport.render();
}

/* Switching series leaves the previous one in the image cache, which for a 277-slice CT
   is a few hundred megabytes. Callers drop it when they move on. */
export function purgeCache(): void {
  cache.purgeCache();
}
