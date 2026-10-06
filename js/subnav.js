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

  const place = (menu) => {
    const r = menu.button.getBoundingClientRect();
    const { panel } = menu;
    panel.style.left = '0px';
    panel.style.top = `${r.bottom + 4}px`;
    const width = panel.offsetWidth;
    const max = document.documentElement.clientWidth - width - 12;
    panel.style.left = `${Math.max(12, Math.min(r.left, max))}px`;
  };

  const close = () => {
    if (!open) return;
    open.panel.hidden = true;
    open.button.setAttribute('aria-expanded', 'false');
    open = null;
  };

  const show = (menu) => {
    close();
    menu.panel.hidden = false;
    menu.button.setAttribute('aria-expanded', 'true');
    open = menu;
    place(menu);
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
