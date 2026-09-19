// Keep the current tool visible in the tools sub-navigation when it scrolls sideways (phones).
const current = document.querySelector('.site-subnav [aria-current="page"]');
const list = current?.closest('.site-subnav__links');
if (current && list && list.scrollWidth > list.clientWidth) {
  list.scrollLeft = current.offsetLeft - (list.clientWidth - current.offsetWidth) / 2;
}
