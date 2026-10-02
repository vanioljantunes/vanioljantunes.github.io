// Bake lecture titles for named playlists without a YouTube API key.
//
//   node scripts/fetch-playlist-titles-keyless.mjs PLxxxx PLyyyy ...
//   node scripts/fetch-playlist-titles-keyless.mjs --cited
//
// Two keyless sources, combined:
//   1. the order of a playlist, read through the YouTube IFrame Player API in a real browser,
//      which is the same call the live lecture strip makes;
//   2. each video's title from youtube.com/oembed, fetched from Node, where the CORS rule that
//      blocks that endpoint in a page does not apply.
//
// Writes the same imaging/study-track/playlists/<id>.json that the key-based
// scripts/fetch-playlist-titles.mjs produces, and sets "playlistTitles": true in courses.json.
// Durations are not available this way and are left null; the key-based script fills them.
//
// --cited reads the playlist ids currently cited by a project page, so a re-run refreshes
// exactly the courses the site points at.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'file:///C:/Users/vanio/claudeOS/node_modules/playwright/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COURSES = join(ROOT, 'imaging', 'study-track', 'courses.json');
const OUT_DIR = join(ROOT, 'imaging', 'study-track', 'playlists');

// The page the browser needs: the IFrame API, one player, and a call that settles once the
// playlist order is known.
const HARNESS = `<!doctype html><meta charset="utf-8"><title>order</title><div id="p"></div>
<script src="https://www.youtube.com/iframe_api"></script>
<script>
let player;
window.order = (list) => new Promise((resolve) => {
  if (player) player.destroy();
  const host = document.createElement('div');
  document.getElementById('p').replaceChildren(host);
  let tries = 0;
  player = new YT.Player(host, {
    host: 'https://www.youtube-nocookie.com',
    playerVars: { list: list, listType: 'playlist', autoplay: 0, origin: location.origin },
    events: {
      onReady: function () {
        const poll = setInterval(function () {
          const ids = player.getPlaylist();
          if ((Array.isArray(ids) && ids.length) || ++tries > 40) {
            clearInterval(poll);
            resolve(Array.isArray(ids) ? ids : []);
          }
        }, 250);
      }
    }
  });
});
</script>`;

async function oembedTitle(videoId) {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${videoId}`,
  )}&format=json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null; // private, removed, or region blocked
    const data = await res.json();
    return data.title || null;
  } catch {
    return null;
  }
}

const data = JSON.parse(readFileSync(COURSES, 'utf8'));

// Which course owns a playlist, for the log line.
const owner = new Map();
for (const section of data.sections) {
  for (const course of section.courses) {
    for (const e of course.embeds) if (e.kind === 'playlist' && !owner.has(e.id)) owner.set(e.id, course.name);
  }
}

const args = process.argv.slice(2);
let ids = args.filter((a) => !a.startsWith('--'));

if (args.includes('--cited')) {
  // Every playlist id a project page currently links to.
  const pages = ['imaging/index.html', 'imaging/xvr/index.html', 'imaging/viewer/index.html'];
  const found = new Set();
  for (const p of pages) {
    let html;
    try {
      html = readFileSync(join(ROOT, p), 'utf8');
    } catch {
      continue;
    }
    for (const m of html.matchAll(/[?&]list=([A-Za-z0-9_-]{10,})/g)) found.add(m[1]);
  }
  ids = [...new Set([...ids, ...found])];
}

if (!ids.length) {
  console.error('Give one or more playlist ids, or --cited to read them from the project pages.');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

// A real origin for the harness: the IFrame API refuses to run from about:blank.
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(HARNESS);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.YT && window.YT.Player, null, { timeout: 30000 });

const today = new Date().toISOString().slice(0, 10);
let written = 0;
const failed = [];

for (const id of ids) {
  const name = owner.get(id) || 'not in the catalogue';
  try {
    const videoIds = await page.evaluate((list) => window.order(list), id);
    if (!videoIds.length) throw new Error('the playlist returned no videos');

    const items = [];
    for (const videoId of videoIds) {
      const title = await oembedTitle(videoId);
      items.push({ id: videoId, title: title || 'Untitled lecture', duration: null });
    }

    writeFileSync(join(OUT_DIR, `${id}.json`), JSON.stringify({ id, fetched: today, items }) + '\n');
    written += 1;
    const named = items.filter((i) => i.title !== 'Untitled lecture').length;
    console.log(`${id}  ${items.length} lectures, ${named} named  ${name}`);
  } catch (err) {
    failed.push(`${id} (${name}): ${err.message}`);
  }
}

await browser.close();
server.close();

if (written) {
  data.playlistTitles = true;
  writeFileSync(COURSES, JSON.stringify(data) + '\n');
}

console.log(`\n${written} written, ${failed.length} failed`);
for (const f of failed) console.log(`  ${f}`);
if (written) console.log('courses.json now carries "playlistTitles": true.');
