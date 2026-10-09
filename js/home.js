// Home page motion. Springs, not durations: the tiles can be grabbed, hovered and
// pressed at any point in their entrance and the motion continues from where they
// actually are rather than jumping to where the script thought they were.
// anime.js draws the line under the name.
// Loaded as a module: if either CDN import fails, nothing here runs and the head
// script's timeout reveals the content.
import { Motion, SPRING, reduced } from './motion.js';
import * as anime from 'https://cdn.jsdelivr.net/npm/animejs@4.5.0/+esm';

const root = document.documentElement;
// The fallback timer already revealed everything: do not hide it again.
const tooLate = !root.classList.contains('anim-pending');

const { animate, stagger } = Motion;

if (reduced) {
  root.classList.remove('anim-pending');
} else {
  const intro = Array.from(document.querySelectorAll('.intro [data-anim]:not(.name-line)'));
  const tiles = Array.from(document.querySelectorAll('.tiles [data-anim]'));
  const line = document.querySelector('.name-line path');

  if (!tooLate) {
    // Initial hidden states are set here, from JS, then the class is dropped.
    [...intro, ...tiles].forEach((el) => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(14px)';
    });
    const drawable = line ? anime.svg.createDrawable(line)[0] : null;
    if (drawable) anime.utils.set(drawable, { draw: '0 0' });
    root.classList.remove('anim-pending');

    // Nothing was thrown here, so nothing overshoots: a critically damped spring
    // arrives and settles.
    animate(intro, { opacity: [0, 1], y: [14, 0] }, {
      ...SPRING.move,
      duration: 0.55,
      delay: stagger(0.06),
    });
    animate(tiles, { opacity: [0, 1], y: [22, 0] }, {
      ...SPRING.move,
      duration: 0.6,
      delay: stagger(0.08, { startDelay: 0.25 }),
    });
    if (drawable) {
      anime.animate(drawable, {
        draw: ['0 0', '0 1'],
        duration: 900,
        delay: 250,
        ease: 'outQuart',
      });
    }
  }

  // Hover grows the card, the press answers on pointer-down and returns to whichever
  // state the pointer is still in. Every one of these re-targets the same spring, so
  // a press during the entrance, or a pointer leaving mid-press, continues from the
  // scale on screen instead of snapping.
  const HOVER = 1.035;
  const PRESS = 0.995;

  document.querySelectorAll('[data-tile]').forEach((tile) => {
    let hovered = false;
    const to = (scale, spring) => animate(tile, { scale }, spring);
    const lift = () => { hovered = true; to(HOVER, SPRING.move); };
    const drop = () => { hovered = false; to(1, SPRING.move); };

    if (typeof Motion.hover === 'function') {
      Motion.hover(tile, () => {
        lift();
        return drop;
      });
    } else {
      tile.addEventListener('pointerenter', lift);
      tile.addEventListener('pointerleave', drop);
    }
    tile.addEventListener('focusin', lift);
    tile.addEventListener('focusout', drop);

    if (typeof Motion.press === 'function') {
      // Motion's press fires on pointer-down, which is the only moment feedback is
      // worth anything.
      Motion.press(tile, () => {
        to(PRESS, SPRING.press);
        return () => to(hovered ? HOVER : 1, SPRING.move);
      });
    } else {
      tile.addEventListener('pointerdown', () => to(PRESS, SPRING.press), { passive: true });
      tile.addEventListener('pointerup', () => to(hovered ? HOVER : 1, SPRING.move), { passive: true });
      tile.addEventListener('pointercancel', () => to(hovered ? HOVER : 1, SPRING.move), { passive: true });
    }
  });
}
