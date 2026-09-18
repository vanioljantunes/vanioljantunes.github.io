// About page: a light Motion reveal for the parts the page's own reveal system
// does not already animate (the Home link and the footer). Sections keep
// their existing inline reveal so nothing is animated twice.
import { animate, inView } from 'https://cdn.jsdelivr.net/npm/motion@13.4.0/+esm';

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const EXPO_OUT = [0.16, 1, 0.3, 1];

if (!reduced) {
  const home = document.querySelector('.nav-home');
  if (home) animate(home, { opacity: [0, 1], x: [-6, 0] }, { duration: 0.6, ease: EXPO_OUT, delay: 0.15 });

  const footer = document.querySelector('.site-footer .wrap');
  const wrapper = document.querySelector('.scroll-wrapper');
  const mobile = window.matchMedia('(max-width: 767px)').matches;
  if (footer) {
    footer.style.opacity = '0';
    inView(footer, () => {
      animate(footer, { opacity: [0, 1], y: [10, 0] }, { duration: 0.7, ease: EXPO_OUT });
    }, { root: !mobile && wrapper ? wrapper : undefined, amount: 0.3 });
  }
}
