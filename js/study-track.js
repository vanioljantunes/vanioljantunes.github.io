// Study track: render the deep-learning-drizzle catalogue, filter it, and play a
// course playlist inside its own card. One player exists at a time.
//
// The player runs through the YouTube IFrame API rather than a bare iframe, because
// the catalogue only carries a playlist id: the API is what tells us the lectures in
// that playlist, which one is playing, and how to step between them. Nothing reaches
// YouTube until the reader presses play.

const DATA_URL = '/study-track/courses.json';
const YT_API = 'https://www.youtube.com/iframe_api';
const THUMB = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

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
let player = null; // the one live YT.Player
let hasBakedTitles = false;

// Titles we have learned, by video id. The IFrame API only names the video that is
// playing, so the strip fills in as lectures are visited unless titles were baked in.
const titles = new Map();

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

  hasBakedTitles = data.playlistTitles === true;

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

function icon(d) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
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
    const label = document.createElement('span');
    label.className = 'st-play__label';
    label.textContent = 'Play lectures';
    btn.append(icon('M8 5.5v13l11-6.5z'), label);
    btn.addEventListener('click', () => togglePlayer(li, course, btn));
    actions.append(btn);
  }

  for (const v of course.videos) actions.append(linkOut(v.label, v.url, 'st-link'));
  for (const p of course.pages) actions.append(linkOut(p.label, p.url, 'st-link st-link--quiet'));
  li.append(actions);

  const panel = document.createElement('div');
  panel.className = 'st-player';
  panel.id = `${course.id}-player`;
  panel.hidden = true;
  li.append(panel);

  return li;
}

/* ---------- The YouTube IFrame API ---------- */

let ytPromise = null;

function loadYouTubeApi() {
  if (ytPromise) return ytPromise;
  ytPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }
    // The API calls one global hook; chain anything already there rather than clobber it.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === 'function') previous();
      resolve(window.YT);
    };
    const s = document.createElement('script');
    s.src = YT_API;
    s.async = true;
    s.addEventListener('error', () => reject(new Error('the YouTube player script did not load')));
    document.head.append(s);
  });
  return ytPromise;
}

function mountPlayer(host, embed, onChange) {
  return loadYouTubeApi().then(
    (YT) =>
      new Promise((resolve) => {
        const vars = { rel: 0, playsinline: 1, origin: location.origin };
        if (embed.kind === 'playlist') {
          vars.list = embed.id;
          vars.listType = 'playlist';
        }
        const p = new YT.Player(host, {
          host: 'https://www.youtube-nocookie.com',
          videoId: embed.kind === 'video' ? embed.id : undefined,
          playerVars: vars,
          events: {
            onReady: () => resolve(p),
            onStateChange: () => onChange(p),
          },
        });
      }),
  );
}

/* ---------- Lecture strip ---------- */

// Baked titles, if a key was used to fetch them. Absent by default, and never requested
// unless courses.json says the files exist, so no failed request is made for nothing.
async function bakedTitles(playlistId) {
  if (!hasBakedTitles) return null;
  try {
    const res = await fetch(`/study-track/playlists/${playlistId}.json`);
    if (!res.ok) return null;
    const data = await res.json();
    for (const item of data.items) titles.set(item.id, item.title);
    return data.items;
  } catch {
    return null;
  }
}

function lectureLabel(id, n) {
  const known = titles.get(id);
  return known ? `${n}. ${known}` : `Lecture ${n}`;
}

function renderStrip(strip, ids, onPick) {
  strip.replaceChildren();
  ids.forEach((id, n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'st-lecture';
    b.dataset.index = String(n);
    b.addEventListener('click', () => onPick(n));

    const img = document.createElement('img');
    img.src = THUMB(id);
    img.alt = '';
    img.loading = 'lazy';
    img.width = 160;
    img.height = 90;

    const num = document.createElement('span');
    num.className = 'st-lecture__num';
    num.textContent = String(n + 1).padStart(2, '0');

    const name = document.createElement('span');
    name.className = 'st-lecture__name';
    name.textContent = lectureLabel(id, n + 1);

    b.append(img, num, name);
    b.setAttribute('aria-label', `Play ${lectureLabel(id, n + 1)}`);
    strip.append(b);
  });
}

