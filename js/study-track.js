// Study track: the deep-learning-drizzle catalogue, walked one level at a time.
//
// The page is a screen with a catalogue under it. The screen is the only thing that plays,
// it keeps its place while the reader navigates, and everything below it only decides what
// it shows: topics open into their courses, a course loads its playlist, a lecture swaps the
// video. The player is mounted once in the screen rather than inside whichever card was
// clicked, so choosing the next thing never moves the thing being watched.
//
// The player runs through the YouTube IFrame API rather than a bare iframe, because the
// catalogue only carries a playlist id: the API is what tells us the lectures in that
// playlist, which one is playing, and how to step between them. Nothing reaches YouTube
// until the reader presses play.

const DATA_URL = '/imaging/study-track/courses.json';
const YT_API = 'https://www.youtube.com/iframe_api';
const THUMB = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

const railList = document.getElementById('st-rail-list');
const railTotal = document.getElementById('st-rail-total');
const navEl = document.getElementById('st-sections');
const countEl = document.getElementById('st-count');
const emptyEl = document.getElementById('st-empty');
const emptyClear = document.getElementById('st-empty-clear');
const form = document.getElementById('st-filters');
const qEl = document.getElementById('st-q');
const yearsEl = document.getElementById('st-years');
const sortEl = document.getElementById('st-sort');
const playableEl = document.getElementById('st-playable');

const screenEl = document.getElementById('st-screen');
const screenIdle = document.getElementById('st-screen-idle');
const screenBody = document.getElementById('st-screen-body');

let sections = [];
let player = null; // the one live YT.Player, always mounted in the screen
let playing = null; // the course it is playing
let hasBakedTitles = false;
let openSlug = null; // the topic whose courses are listed, or null for the topic cards

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
  railTotal.textContent = `${plural(data.counts.courses, 'course', 'courses')} in ${plural(
    data.counts.sections,
    'topic',
    'topics',
  )}. ${data.counts.withEmbed} play in the page.`;
  apply();
  followUrl();
}

/* ---------- Arriving from a link ---------- */

// A project page cites a lecture as ?list=<playlistId>&i=<n>, and a topic as ?topic=<slug>.
// The citation is keyed on the playlist id rather than the course id because course ids are
// positional: re-parsing the README would silently repoint every link.
function followUrl() {
  const params = new URLSearchParams(location.search);
  const list = params.get('list');
  const topic = params.get('topic') || (location.hash ? decodeURIComponent(location.hash.slice(1)) : '');

  if (list) {
    for (const s of sections) {
      for (const course of s.courses) {
        const embed = course.embeds.find((e) => e.id === list);
        if (!embed) continue;
        const at = Number.parseInt(params.get('i') ?? '', 10);
        showTopic(s.slug);
        playCourse(course, embed, Number.isInteger(at) && at > 0 ? at : 0);
        return;
      }
    }
  }

  if (topic && sections.some((s) => s.slug === topic)) showTopic(topic);
}

// Keep the address bar in step with the level being read, so a topic can be bookmarked.
function rememberPlace() {
  const params = new URLSearchParams(location.search);
  params.delete('list');
  params.delete('i');
  if (openSlug) params.set('topic', openSlug);
  else params.delete('topic');
  const query = params.toString();
  window.history.replaceState(null, '', query ? `${location.pathname}?${query}` : location.pathname);
}

/* ---------- Small builders ---------- */

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

function buildRail() {
  railList.replaceChildren();
  for (const s of sections) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `?topic=${encodeURIComponent(s.slug)}`;
    a.dataset.slug = s.slug;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      showTopic(s.slug);
    });
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

/* ---------- Level one: the topics ---------- */

function topicCard(section, visible) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'st-topic';
  b.dataset.slug = section.slug;

  const name = document.createElement('span');
  name.className = 'st-topic__name';
  name.textContent = section.title;

  const count = document.createElement('span');
  count.className = 'st-topic__count';
  count.textContent = plural(visible, 'course', 'courses');

  b.append(name, count);
  b.addEventListener('click', () => showTopic(section.slug));
  li.append(b);
  return li;
}

/* ---------- Level two: the courses in a topic ---------- */

