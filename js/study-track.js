// Study track: render the deep-learning-drizzle catalogue, filter it, and play a
// course playlist inside its own card. One iframe exists at a time.

const DATA_URL = '/study-track/courses.json';

const railList = document.getElementById('st-rail-list');
const railTotal = document.getElementById('st-rail-total');
const sectionsEl = document.getElementById('st-sections');
const countEl = document.getElementById('st-count');
const emptyEl = document.getElementById('st-empty');
const emptyClear = document.getElementById('st-empty-clear');
const form = document.getElementById('st-filters');
const qEl = document.getElementById('st-q');
const yearsEl = document.getElementById('st-years');
const sortEl = document.getElementById('st-sort');
const playableEl = document.getElementById('st-playable');

let sections = [];
let openCard = null;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function haystack(course, sectionTitle) {
  return `${course.name} ${course.instructor} ${sectionTitle} ${course.year || ''}`.toLowerCase();
}

async function load() {
  let data;
  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    countEl.textContent = 'The catalogue could not be loaded. Reload the page, or read courses.json directly.';
    console.error(err);
    return;
  }

  sections = data.sections.map((s) => ({
    ...s,
    courses: s.courses.map((c) => ({ ...c, search: haystack(c, s.title) })),
  }));

  buildRail();
  buildSections();
  railTotal.textContent = `${plural(data.counts.courses, 'course', 'courses')} in ${plural(
    data.counts.sections,
    'topic',
    'topics',
  )}. ${data.counts.withEmbed} play in the page.`;
  apply();
  watchSections();
}

