// Element Bridge — file proxy + element-to-VS Code jump server
// Start: node element-bridge.js
// Open any project HTML via: http://127.0.0.1:9997/<file>.html
// Ctrl+click → copy element   |   Ctrl+Shift+click → jump to source line

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');
const { execSync } = require('child_process');

const ROOT      = __dirname;
const INSPECTOR = path.join(ROOT, 'inspector.js');
const PORT      = 9997;
const INJECT    = `\n<script src="http://127.0.0.1:${PORT}/inspector.js"></script>\n`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

/* ── Find source line for a given element's outerHTML ── */
function findLine(html, filePath) {
  if (!fs.existsSync(filePath)) return -1;
  const lines  = fs.readFileSync(filePath, 'utf8').split('\n');
  const openTag = html.split('\n')[0].trim();
  if (!openTag) return -1;
  const needle  = openTag.slice(0, 60).replace(/\s+/g, ' ');

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].replace(/\s+/g, ' ').includes(needle.slice(0, 40))) return i + 1;
  }

  const idM = openTag.match(/id="([^"]+)"/);
  if (idM) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`id="${idM[1]}"`)) return i + 1;
    }
  }

  const clsM = openTag.match(/class="([^"]+)"/);
  if (clsM) {
    const first = clsM[1].trim().split(/\s+/)[0];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(first)) return i + 1;
    }
  }

  return -1;
}

/* ── HTTP Server ── */
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed   = url.parse(req.url);
  const pathname = parsed.pathname;

  /* GET /ping — health check for inspector status button */
  if (req.method === 'GET' && pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  /* GET / → redirect to index.html if it exists */
  if (req.method === 'GET' && (pathname === '/' || pathname === '')) {
    const index = path.join(ROOT, 'index.html');
    res.writeHead(302, { Location: fs.existsSync(index) ? '/index.html' : '/pi-cv.html' });
    res.end();
    return;
  }

  /* POST /jump — find element source line and open VS Code */
  if (req.method === 'POST' && (pathname === '/jump' || pathname === '/')) {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const { html, file } = JSON.parse(body);
        // Resolve target file: use supplied name (basename only) or scan all HTMLs
        let target = file ? path.join(ROOT, path.basename(file)) : null;
        if (!target || !fs.existsSync(target)) {
          // Fallback: search all HTML files for the element
          const htmlFiles = fs.readdirSync(ROOT)
            .filter(f => f.endsWith('.html'))
            .map(f => path.join(ROOT, f));
          target = htmlFiles.find(f => findLine(html, f) > 0) || null;
        }
        if (!target) { res.writeHead(404); res.end('not found'); return; }

        const line = findLine(html, target);
        if (line < 1) { res.writeHead(404); res.end('not found'); return; }

        execSync(`code -g "${target}:${line}"`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ line, file: path.basename(target) }));
      } catch (e) {
        res.writeHead(500);
        res.end(e.message);
      }
    });
    return;
  }

  /* GET /inspector.js — serve the standalone inspector */
  if (req.method === 'GET' && pathname === '/inspector.js') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(fs.readFileSync(INSPECTOR, 'utf8'));
    } catch {
      res.writeHead(404); res.end('inspector.js not found');
    }
    return;
  }

  /* GET /any-file — serve static files; inject inspector into HTML */
  if (req.method === 'GET') {
    const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(ROOT, safe);

    // Safety: only serve files within ROOT
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';

    if (ext === '.html') {
      let content = fs.readFileSync(filePath, 'utf8');
      // Inject inspector before </body> (or append if tag missing)
      content = content.includes('</body>')
        ? content.replace('</body>', INJECT + '</body>')
        : content + INJECT;
      res.writeHead(200, { 'Content-Type': mime });
      res.end(content);
    } else {
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(filePath).pipe(res);
    }
    return;
  }

  res.writeHead(405); res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Element Bridge: http://127.0.0.1:${PORT}/`);
  console.log(`  Open any HTML via http://127.0.0.1:${PORT}/<file>.html`);
  console.log(`  Inspector auto-injected — Ctrl+click copy | Ctrl+Shift+click jump`);
});
