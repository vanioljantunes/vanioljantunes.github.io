// Shared motion. One place for the spring presets, the momentum maths and the
// pointer-down feedback, so every page moves the same way.
//
// The rules behind the numbers:
//   - A spring has no duration. Response is how fast it reaches the target; bounce
//     is how far it overshoots on the way. Overshoot is earned by momentum, so the
//     default is critically damped and SPRING.throw is only for a flick or a drag
//     release.
//   - Motion's animate() reads the element's live transform, so a spring that is
//     re-targeted mid-flight continues from where the element actually is. That is
//     what makes a moving thing grabbable instead of something to wait out.
export * as Motion from 'https://cdn.jsdelivr.net/npm/motion@13.4.0/+esm';
import { animate } from 'https://cdn.jsdelivr.net/npm/motion@13.4.0/+esm';

export const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// bounce + duration is Motion's spelling of Apple's damping + response.
export const SPRING = {
  // Reposition, hover, settle: no overshoot.
  move: { type: 'spring', bounce: 0, duration: 0.4 },
  // Anything answering a press, where the only acceptable latency is none.
  press: { type: 'spring', bounce: 0, duration: 0.18 },
  // A surface arriving: quick, still calm.
  enter: { type: 'spring', bounce: 0, duration: 0.34 },
  // After a flick or a drag release, and only then.
  throw: { type: 'spring', bounce: 0.2, duration: 0.4 },
};

// Apple's projection function from the Designing Fluid Interfaces sample code.
// Exponential decay, not the v^2/(2a) of a physics textbook: the landing point of a
// flick is where the gesture was going, not where the finger happened to stop.
export function project(initialVelocity, decelerationRate = 0.998) {
  return ((initialVelocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

// Progressive resistance past a boundary. A hard stop reads as frozen; this reads as
// responsive with nothing more to reach.
export function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

// Velocity needs a short history, not the last two points: one stale frame at release
// and the handoff into the spring is visibly wrong.
export function velocityTracker(window_ms = 100) {
  const points = [];
  return {
    push(value) {
      const now = performance.now();
      points.push({ value, now });
      while (points.length > 2 && now - points[0].now > window_ms) points.shift();
    },
    get() {
      if (points.length < 2) return 0;
      const first = points[0];
      const last = points[points.length - 1];
      const dt = (last.now - first.now) / 1000;
      return dt > 0 ? (last.value - first.value) / dt : 0;
    },
    reset() {
      points.length = 0;
    },
  };
}

// Feedback on pointer-down and release, continuously, on the transform only.
// The listener is passive: pressing is not a reason to block the scroll it might
// turn into.
export function pressable(el, { scale = 0.97 } = {}) {
  if (reduced) return;
  let held = false;
  const down = () => {
    held = true;
    animate(el, { scale }, SPRING.press);
  };
  const up = () => {
    if (!held) return;
    held = false;
    animate(el, { scale: 1 }, SPRING.move);
  };
  el.addEventListener('pointerdown', down, { passive: true });
  el.addEventListener('pointerup', up, { passive: true });
  el.addEventListener('pointercancel', up, { passive: true });
  el.addEventListener('pointerleave', up, { passive: true });
}

// A translucent surface should arrive as a material: blur and scale together, out of
// the element that opened it, and leave along the same path it came in by.
export function materialize(el, { origin = 'top left', from = 0.94 } = {}) {
  el.style.transformOrigin = origin;
  if (reduced) return animate(el, { opacity: [0, 1] }, { duration: 0.15 });
  return animate(
    el,
    { opacity: [0, 1], scale: [from, 1], filter: ['blur(6px)', 'blur(0px)'] },
    SPRING.enter,
  );
}

export function dematerialize(el, { origin = 'top left', to = 0.96 } = {}) {
  el.style.transformOrigin = origin;
  if (reduced) return animate(el, { opacity: 0 }, { duration: 0.12 });
  return animate(
    el,
    { opacity: 0, scale: to, filter: 'blur(4px)' },
    { type: 'spring', bounce: 0, duration: 0.2 },
  );
}
