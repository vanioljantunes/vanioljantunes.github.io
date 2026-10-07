// Local pipeline dashboard: tails the event log, serves the plan, and takes decisions back.
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync, watch, mkdirSync, appendFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { EVENTS, emit } from '../bus.mjs';

const PORT = Number(process.env.HEART_DASH_PORT || 4317);
const HERE = resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = resolve(HERE, '..');
const ART = resolve(HERE, '..', '..', '..', '.tmp', 'heart');
const ANSWERS = join(ART, 'answers.jsonl');
mkdirSync(ART, { recursive: true });

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.glb': 'model/gltf-binary' };
const clients = new Set();

let offset = 0;
function push() {
  if (!existsSync(EVENTS)) return;
  const size = statSync(EVENTS).size;
  if (size <= offset) { offset = Math.min(offset, size); return; }
  const text = readFileSync(EVENTS).subarray(offset, size).toString();
  offset = size;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    for (const res of clients) res.write(`data: ${line}\n\n`);
  }
}
if (existsSync(EVENTS)) watch(EVENTS, { persistent: true }, push);
setInterval(push, 400).unref?.();

function body(req) {
  return new Promise((done) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => done(raw));
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const history = existsSync(EVENTS) ? readFileSync(EVENTS, 'utf8') : '';
    for (const line of history.split('\n')) if (line.trim()) res.write(`data: ${line}\n\n`);
    offset = existsSync(EVENTS) ? statSync(EVENTS).size : 0;
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/state') {
    const planFile = join(ROOT, 'plan.json');
    const plan = existsSync(planFile) ? readFileSync(planFile, 'utf8') : '{}';
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(plan);
    return;
  }

  // A decision taken in the dashboard: recorded for the session, and echoed into the stream.
  if (url.pathname === '/answer' && req.method === 'POST') {
    const answer = { t: Date.now(), ...JSON.parse((await body(req)) || '{}') };
    appendFileSync(ANSWERS, JSON.stringify(answer) + '\n');
    emit({ type: 'answered', ask: answer.ask, choice: answer.choice });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  const base = url.pathname.startsWith('/art/') ? ART : HERE;
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/art\//, '').replace(/^\//, ''));
  const file = join(base, rel);
  if (!file.startsWith(base) || !existsSync(file)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`heart dashboard on http://localhost:${PORT}`));
