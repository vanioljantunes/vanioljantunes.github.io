// Page chrome: the state the translucent bar needs, on every page.
// Deliberately dependency-free (no CDN import), because the bar's hairline and the
// fade on a scrolling strip must never wait on the network to be correct.
//
// 1. data-chrome on the bar says this file ran, so the CSS can keep a permanent
//    hairline when it did not.
// 2. data-scrolled appears once content is behind the bar: a scroll edge effect
//    instead of a divider that is there even with nothing to divide.
// 3. data-overflow marks a sideways strip that actually overflows, so the fade at
//    its ends exists only where there is more content to reach.

const bar = document.querySelector('.site-bar');

if (bar) {
  bar.setAttribute('data-chrome', '');

  // The page itself scrolls on most pages; the viewer and About put the scroll on a
  // wrapper, so whichever is actually scrolling is the one that is watched.
  const wrapper = document.querySelector('.scroll-wrapper');
  const scroller = wrapper && wrapper.scrollHeight > wrapper.clientHeight ? wrapper : window;
  const offset = () => (scroller === window ? window.scrollY : scroller.scrollTop);

  let pending = false;
  const sync = () => {
    pending = false;
    if (offset() > 4) bar.setAttribute('data-scrolled', '');
    else bar.removeAttribute('data-scrolled');
  };
  // One read per frame: the state is a class change, not something worth a layout
  // thrash on every scroll event.
  const onScroll = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(sync);
  };

  scroller.addEventListener('scroll', onScroll, { passive: true });
  sync();
}

const STRIPS = '.site-bar__links, .site-subnav__links, .st-rail__list, .st-strip, .scroll-strip';

// Rails are built by their own page script after this one runs, and filling a rail
// changes what it can scroll without changing its own size, so a ResizeObserver alone
// would miss it. The document is watched for new or refilled strips instead, and the
// work is one scrollWidth read per strip per frame.
const sized = 'ResizeObserver' in window ? new ResizeObserver(() => schedule()) : null;
let queued = false;

function measure() {
  queued = false;
  document.querySelectorAll(STRIPS).forEach((strip) => {
    if (sized && !strip.dataset.watched) {
      strip.dataset.watched = '1';
      sized.observe(strip);
    }
    // 2px of slack: a sub-pixel layout difference is not an overflow.
    const over = strip.scrollWidth - strip.clientWidth > 2;
    if (over) strip.setAttribute('data-overflow', '');
    else strip.removeAttribute('data-overflow');
    edges(strip, over);
    if (over && !strip.dataset.edged) {
      strip.dataset.edged = '1';
      strip.addEventListener('scroll', () => edges(strip, true), { passive: true });
    }
  });
}

// Which side still hides content. A fade at an end the strip has already reached
// would promise more than is there.
function edges(strip, over) {
  if (!over) {
    strip.removeAttribute('data-fade-start');
    strip.removeAttribute('data-fade-end');
    return;
  }
  const left = strip.scrollLeft;
  const right = strip.scrollWidth - strip.clientWidth - left;
  if (left > 2) strip.setAttribute('data-fade-start', '');
  else strip.removeAttribute('data-fade-start');
  if (right > 2) strip.setAttribute('data-fade-end', '');
  else strip.removeAttribute('data-fade-end');
}

function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(measure);
}

measure();
window.addEventListener('resize', schedule, { passive: true });
window.addEventListener('load', schedule);

if ('MutationObserver' in window) {
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
}
