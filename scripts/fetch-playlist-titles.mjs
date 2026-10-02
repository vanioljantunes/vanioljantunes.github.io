// Bake lecture titles for every playlist in the study track into the repo, so the
// lecture strip names them before any of them is played.
//
//   YOUTUBE_API_KEY=... node scripts/fetch-playlist-titles.mjs [--limit N] [--force]
//
// Without this, the page still works: the YouTube IFrame API gives the order and the
// thumbnails, and each title appears once its lecture is visited. Running this only
// replaces "Lecture 7" with the real name up front.
//
// Writes study-track/playlists/<playlistId>.json and sets "playlistTitles": true in
// study-track/courses.json, which is the flag the page checks before asking for them.
//
// Quota: playlistItems.list costs 1 unit per page of 50 items. The default free quota
// is 10,000 units a day, and the whole catalogue is well under that.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COURSES = join(ROOT, 'study-track', 'courses.json');
const OUT_DIR = join(ROOT, 'study-track', 'playlists');

const KEY = process.env.YOUTUBE_API_KEY;
if (!KEY) {
  console.error('Set YOUTUBE_API_KEY first. Create one at https://console.cloud.google.com/apis/credentials');
  console.error('with the YouTube Data API v3 enabled.');
  process.exit(1);
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const limitAt = args.indexOf('--limit');
const limit = limitAt === -1 ? Infinity : Number(args[limitAt + 1]);

const data = JSON.parse(readFileSync(COURSES, 'utf8'));

// One entry per distinct playlist; a playlist shared by two courses is fetched once.
const playlists = new Map();
for (const section of data.sections) {
  for (const course of section.courses) {
    for (const e of course.embeds) {
      if (e.kind === 'playlist' && !playlists.has(e.id)) playlists.set(e.id, course.name);
    }
  }
}

mkdirSync(OUT_DIR, { recursive: true });

// PT1H2M3S -> 1:02:03
const iso = (s) => {
  const m = /^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s || '');
  if (!m) return null;
  const [h, min, sec] = [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(min)}:${pad(sec)}` : `${min}:${pad(sec)}`;
};

async function api(path, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [k, v] of Object.entries({ ...params, key: KEY })) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function items(playlistId) {
  const out = [];
  let pageToken;
  do {
    const page = await api('playlistItems', {
      part: 'snippet,contentDetails',
      playlistId,
      maxResults: 50,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const it of page.items) {
      const title = it.snippet.title;
      // Removed and private entries keep a placeholder title and no usable video.
      if (title === 'Deleted video' || title === 'Private video') continue;
      out.push({ id: it.contentDetails.videoId, title });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

async function durations(ids) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const page = await api('videos', { part: 'contentDetails', id: ids.slice(i, i + 50).join(',') });
    for (const v of page.items) found.set(v.id, iso(v.contentDetails.duration));
  }
  return found;
}

const today = new Date().toISOString().slice(0, 10);
let done = 0;
let skipped = 0;
const failed = [];

for (const [id, courseName] of playlists) {
  if (done + skipped >= limit) break;
  const file = join(OUT_DIR, `${id}.json`);
  if (!force && existsSync(file)) {
    skipped += 1;
    continue;
  }
  try {
    const list = await items(id);
    if (!list.length) throw new Error('no public items');
    const lengths = await durations(list.map((v) => v.id));
    writeFileSync(
      file,
      JSON.stringify({
        id,
        fetched: today,
        items: list.map((v) => ({ ...v, duration: lengths.get(v.id) || null })),
      }) + '\n',
    );
    done += 1;
    console.log(`${String(done).padStart(3)} ${id}  ${list.length} lectures  ${courseName}`);
  } catch (err) {
    failed.push(`${id} (${courseName}): ${err.message}`);
  }
}

if (done) {
  data.playlistTitles = true;
  writeFileSync(COURSES, JSON.stringify(data) + '\n');
}

console.log(`\n${done} fetched, ${skipped} already on disk, ${failed.length} failed`);
for (const f of failed) console.log(`  ${f}`);
if (done) console.log('\ncourses.json now carries "playlistTitles": true, so the page will read these files.');
