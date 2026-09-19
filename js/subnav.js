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
