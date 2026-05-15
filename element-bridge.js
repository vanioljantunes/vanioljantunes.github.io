// Element Bridge — finds element line in pi-cv.html and opens VS Code at that line
// Start: node element-bridge.js
// Used by Ctrl+Shift+click inspector in pi-cv.html

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FILE = path.join(__dirname, 'pi-cv.html');
const PORT = 9997;

function findLine(html) {
  const source = fs.readFileSync(FILE, 'utf8');
  const lines = source.split('\n');

  // Extract opening tag — first non-empty line of outerHTML
  const openTag = html.split('\n')[0].trim();
  if (!openTag) return -1;

  // Build a search string from the tag + up to first 60 chars
  const needle = openTag.substring(0, 60).replace(/\s+/g, ' ');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+/g, ' ');
    if (line.includes(needle.substring(0, 40))) return i + 1;
  }

  // Fallback: search by id or first class
  const idMatch = openTag.match(/id="([^"]+)"/);
  if (idMatch) {
    const id = idMatch[1];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`id="${id}"`)) return i + 1;
    }
  }

  const clsMatch = openTag.match(/class="([^"]+)"/);
  if (clsMatch) {
    const firstClass = clsMatch[1].trim().split(/\s+/)[0];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(firstClass)) return i + 1;
    }
  }

  return -1;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const { html } = JSON.parse(body);
      const line = findLine(html);
      if (line < 1) { res.writeHead(404); res.end('not found'); return; }

      execSync(`code -g "${FILE}:${line}"`);
      res.writeHead(200);
      res.end(JSON.stringify({ line }));
    } catch (e) {
      res.writeHead(500);
      res.end(e.message);
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Element bridge on :${PORT} — watching ${FILE}`);
});
