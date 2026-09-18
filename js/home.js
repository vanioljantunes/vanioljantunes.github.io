// Home page motion. Motion drives the entrance and tile hover/press;
// anime.js draws the line under the name and nudges the tile arrows.
// Loaded as a module: if either CDN import fails, nothing here runs and the
// head script's timeout reveals the content.
import * as Motion from 'https://cdn.jsdelivr.net/npm/motion@13.4.0/+esm';
import * as anime from 'https://cdn.jsdelivr.net/npm/animejs@4.5.0/+esm';

const root = document.documentElement;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// The fallback timer already revealed everything: do not hide it again.
const tooLate = !root.classList.contains('anim-pending');

const EXPO_OUT = [0.16, 1, 0.3, 1];
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

    animate(intro, { opacity: [0, 1], y: [14, 0] }, {
      duration: 0.7,
      ease: EXPO_OUT,
      delay: stagger(0.07),
    });
    animate(tiles, { opacity: [0, 1], y: [22, 0] }, {
      duration: 0.8,
      ease: EXPO_OUT,
      delay: stagger(0.09, { startDelay: 0.3 }),
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

  // Hover lift, press and arrow nudge (transform only).
  document.querySelectorAll('[data-tile]').forEach((tile) => {
    const arrow = tile.querySelector('.tile-arrow');
    const lift = () => {
      animate(tile, { y: -3 }, { duration: 0.3, ease: EXPO_OUT });
      if (arrow) anime.animate(arrow, { translateX: 4, duration: 350, ease: 'outQuart' });
    };
    const drop = () => {
      animate(tile, { y: 0 }, { duration: 0.3, ease: EXPO_OUT });
      if (arrow) anime.animate(arrow, { translateX: 0, duration: 350, ease: 'outQuart' });
    };
    if (typeof Motion.hover === 'function') {
      Motion.hover(tile, () => {
        lift();
        return drop;
      });
    } else {
      tile.addEventListener('pointerenter', lift);
      tile.addEventListener('pointerleave', drop);
    }
    tile.addEventListener('focus', lift);
    tile.addEventListener('blur', drop);
    if (typeof Motion.press === 'function') {
      Motion.press(tile, () => {
        animate(tile, { scale: 0.985 }, { duration: 0.15, ease: EXPO_OUT });
        return () => animate(tile, { scale: 1 }, { duration: 0.3, ease: EXPO_OUT });
      });
    }
  });
}