function courseCard(course) {
  const li = document.createElement('li');
  li.className = 'st-card';
  li.id = course.id;
  if (playing && playing.id === course.id) li.classList.add('st-card--playing');

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
    const label = document.createElement('span');
    label.className = 'st-play__label';
    label.textContent = playing && playing.id === course.id ? 'Playing above' : 'Play lectures';
    btn.append(icon('M8 5.5v13l11-6.5z'), label);
    btn.addEventListener('click', () => playCourse(course, course.embeds[0], 0));
    actions.append(btn);
  }

  for (const v of course.videos) actions.append(linkOut(v.label, v.url, 'st-link'));
  for (const p of course.pages) actions.append(linkOut(p.label, p.url, 'st-link st-link--quiet'));
  li.append(actions);

  return li;
}

function showTopic(slug) {
  openSlug = slug;
  // A topic is a place of its own, so a search from the previous level must not narrow it.
  if (qEl.value.trim()) qEl.value = '';
  apply();
  rememberPlace();
  const head = navEl.querySelector('.st-level__title');
  if (head) head.focus();
}

function showTopics() {
  openSlug = null;
  apply();
  rememberPlace();
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
        // The reader pressed play, so autoplay is wanted and allowed. A videoId key must
        // be absent for a playlist, not undefined: the API rejects undefined as invalid.
        const vars = { rel: 0, playsinline: 1, autoplay: 1, origin: location.origin };
        const options = { host: 'https://www.youtube-nocookie.com', playerVars: vars };
        if (embed.kind === 'playlist') {
          vars.list = embed.id;
          vars.listType = 'playlist';
        } else {
          options.videoId = embed.id;
        }
        options.events = {
          onReady: () => resolve(p),
          onStateChange: () => onChange(p),
        };
        const p = new YT.Player(host, options);
      }),
  );
}

/* ---------- Lecture strip ---------- */

// Baked titles, if a key was used to fetch them. Absent by default, and never requested
// unless courses.json says the files exist, so no failed request is made for nothing.
async function bakedTitles(playlistId) {
  if (!hasBakedTitles) return null;
  try {
    const res = await fetch(`/imaging/study-track/playlists/${playlistId}.json`);
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

/* ---------- The screen ---------- */

function destroyPlayer() {
  if (player && typeof player.destroy === 'function') {
    try {
      player.destroy();
    } catch {
      // The player may already be gone with its host; nothing to clean up then.
    }
  }
  player = null;
}

function closeScreen() {
  destroyPlayer();
  playing = null;
  screenBody.replaceChildren();
  screenBody.hidden = true;
  screenIdle.hidden = false;
  screenEl.classList.remove('st-screen--on');
  markPlayingCard();
}

// The course list stays on screen while something plays, so the card that is playing says so.
function markPlayingCard() {
  for (const card of navEl.querySelectorAll('.st-card')) {
    const isPlaying = Boolean(playing) && card.id === playing.id;
    card.classList.toggle('st-card--playing', isPlaying);
    const label = card.querySelector('.st-play__label');
    if (label) label.textContent = isPlaying ? 'Playing above' : 'Play lectures';
  }
}

function playCourse(course, embed = course.embeds[0], startAt = 0) {
  if (!embed) return;
  destroyPlayer();
  playing = course;
  screenIdle.hidden = true;
  screenBody.hidden = false;
  screenEl.classList.add('st-screen--on');
  screenBody.replaceChildren();
  markPlayingCard();

  const head = document.createElement('div');
  head.className = 'st-screen__head';
  const name = document.createElement('h2');
  name.className = 'st-screen__name';
  name.textContent = course.name;
  const who = document.createElement('p');
  who.className = 'st-screen__meta';
  who.textContent = [course.instructor, course.year].filter(Boolean).join(' · ');
  head.append(name, who);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'st-linkbtn st-screen__close';
  close.textContent = 'Close';
  close.addEventListener('click', closeScreen);
  head.append(close);
  screenBody.append(head);

  // Several playlists on one course: a chip per playlist.
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
        playCourse(course, e, 0);
      });
      switcher.append(b);
    }
    screenBody.append(switcher);
  }

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
  screenBody.append(stage);

  const now = document.createElement('p');
  now.className = 'st-now';
  now.textContent = 'Loading the player…';
  screenBody.append(now);

  const strip = document.createElement('div');
  strip.className = 'st-strip';
  strip.hidden = true;
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', `Lectures in ${course.name}`);
  screenBody.append(strip);

  let ids = [];
  let jumpTo = startAt;

  function refresh(p) {
    const list = p.getPlaylist();
    if (Array.isArray(list) && list.length && list.join() !== ids.join()) {
      ids = list;
      renderStrip(strip, ids, (n) => p.playVideoAt(n));
      strip.hidden = ids.length < 2;
      // A cited lecture can only be reached once the playlist itself has loaded.
      if (jumpTo > 0 && jumpTo < ids.length) {
        p.playVideoAt(jumpTo);
        jumpTo = 0;
        return;
      }
      jumpTo = 0;
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
      // The playlist is not always loaded the instant the player reports ready, and a
      // paused player fires no state change, so poll briefly until the order shows up.
      let tries = 0;
      const poll = setInterval(() => {
        if (player !== p || ids.length || ++tries > 20) {
          clearInterval(poll);
          return;
        }
        refresh(p);
      }, 400);
    })
    .catch((err) => {
      console.error(err);
      now.textContent = 'The player could not start. Open the playlist on YouTube instead.';
      stage.remove();
    });
}

