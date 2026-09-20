import { medianToMean } from './calc.js';
import { copyText, downloadBlob, rowsToTsv, rowsToXlsxBlob } from './xlsx.js';

// One row per study; each arm (intervention, control) has n, median, Q1, Q3, min, max and
// computed mean and SD. The scenario follows from the filled cells: all five numbers (3),
// median with Q1 and Q3 (2), or median with min and max (1).
const ARMS = [
  { key: 'int', name: 'intervention' },
  { key: 'ctl', name: 'control' },
];
const INPUTS = [
  { key: 'n', label: 'sample size' },
  { key: 'median', label: 'median' },
  { key: 'q1', label: 'first quartile' },
  { key: 'q3', label: 'third quartile' },
  { key: 'min', label: 'minimum' },
  { key: 'max', label: 'maximum' },
];

const rows = document.getElementById('m2m-rows');

function scenarioOf(v) {
  const has = (k) => Number.isFinite(v[k]);
  if (!has('n') || !has('median')) return null;
  if (has('q1') && has('q3') && has('min') && has('max')) return 3;
  if (has('q1') && has('q3')) return 2;
  if (has('min') && has('max')) return 1;
  return null;
}

function armCells(arm) {
  const inputs = INPUTS.map(
    (f) => `<td><input type="number" inputmode="decimal" step="any" data-arm="${arm.key}" data-k="${f.key}"></td>`,
  ).join('');
  return `${inputs}
    <td class="m2m-out" data-arm="${arm.key}" data-out="mean"><output>–</output></td>
    <td class="m2m-out" data-arm="${arm.key}" data-out="sd"><output>–</output><span class="m2m-flag"></span></td>`;
}

function addRow(focus = true) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="m2m-study" data-k="study" autocomplete="off"></td>
    ${ARMS.map(armCells).join('')}
    <td><button type="button" class="calc-remove">Remove</button></td>`;
  rows.appendChild(tr);
  renumber();
  if (focus) tr.querySelector('input').focus();
}

// Accessible names follow the row order after adds and removes.
function renumber() {
  const all = [...rows.rows];
  all.forEach((tr, i) => {
    const r = i + 1;
    tr.querySelector('[data-k="study"]').setAttribute('aria-label', `Study ${r} name (optional)`);
    for (const arm of ARMS) {
      for (const f of INPUTS) {
        tr.querySelector(`[data-arm="${arm.key}"][data-k="${f.key}"]`)
          .setAttribute('aria-label', `Study ${r} ${arm.name} ${f.label}`);
      }
    }
    const remove = tr.querySelector('.calc-remove');
    remove.setAttribute('aria-label', `Remove study ${r}`);
    remove.disabled = all.length === 1;
  });
}

function readArm(tr, arm) {
  const v = {};
  for (const f of INPUTS) {
    const raw = tr.querySelector(`[data-arm="${arm}"][data-k="${f.key}"]`).value.trim();
    v[f.key] = raw === '' ? NaN : Number(raw);
  }
  return v;
}

function setArm(tr, arm, state) {
  const meanCell = tr.querySelector(`[data-arm="${arm}"][data-out="mean"]`);
  const sdCell = tr.querySelector(`[data-arm="${arm}"][data-out="sd"]`);
  for (const cell of [meanCell, sdCell]) {
    cell.classList.remove('is-ok', 'is-skewed', 'is-error');
    if (state.cls) cell.classList.add(state.cls);
    cell.title = state.title || '';
  }
  meanCell.querySelector('output').textContent = state.mean ?? '–';
  sdCell.querySelector('output').textContent = state.sd ?? '–';
  sdCell.querySelector('.m2m-flag').textContent = state.flag ?? '';
}

function computeRow(tr) {
  for (const arm of ARMS) {
    const v = readArm(tr, arm.key);
    const k = scenarioOf(v);
    if (!k) {
      setArm(tr, arm.key, {});
      continue;
    }
    const r = medianToMean(k, v);
    if (r.error) {
      setArm(tr, arm.key, { cls: 'is-error', mean: '!', sd: '!', flag: 'check values', title: r.error });
      continue;
    }
    const methods = `Scenario ${k}: mean by ${r.meanMethod}, SD by ${r.sdMethod}.`;
    setArm(tr, arm.key, {
      cls: r.skewed ? 'is-skewed' : 'is-ok',
      mean: r.mean.toFixed(3),
      sd: Number.isFinite(r.sd) ? r.sd.toFixed(3) : '–',
      flag: r.skewed ? 'skewed' : '',
      title: `${methods} ${r.skewed ? 'Significantly skewed (Shi et al. 2023): normal-based estimates not recommended.' : 'No significant skewness (Shi et al. 2023).'}`,
    });
  }
}

const FIELD_HEADS = ['n', 'Median', 'Q1', 'Q3', 'Min', 'Max', 'Mean', 'SD', 'Skewness'];

function outValue(tr, arm, out) {
  const cell = tr.querySelector(`[data-arm="${arm}"][data-out="${out}"]`);
  const text = cell.querySelector('output').textContent;
  const value = Number(text);
  return Number.isFinite(value) ? value : '';
}

function skewLabel(tr, arm) {
  const cell = tr.querySelector(`[data-arm="${arm}"][data-out="sd"]`);
  if (cell.classList.contains('is-skewed')) return 'Skewed';
  if (cell.classList.contains('is-ok')) return 'Not skewed';
  if (cell.classList.contains('is-error')) return 'Check values';
  return '';
}

/** The table as it stands: two header rows, then one row per study, numbers kept as numbers. */
function tableRows() {
  const head1 = ['Study'];
  const head2 = ['Study'];
  for (const arm of ARMS) {
    head1.push(arm.key === 'int' ? 'Intervention' : 'Control', ...Array(FIELD_HEADS.length - 1).fill(''));
    head2.push(...FIELD_HEADS);
  }
  head1[0] = '';
  const body = [...rows.rows].map((tr) => {
    const line = [tr.querySelector('[data-k="study"]').value.trim()];
    for (const arm of ARMS) {
      const v = readArm(tr, arm.key);
      for (const f of INPUTS) line.push(Number.isFinite(v[f.key]) ? v[f.key] : '');
      line.push(outValue(tr, arm.key, 'mean'), outValue(tr, arm.key, 'sd'), skewLabel(tr, arm.key));
    }
    return line;
  });
  return [head1, head2, ...body];
}

const status = document.getElementById('m2m-status');
let statusTimer = 0;

function say(message) {
  status.textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    status.textContent = '';
  }, 4000);
}

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

document.getElementById('m2m-export').addEventListener('click', () => {
  downloadBlob(rowsToXlsxBlob(tableRows(), 'Median to mean'), `median-to-mean-${stamp()}.xlsx`);
  say('Workbook downloaded.');
});

document.getElementById('m2m-copy').addEventListener('click', async () => {
  const ok = await copyText(rowsToTsv(tableRows()));
  say(ok ? 'Table copied. Paste it into a spreadsheet.' : 'Could not copy in this browser.');
});

rows.addEventListener('input', (event) => {
  const tr = event.target.closest('tr');
  if (tr) computeRow(tr);
});
rows.addEventListener('click', (event) => {
  const button = event.target.closest('.calc-remove');
  if (!button || button.disabled) return;
  const tr = button.closest('tr');
  const next = tr.nextElementSibling || tr.previousElementSibling;
  tr.remove();
  renumber();
  next?.querySelector('input')?.focus();
});
document.getElementById('m2m-add').addEventListener('click', () => addRow());

addRow(false);
addRow(false);
addRow(false);
