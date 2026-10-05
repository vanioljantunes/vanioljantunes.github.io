/* Pulling a series into the cache ahead of the reader.
 *
 * Cornerstone fetches only the slice on screen, which makes the first image appear quickly
 * but leaves every later slice a round trip away. Measured against the archive on
 * 2026-10-02 that is a median of 1.18 s per slice, so scrolling without prefetch feels like
 * scrolling through treacle.
 *
 * The order matters more than the speed. Slices are fetched outward from the one being
 * looked at, so the neighbours a reader reaches next arrive first and the far ends of the
 * stack arrive last, when they are needed least. A 277-slice series still takes tens of
 * seconds to finish in full; it takes a few seconds to become smooth where the reader
 * actually is, and that is the part that can be made to feel fast.
 */

import { imageLoader } from '@cornerstonejs/core';

export interface PrefetchProgress {
  loaded: number;
  total: number;
  /* True once the slices immediately around the starting point are in the cache. */
  readyNearby: boolean;
}

export interface PrefetchHandle {
  cancel: () => void;
  done: Promise<void>;
}

/* Enough neighbours that ordinary scrolling stays ahead of the network, and no more: every
   extra slice in this window is roughly a second before the viewer reports itself ready.
   Twelve each way is about ten seconds of scrolling at a normal pace, by which time the
   prefetch has moved further out anyway. */
const NEARBY_RADIUS = 12;

/* Requests in flight at once. The archive is served over HTTP/2, so the old six-per-host
   limit does not apply; this number is bounded by politeness to a public endpoint rather
   than by the browser. */
const CONCURRENCY = 16;

/* Phones are a different proposition from a desktop. A mobile browser will discard a tab
   that grows too large, and a discarded tab looks exactly like an image that never loaded,
   so on a small device the viewer deliberately fetches less: fewer requests at once, and a
   bounded number of slices around the reader rather than the whole series. Scrolling to the
   end of a long study then costs a round trip per slice again, which is slower but survives.
   deviceMemory is Chromium-only, so a coarse pointer with a narrow screen is the fallback
   signal; neither is exact, and both err towards treating an unknown device as small. */
export function isSmallDevice(): boolean {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof mem === 'number' && mem > 0 && mem <= 4) return true;
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches && window.innerWidth <= 900;
}

const SMALL_CONCURRENCY = 6;

/* How many slices a small device will hold for one series. 120 at 512 by 512 and two bytes
   a pixel is about 60 MB decoded, which leaves room for the page around it. */
const SMALL_MAX_SLICES = 120;

/** Indices ordered outward from `start`, so the reader's neighbourhood loads first. */
export function outwardOrder(total: number, start: number): number[] {
  if (total <= 0) return [];
  const first = Math.min(Math.max(start, 0), total - 1);
  const order: number[] = [first];
  for (let step = 1; order.length < total; step += 1) {
    const after = first + step;
    const before = first - step;
    if (after < total) order.push(after);
    if (before >= 0) order.push(before);
    if (before < 0 && after >= total) break;
  }
  return order;
}

/**
 * Load every image of a stack into the cache, nearest first.
 *
 * A frame the server refuses counts as progress rather than throwing: one bad slice in a
 * long series should not stall the bar or abandon the rest of the stack.
 */
export function prefetchStack(
  imageIds: readonly string[],
  startIndex: number,
  onProgress: (p: PrefetchProgress) => void
): PrefetchHandle {
  const small = isSmallDevice();
  const concurrency = small ? SMALL_CONCURRENCY : CONCURRENCY;

  /* On a small device only the slices around the reader are fetched, so the bar counts
     those rather than the whole series: a bar that stops at forty percent and never moves
     would read as a failure when it is a deliberate limit. */
  const full = outwardOrder(imageIds.length, startIndex);
  const order = small ? full.slice(0, SMALL_MAX_SLICES) : full;
  const total = order.length;

  let cancelled = false;
  let loaded = 0;
  let cursor = 0;
  let readyNearby = false;

  const report = (): void => {
    if (!readyNearby && loaded >= Math.min(NEARBY_RADIUS * 2 + 1, total)) {
      readyNearby = true;
    }
    onProgress({ loaded, total, readyNearby });
  };

  async function worker(): Promise<void> {
    while (!cancelled) {
      const next = cursor;
      cursor += 1;
      if (next >= order.length) return;

      const imageId = imageIds[order[next] as number];
      if (!imageId) {
        loaded += 1;
        report();
        continue;
      }

      try {
        await imageLoader.loadAndCacheImage(imageId);
      } catch {
        /* A frame the server will not give us is still one fewer to wait for. */
      }
      if (cancelled) return;
      loaded += 1;
      report();
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, Math.max(total, 1)); i += 1) {
    workers.push(worker());
  }

  report();

  return {
    cancel: () => {
      cancelled = true;
    },
    done: Promise.all(workers).then(() => undefined),
  };
}
