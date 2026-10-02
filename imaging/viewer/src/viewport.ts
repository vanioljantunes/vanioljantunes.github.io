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

/** Window/level presets, in Hounsfield units. */
export const PRESETS = [
  { id: 'soft', label: 'Soft tissue', center: 40, width: 400 },
  { id: 'lung', label: 'Lung', center: -600, width: 1500 },
  { id: 'bone', label: 'Bone', center: 300, width: 1500 },
  { id: 'brain', label: 'Brain', center: 40, width: 80 },
  { id: 'mediastinum', label: 'Mediastinum', center: 50, width: 350 },
  { id: 'liver', label: 'Liver', center: 60, width: 160 },
] as const;

export type PresetId = (typeof PRESETS)[number]['id'];

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

/* A series usually carries the window the scanner or the technologist chose. Honour it,
   and fall back to a soft-tissue window only when the tags are absent. */
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
  const soft = PRESETS[0];
  setWindow(viewport, soft.center, soft.width);
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

export function applyPreset(viewport: Types.IStackViewport, id: PresetId): void {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return;
  setWindow(viewport, preset.center, preset.width);
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