// Refresh labels and the current marker. Titles arrive late, one per lecture visited.
function syncStrip(strip, ids, current) {
  for (const b of strip.querySelectorAll('.st-lecture')) {
    const n = Number(b.dataset.index);
    const label = lectureLabel(ids[n], n + 1);
    b.querySelector('.st-lecture__name').textContent = label;
    b.setAttribute('aria-label', `Play ${label}`);
    if (n === current) {
      b.setAttribute('aria-current', 'true');
      b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else {
      b.removeAttribute('aria-current');
    }
  }
}

/* ---------- Open and close ---------- */

function togglePlayer(card, course, btn) {
  const panel = card.querySelector('.st-player');
  const isOpen = btn.getAttribute('aria-expanded') === 'true';

  if (openCard && openCard !== card) closePlayer(openCard);
  if (isOpen) {
    closePlayer(card);
    return;
  }

  openPlayer(card, course, btn, panel, course.embeds[0]);
}

function openPlayer(card, course, btn, panel, embed) {
  panel.replaceChildren();

  // Several playlists on one course: a chip per playlist, as before.
  if (course.embeds.length > 1) {
    const switcher = document.createElement('p');
    switcher.className = 'st-player__switch';
    for (const e of course.embeds) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'st-chip';
      b.textContent = e.label || 'Playlist';
      b.setAttribute('aria-pressed', String(e === embed));
      b.addEventListener('click', () => {
        if (e === embed) return;
        destroyPlayer();
        openPlayer(card, course, btn, panel, e);
      });
      switcher.append(b);
    }
    panel.append(switcher);
  }

  const strip = document.createElement('div');
  strip.className = 'st-strip';
  strip.hidden = true;
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', `Lectures in ${course.name}`);
  panel.append(strip);

  const now = document.createElement('p');
  now.className = 'st-now';
  now.textContent = 'Loading the player…';
  panel.append(now);

  const stage = document.createElement('div');
  stage.className = 'st-stage';

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'st-step st-step--prev';
  prev.setAttribute('aria-label', 'Previous lecture');
  prev.append(icon('m15 5-7 7 7 7'));
  prev.disabled = true;

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'st-step st-step--next';
  next.setAttribute('aria-label', 'Next lecture');
  next.append(icon('m9 5 7 7-7 7'));
  next.disabled = true;

  const frame = document.createElement('div');
  frame.className = 'st-player__frame';
  const host = document.createElement('div');
  frame.append(host);

  stage.append(prev, frame, next);
  panel.append(stage);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'st-linkbtn st-player__close';
  close.textContent = 'Close the player';
  close.addEventListener('click', () => {
    closePlayer(card);
    btn.focus();
  });
  panel.append(close);

  panel.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  btn.querySelector('.st-play__label').textContent = 'Stop lectures';
  card.classList.add('st-card--playing');
  openCard = card;

  let ids = [];

  function refresh(p) {
    const list = p.getPlaylist();
    if (Array.isArray(list) && list.length && list.join() !== ids.join()) {
      ids = list;
      renderStrip(strip, ids, (n) => p.playVideoAt(n));
      strip.hidden = ids.length < 2;
    }

    const data = p.getVideoData ? p.getVideoData() : null;
    if (data && data.video_id && data.title) titles.set(data.video_id, data.title);

    const current = ids.length ? p.getPlaylistIndex() : -1;
    if (ids.length) syncStrip(strip, ids, current);

    const title = data && data.title ? data.title : '';
    now.textContent = ids.length
      ? `${current + 1} of ${ids.length}${title ? ` · ${title}` : ''}`
      : title || 'Playing';

    const stepping = ids.length > 1;
    prev.disabled = !stepping || current <= 0;
    next.disabled = !stepping || current < 0 || current >= ids.length - 1;
  }

  if (embed.kind === 'playlist') bakedTitles(embed.id);

  mountPlayer(host, embed, refresh)
    .then((p) => {
      player = p;
      prev.addEventListener('click', () => p.previousVideo());
      next.addEventListener('click', () => p.nextVideo());
      refresh(p);
    })
    .catch((err) => {
      console.error(err);
      now.textContent = 'The player could not start. Open the playlist on YouTube instead.';
      stage.remove();
    });
}

function destroyPlayer() {
  if (player && typeof player.destroy === 'function') {
    try {
      player.destroy();
    } catch {
      // The player may already be gone with its card; nothing to clean up then.
    }
  }
  player = null;
}

function closePlayer(card) {
  destroyPlayer();
  const panel = card.querySelector('.st-player');
  const btn = card.querySelector('.st-play');
  panel.replaceChildren();
  panel.hidden = true;
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    btn.querySelector('.st-play__label').textContent = 'Play lectures';
  }
  card.classList.remove('st-card--playing');
  if (openCard === card) openCard = null;
}

/* ---------- Sections and filtering ---------- */

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
