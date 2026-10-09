// Page chrome (bar scroll state, strip overflow) is wanted on every page that has
// the bar, and this module is on every one of them, so it is pulled in from here.
import './chrome.js';

// Tools, Who am I and R packages sub-navigation.
// 1. Keeps the current item visible when the list scrolls sideways (phones).
// 2. With data-spy, for in-page links (#section), marks the section in view with aria-current="location".
const list = document.querySelector('.site-subnav__links');

function reveal(item) {
  if (!item || !list || list.scrollWidth <= list.clientWidth) return;
  list.scrollLeft = item.offsetLeft - (list.clientWidth - item.offsetWidth) / 2;
}

reveal(document.querySelector('.site-subnav [aria-current="page"]'));

const links = [...document.querySelectorAll('.site-subnav[data-spy] a[href^="#"]')];
const targets = links.map((a) => document.getElementById(a.getAttribute('href').slice(1))).filter(Boolean);

if (targets.length && 'IntersectionObserver' in window) {
  const wrapper = document.querySelector('.scroll-wrapper');
  const root = wrapper && wrapper.scrollHeight > wrapper.clientHeight ? wrapper : null;
  const visible = new Map();
  const mark = () => {
    // The first section (in page order) that is in the band below the bars wins.
    const current = targets.find((t) => visible.get(t)) || null;
    links.forEach((a) => {
      const on = current && a.getAttribute('href') === `#${current.id}`;
      if (on) a.setAttribute('aria-current', 'location');
      else a.removeAttribute('aria-current');
      if (on) reveal(a);
    });
  };
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((e) => visible.set(e.target, e.isIntersecting));
    mark();
  }, { root, rootMargin: '-120px 0px -55% 0px' });
  targets.forEach((t) => observer.observe(t));
}

// 3. Column dropdowns. The panel is fixed rather than absolute, because the bar scrolls
//    sideways and would otherwise clip it, so its position is set on each open.
const menus = [...document.querySelectorAll('.subnav-menu')].map((root) => ({
  root,
  button: root.querySelector('.subnav-menu__button'),
  panel: root.querySelector('.subnav-menu__list'),
}));

if (menus.length) {
  let open = null;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const place = (menu) => {
    const r = menu.button.getBoundingClientRect();
    const { panel } = menu;
    panel.style.left = '0px';
    panel.style.top = `${r.bottom + 4}px`;
    const width = panel.offsetWidth;
    const max = document.documentElement.clientWidth - width - 12;
    const left = Math.max(12, Math.min(r.left, max));
    panel.style.left = `${left}px`;
    // The panel grows out of the button that opened it, not out of its own centre,
    // so the relationship between the two stays obvious. The origin is where the
    // button sits inside the panel, clamped to the panel if it was pushed sideways
    // to stay on screen.
    const originX = Math.max(8, Math.min(r.left + r.width / 2 - left, width - 8));
    panel.style.setProperty('--origin-x', `${Math.round(originX)}px`);
  };

  const close = () => {
    if (!open) return;
    const { panel, button } = open;
    open = null;
    button.setAttribute('aria-expanded', 'false');
    panel.removeAttribute('data-open');
    if (reduced) {
      panel.hidden = true;
      return;
    }
    // It leaves along the path it arrived by; it is only taken out of the layout once
    // it has finished leaving, and a timer covers the case where no transition ran.
    let done = false;
    const finish = () => {
      if (done || panel.hasAttribute('data-open')) return;
      done = true;
      panel.hidden = true;
      panel.removeEventListener('transitionend', finish);
    };
    panel.addEventListener('transitionend', finish);
    setTimeout(finish, 360);
  };

  const show = (menu) => {
    close();
    menu.panel.hidden = false;
    menu.button.setAttribute('aria-expanded', 'true');
    open = menu;
    place(menu);
    // Place it first, then let it arrive: without the forced read the panel would be
    // painted already open and there would be nothing to animate.
    void menu.panel.offsetWidth;
    menu.panel.setAttribute('data-open', '');
  };

  menus.forEach((menu) => {
    menu.button.addEventListener('click', (e) => {
      e.stopPropagation();
      if (open === menu) close();
      else show(menu);
    });
    // Arrow down from the button, like a native select, lands on the first project.
    menu.button.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown') return;
      e.preventDefault();
      show(menu);
      const first = menu.panel.querySelector('a');
      if (first) first.focus();
    });
  });

  document.addEventListener('click', (e) => {
    if (open && !open.panel.contains(e.target)) close();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !open) return;
    const { button } = open;
    close();
    button.focus();
  });

  // A panel pinned to the viewport would drift away from its button, so it follows or goes.
  document.addEventListener('focusin', (e) => {
    if (open && !open.root.contains(e.target)) close();
  });
  window.addEventListener('resize', close);
  window.addEventListener('scroll', () => open && place(open), { passive: true });
  if (list) list.addEventListener('scroll', () => open && place(open), { passive: true });
}
