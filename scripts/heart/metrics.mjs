// Sample machine resources every few seconds so the dashboard can show pressure, not prose.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { emit } from './bus.mjs';

const run = promisify(execFile);
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

async function windowsDiskFreeGb() {
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', '(Get-PSDrive C).Free']);
    const bytes = num(stdout.trim());
    return bytes === null ? null : bytes / 1024 ** 3;
  } catch { return null; }
}

async function wslMemory() {
  try {
    const { stdout } = await run('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc',
      "free -m | awk 'NR==2{print $2, $7}'"]);
    const [total, available] = stdout.replace(/\0/g, '').trim().split(/\s+/).map(num);
    if (total === null) return null;
    return { totalGb: total / 1024, availableGb: available / 1024 };
  } catch { return null; }
}

async function gpu() {
  try {
    const { stdout } = await run('nvidia-smi', [
      '--query-gpu=memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits']);
    const [used, total, util] = stdout.trim().split(',').map((v) => num(v.trim()));
    return { usedMb: used, totalMb: total, utilPct: util };
  } catch { return null; }
}

async function sample() {
  const [diskFreeGb, mem, card] = await Promise.all([windowsDiskFreeGb(), wslMemory(), gpu()]);
  emit({ type: 'metric', diskFreeGb, mem, gpu: card });
}

await sample();
setInterval(sample, 5000);
