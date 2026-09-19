import { medianToMean } from './calc.js';

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
