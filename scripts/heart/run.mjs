// Run one pipeline stage, streaming its output to the terminal and the dashboard.
// usage: node scripts/heart/run.mjs <stage-id> <title> -- <command> [args...]
import { spawn } from 'node:child_process';
import { emit } from './bus.mjs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const [stageBase, title] = argv.slice(0, sep);
const [cmd, ...args] = argv.slice(sep + 1);
const stage = `${stageBase}-${Date.now().toString(36)}`;

emit({ type: 'stage', stage, title, status: 'running' });
const started = Date.now();
const child = spawn(cmd, args, { shell: true });
const beat = setInterval(() => emit({ type: 'beat', stage, ms: Date.now() - started }), 1000);

// uv and pip draw progress bars with carriage returns; those collapse into one updating line.
const isBar = (line) => /[━╸]|\d+%\s*$|\d+\/\d+\s*$/.test(line);
const ansi = /\[[0-9;?]*[A-Za-z]/g;

const pump = (chunk, stream) => {
  const text = chunk.toString();
  process[stream === 'err' ? 'stderr' : 'stdout'].write(text);
  for (const raw of text.split(/\r?\n|\r/)) {
    const line = raw.replace(ansi, '').trimEnd();
    if (!line.trim()) continue;
    emit({ type: isBar(line) ? 'progress' : 'log', stage, stream, line });
  }
};
child.stdout.on('data', (c) => pump(c, 'out'));
child.stderr.on('data', (c) => pump(c, 'err'));

child.on('close', (code) => {
  clearInterval(beat);
  emit({ type: 'stage', stage, title, status: code === 0 ? 'done' : 'failed', code, ms: Date.now() - started });
  process.exit(code ?? 1);
});