/* ---------- Filtering, and what the catalogue shows ---------- */

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

function courseList(courses, cmp) {
  const ul = document.createElement('ul');
  ul.className = 'st-grid';
  const order = cmp ? [...courses].sort(cmp) : courses;
  for (const c of order) ul.append(courseCard(c));
  return ul;
}

function levelHead(title, note, onBack) {
  const head = document.createElement('div');
  head.className = 'st-level';

  if (onBack) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'st-back';
    back.append(icon('m15 5-7 7 7 7'));
    back.append(document.createTextNode('All topics'));
    back.addEventListener('click', onBack);
    head.append(back);
  }

  const h2 = document.createElement('h2');
  h2.className = 'st-level__title';
  h2.tabIndex = -1;
  h2.textContent = title;
  head.append(h2);

  if (note) {
    const p = document.createElement('p');
    p.className = 'st-level__note';
    p.textContent = note;
    head.append(p);
  }
  return head;
}

function apply() {
  const q = qEl.value.trim().toLowerCase();
  const range = yearRange();
  const cmp = comparators[sortEl.value];
  const filtered = Boolean(q) || Boolean(range) || playableEl.checked;

  // Per-topic counts drive both the rail and the topic cards.
  const visibleBySlug = new Map();
  let total = 0;
  for (const s of sections) {
    const visible = s.courses.filter((c) => matches(c, q, range));
    visibleBySlug.set(s.slug, visible);
    total += visible.length;

    const railItem = railList.querySelector(`a[data-slug="${s.slug}"]`);
    railItem.querySelector('.st-rail__count').textContent = String(visible.length);
    railItem.parentElement.hidden = visible.length === 0;
    if (s.slug === openSlug) railItem.setAttribute('aria-current', 'true');
    else railItem.removeAttribute('aria-current');
  }

  navEl.replaceChildren();

  if (filtered) {
    // A search is a question about the whole catalogue, so it answers across every topic
    // rather than inside whichever one happens to be open.
    const hits = [];
    for (const s of sections) for (const c of visibleBySlug.get(s.slug)) hits.push(c);
    if (hits.length) {
      navEl.append(levelHead('Matching courses', null, openSlug ? showTopics : null));
      navEl.append(courseList(hits, cmp));
    }
    countEl.textContent = `${plural(total, 'course', 'courses')} match`;
  } else if (openSlug) {
    const section = sections.find((s) => s.slug === openSlug);
    const courses = visibleBySlug.get(openSlug) ?? [];
    navEl.append(
      levelHead(section.title, `${plural(courses.length, 'course', 'courses')} in this topic.`, showTopics),
    );
    navEl.append(courseList(courses, cmp));
    countEl.textContent = `${plural(courses.length, 'course', 'courses')} in ${section.title}`;
  } else {
    const ul = document.createElement('ul');
    ul.className = 'st-topics';
    for (const s of sections) {
      const visible = visibleBySlug.get(s.slug);
      if (visible.length) ul.append(topicCard(s, visible.length));
    }
    navEl.append(ul);
    countEl.textContent = `${plural(total, 'course', 'courses')} across ${plural(
      sections.length,
      'topic',
      'topics',
    )}. Pick a topic.`;
  }

  emptyEl.hidden = total > 0;
  markPlayingCard();
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
