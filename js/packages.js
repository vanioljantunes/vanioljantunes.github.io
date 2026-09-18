// Packages page motion: heading fades in, cards reveal on scroll with
// Motion's inView, and anime.js nudges the GitHub mark on hover.
// The screenshot scale on hover is plain CSS (see site.css).
import * as Motion from 'https://cdn.jsdelivr.net/npm/motion@13.4.0/+esm';
import * as anime from 'https://cdn.jsdelivr.net/npm/animejs@4.5.0/+esm';

const root = document.documentElement;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const tooLate = !root.classList.contains('anim-pending');

const EXPO_OUT = [0.16, 1, 0.3, 1];
const { animate, inView, stagger } = Motion;

if (reduced) {
  root.classList.remove('anim-pending');
} else {
  if (!tooLate) {
    const head = Array.from(document.querySelectorAll('.page-head [data-anim]'));
    const cards = Array.from(document.querySelectorAll('.pkg-list [data-anim]'));
    [...head, ...cards].forEach((el) => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(18px)';
    });
    root.classList.remove('anim-pending');

    animate(head, { opacity: [0, 1], y: [12, 0] }, {
      duration: 0.6,
      ease: EXPO_OUT,
      delay: stagger(0.06),
    });
    cards.forEach((card) => {
      inView(card, () => {
        animate(card, { opacity: [0, 1], y: [28, 0] }, { duration: 0.8, ease: EXPO_OUT, delay: 0.1 });
      }, { amount: 0.15 });
    });
  }

  document.querySelectorAll('.card').forEach((card) => {
    const mark = card.querySelector('.card-cta svg');
    if (!mark) return;
    const on = () => anime.animate(mark, { rotate: -8, scale: 1.1, duration: 400, ease: 'outQuart' });
    const off = () => anime.animate(mark, { rotate: 0, scale: 1, duration: 400, ease: 'outQuart' });
    card.addEventListener('pointerenter', on);
    card.addEventListener('pointerleave', off);
    card.addEventListener('focus', on);
    card.addEventListener('blur', off);
  });
}
