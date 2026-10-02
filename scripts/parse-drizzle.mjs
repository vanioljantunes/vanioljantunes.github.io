// Turn the kmario23/deep-learning-drizzle README into study-track/courses.json.
//
//   node scripts/parse-drizzle.mjs [path-to-README.md]
//
// With no argument the README is fetched from GitHub. The README is a sequence of
// headings, each followed by one six-column table: S.No | Course | Instructor(s) |
// Course WebPage | Lecture Videos | Year.

import { writeFileSync, readFileSync } from 'node:fs';

const SOURCE_RAW = 'https://raw.githubusercontent.com/kmario23/deep-learning-drizzle/master/README.md';
const OUT = new URL('../study-track/courses.json', import.meta.url);

// Headings that carry a course table but are not topic sections.
const SKIP_SECTIONS = new Set(['Contents', 'To-Do', 'Around the Web', 'Contributions', 'Support']);

const stripEmoji = (s) =>
  s
    .replace(/:[a-z0-9_+-]+:/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const clean = (s) => s.replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();

// A year cell can hold two runs ("2012 <br/> 2014"); keep them apart when shown.
const cleanYear = (s) =>
  s
    .replace(/<br\s*\/?>/gi, ' / ')
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, ' / ')
    .trim();

function links(cell) {
  const out = [];
  const re = /\[([^\]]*)\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(cell))) {
    const label = stripEmoji(m[1].replace(/[*`]/g, '')).replace(/^\(|\)$/g, '').trim();
    out.push({ label: label || 'Link', url: m[2] });
  }
  return out;
}

// A YouTube playlist or video link we can put in an iframe.
function embed(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtu.be') return null;
  const list = u.searchParams.get('list');
  if (list) return { kind: 'playlist', id: list, src: `https://www.youtube-nocookie.com/embed/videoseries?list=${list}` };
  const id = host === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v');
  if (id) return { kind: 'video', id, src: `https://www.youtube-nocookie.com/embed/${id}` };
  return null; // a channel or /playlists page: not embeddable
}

function splitRow(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|').map((c) => c.trim());
}

function parse(md) {
  const lines = md.split(/\r?\n/);
  const sections = [];
  let current = null;
  let id = 0;

  for (const line of lines) {
    const head = /^(#{2,3})\s+(.*)$/.exec(line);
    if (head) {
      const title = stripEmoji(head[2]).replace(/\s*\(.*?\)\s*$/, (m) => m); // keep real parentheses
      current = SKIP_SECTIONS.has(title) ? null : { title, courses: [] };
      if (current) sections.push(current);
      continue;
    }
    if (!current || !line.trim().startsWith('|')) continue;

    const cells = splitRow(line);
    if (cells.length < 6) continue;
    if (/^-+$/.test(cells[0].replace(/[\s:]/g, ''))) continue; // separator
    if (/^s\.?\s*no/i.test(cells[0])) continue; // header
    const name = clean(cells[1]).replace(/\*\*/g, '');
    if (!name) continue; // spacer row

    const pages = links(cells[3]);
    const videos = links(cells[4]);
    const embeds = [];
    for (const v of videos) {
      const e = embed(v.url);
      if (e && !embeds.some((x) => x.id === e.id)) embeds.push({ ...e, label: v.label });
    }

    const years = (clean(cells[5]).match(/\d{4}/g) || []).map(Number);

    current.courses.push({
      id: `c${++id}`,
      name,
      instructor: clean(cells[2]).replace(/\*\*/g, ''),
      pages,
      videos,
      embeds,
      year: cleanYear(cells[5]) || null,
      yearFrom: years.length ? Math.min(...years) : null,
      yearTo: years.length ? Math.max(...years) : null,
    });
  }

  return sections.filter((s) => s.courses.length);
}

const slug = (t) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const md = process.argv[2]
  ? readFileSync(process.argv[2], 'utf8')
  : await fetch(SOURCE_RAW).then((r) => {
      if (!r.ok) throw new Error(`fetch ${SOURCE_RAW}: ${r.status}`);
      return r.text();
    });

const sections = parse(md).map((s) => ({ slug: slug(s.title), ...s }));
const courses = sections.flatMap((s) => s.courses);

const data = {
  source: 'https://github.com/kmario23/deep-learning-drizzle',
  sourceLicense: 'MIT',
  generated: new Date().toISOString().slice(0, 10),
  counts: {
    sections: sections.length,
    courses: courses.length,
    withEmbed: courses.filter((c) => c.embeds.length).length,
  },
  sections,
};

writeFileSync(OUT, JSON.stringify(data) + '\n');

console.log(`${data.counts.sections} sections, ${data.counts.courses} courses, ${data.counts.withEmbed} embeddable`);
for (const s of sections) {
  console.log(`  ${String(s.courses.length).padStart(3)}  ${s.title}`);
}