function buildRail() {
  railList.replaceChildren();
  for (const s of sections) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${s.slug}`;
    a.dataset.slug = s.slug;
    const name = document.createElement('span');
    name.className = 'st-rail__name';
    name.textContent = s.title;
    const count = document.createElement('span');
    count.className = 'st-rail__count';
    a.append(name, count);
    li.append(a);
    railList.append(li);
  }
}

function linkOut(label, url, cls) {
  const a = document.createElement('a');
  a.className = cls;
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.append(document.createTextNode(label));
  const hint = document.createElement('span');
  hint.className = 'visually-hidden';
  hint.textContent = ' (opens in a new tab)';
  a.append(hint);
  return a;
}

function tag(text, off) {
  const t = document.createElement('span');
  t.className = off ? 'st-tag st-tag--off' : 'st-tag';
  t.textContent = text;
  return t;
}

function courseCard(course) {
  const li = document.createElement('li');
  li.className = 'st-card';
  li.id = course.id;

  const h3 = document.createElement('h3');
  h3.className = 'st-card__name';
  h3.textContent = course.name;
  li.append(h3);

  const meta = document.createElement('p');
  meta.className = 'st-card__meta';
  meta.textContent = course.instructor;
  li.append(meta);

  const tags = document.createElement('p');
  tags.className = 'st-card__tags';
  if (course.year) tags.append(tag(course.year, false));
  if (!course.embeds.length && course.videos.length) tags.append(tag('video off site', true));
  if (!course.videos.length) tags.append(tag('no recordings', true));
  if (tags.childElementCount) li.append(tags);

  const actions = document.createElement('p');
  actions.className = 'st-card__actions';

  if (course.embeds.length) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'st-play';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', `${course.id}-player`);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    const tri = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tri.setAttribute('d', 'M8 5.5v13l11-6.5z');
    icon.append(tri);
    const label = document.createElement('span');
    label.className = 'st-play__label';
    label.textContent = 'Play lectures';
    btn.append(icon, label);
    btn.addEventListener('click', () => togglePlayer(li, course, btn));
    actions.append(btn);
  }

  for (const v of course.videos) actions.append(linkOut(v.label, v.url, 'st-link'));
  for (const p of course.pages) actions.append(linkOut(p.label, p.url, 'st-link st-link--quiet'));
  li.append(actions);

  const player = document.createElement('div');
  player.className = 'st-player';
  player.id = `${course.id}-player`;
  player.hidden = true;
  li.append(player);

  return li;
}

function togglePlayer(card, course, btn) {
  const player = card.querySelector('.st-player');
  const isOpen = btn.getAttribute('aria-expanded') === 'true';

  if (openCard && openCard !== card) closePlayer(openCard);

  if (isOpen) {
    closePlayer(card);
    return;
  }

  player.replaceChildren();

  const frame = document.createElement('iframe');
  frame.src = course.embeds[0].src;
  frame.title = `${course.name} lectures`;
  frame.loading = 'lazy';
  frame.allow = 'accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen';
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.allowFullscreen = true;

  if (course.embeds.length > 1) {
    const switcher = document.createElement('p');
    switcher.className = 'st-player__switch';
    course.embeds.forEach((e, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'st-chip';
      b.textContent = e.label || `Playlist ${i + 1}`;
      b.setAttribute('aria-pressed', String(i === 0));
      b.addEventListener('click', () => {
        frame.src = e.src;
        for (const c of switcher.querySelectorAll('.st-chip')) c.setAttribute('aria-pressed', String(c === b));
      });
      switcher.append(b);
    });
    player.append(switcher);
  }

  const wrap = document.createElement('div');
  wrap.className = 'st-player__frame';
  wrap.append(frame);
  player.append(wrap);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'st-linkbtn st-player__close';
  close.textContent = 'Close the player';
  close.addEventListener('click', () => {
    closePlayer(card);
    btn.focus();
  });
  player.append(close);

  player.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  btn.querySelector('.st-play__label').textContent = 'Stop lectures';
  card.classList.add('st-card--playing');
  openCard = card;
}

function closePlayer(card) {
  const player = card.querySelector('.st-player');
  const btn = card.querySelector('.st-play');
  player.replaceChildren(); // dropping the iframe stops playback
  player.hidden = true;
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    btn.querySelector('.st-play__label').textContent = 'Play lectures';
  }
  card.classList.remove('st-card--playing');
  if (openCard === card) openCard = null;
}

function buildSections() {
  sectionsEl.replaceChildren();
  for (const s of sections) {
    const sec = document.createElement('section');
    sec.className = 'st-section';
    sec.id = s.slug;
    sec.dataset.slug = s.slug;

    const h2 = document.createElement('h2');
    h2.className = 'st-section__head';
    const title = document.createElement('span');
    title.className = 'st-section__title';
    title.textContent = s.title;
    const count = document.createElement('span');
    count.className = 'st-section__count';
    count.dataset.sectionCount = s.slug;
    h2.append(title, document.createTextNode(' '), count);
    sec.append(h2);

    const ul = document.createElement('ul');
    ul.className = 'st-grid';
    for (const c of s.courses) ul.append(courseCard(c));
    sec.append(ul);
    sectionsEl.append(sec);
  }
}

function yearRange() {
  const v = yearsEl.value;
  if (!v) return null;
  const [from, to] = v.split('-').map(Number);
  return { from, to };
}

function matches(course, q, range) {
  if (q && !course.search.includes(q)) return false;
  if (playableEl.checked && !course.embeds.length) return false;
  if (range) {
    if (course.yearFrom == null) return false;
    if (course.yearTo < range.from || course.yearFrom > range.to) return false;
  }
  return true;
}

const comparators = {
  new: (a, b) => (b.yearTo ?? -1) - (a.yearTo ?? -1),
  old: (a, b) => (a.yearFrom ?? 9999) - (b.yearFrom ?? 9999),
  name: (a, b) => a.name.localeCompare(b.name),
};

function apply() {
  const q = qEl.value.trim().toLowerCase();
  const range = yearRange();
  const cmp = comparators[sortEl.value];
  let total = 0;

  for (const s of sections) {
    const sec = sectionsEl.querySelector(`.st-section[data-slug="${s.slug}"]`);
    const ul = sec.querySelector('.st-grid');
    const visible = [];

    for (const c of s.courses) {
      const card = ul.querySelector(`#${c.id}`);
      const ok = matches(c, q, range);
      card.hidden = !ok;
      if (!ok && card === openCard) closePlayer(card);
      if (ok) visible.push(c);
    }

    const order = cmp ? [...visible].sort(cmp) : s.courses;
    for (const c of order) ul.append(ul.querySelector(`#${c.id}`));

    sec.hidden = visible.length === 0;
    sec.querySelector(`[data-section-count="${s.slug}"]`).textContent = plural(visible.length, 'course', 'courses');

    const railItem = railList.querySelector(`a[data-slug="${s.slug}"]`);
    railItem.querySelector('.st-rail__count').textContent = String(visible.length);
    railItem.parentElement.hidden = visible.length === 0;

    total += visible.length;
  }

  const filtered = Boolean(q) || Boolean(range) || playableEl.checked;
  countEl.textContent = filtered
    ? `${plural(total, 'course', 'courses')} match`
    : `${plural(total, 'course', 'courses')} across ${plural(sections.length, 'topic', 'topics')}`;
  emptyEl.hidden = total > 0;
}

// Highlight the topic in the rail that the reader is looking at.
function watchSections() {
  const obs = new IntersectionObserver(
    (entries) => {
      const seen = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!seen) return;
      for (const a of railList.querySelectorAll('a')) {
        if (a.dataset.slug === seen.target.dataset.slug) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      }
    },
    { rootMargin: '-96px 0px -60% 0px', threshold: 0 },
  );
  for (const sec of sectionsEl.querySelectorAll('.st-section')) obs.observe(sec);
}

let timer;
form.addEventListener('input', (e) => {
  if (e.target === qEl) {
    clearTimeout(timer);
    timer = setTimeout(apply, 120);
  } else {
    apply();
  }
});
form.addEventListener('submit', (e) => e.preventDefault());
form.addEventListener('reset', () => setTimeout(apply, 0));
emptyClear.addEventListener('click', () => {
  form.reset();
  setTimeout(() => {
    apply();
    qEl.focus();
  }, 0);
});

load();
