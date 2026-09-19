import { combineGroups } from './calc.js';

const rows = document.getElementById('comb-rows');
const message = document.getElementById('comb-message');
const result = document.getElementById('comb-result');
const steps = document.getElementById('comb-steps');
const fmt = (x, digits = 4) => (Number.isInteger(x) ? String(x) : x.toFixed(digits));

function addRow(focus = true) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <th scope="row"></th>
    <td><input type="number" inputmode="decimal" step="any" min="0" data-k="n"></td>
    <td><input type="number" inputmode="decimal" step="any" data-k="mean"></td>
    <td><input type="number" inputmode="decimal" step="any" min="0" data-k="sd"></td>
    <td><button type="button" class="calc-remove">Remove</button></td>`;
  rows.appendChild(tr);
  renumber();
  if (focus) tr.querySelector('input').focus();
}

// Labels follow the row order after an add or a delete.
function renumber() {
  const all = [...rows.rows];
  all.forEach((tr, i) => {
    const g = i + 1;
    tr.querySelector('th').textContent = String(g);
    tr.querySelector('[data-k="n"]').setAttribute('aria-label', `Group ${g} sample size`);
    tr.querySelector('[data-k="mean"]').setAttribute('aria-label', `Group ${g} mean`);
    tr.querySelector('[data-k="sd"]').setAttribute('aria-label', `Group ${g} SD`);
    const remove = tr.querySelector('.calc-remove');
    remove.setAttribute('aria-label', `Remove group ${g}`);
    remove.disabled = all.length === 1;
  });
  render();
}

function read(tr, k) {
  const v = tr.querySelector(`[data-k="${k}"]`).value.trim();
  return v === '' ? NaN : Number(v);
}

function render() {
  const groups = [...rows.rows].map((tr) => ({ n: read(tr, 'n'), mean: read(tr, 'mean'), sd: read(tr, 'sd') }));
  const r = combineGroups(groups);
  if (!r.result) {
    result.hidden = true;
    steps.hidden = true;
    message.textContent = 'Fill in at least one group (sample size, mean and SD).';
    return;
  }
  const used = r.steps.length;
  message.textContent = `Combined ${used} group${used === 1 ? '' : 's'}` +
    (r.skipped ? `; ${r.skipped} incomplete group${r.skipped === 1 ? '' : 's'} skipped.` : '.');
  result.querySelector('[data-k="n"]').textContent = fmt(r.result.n);
  result.querySelector('[data-k="mean"]').textContent = fmt(r.result.mean);
  result.querySelector('[data-k="sd"]').textContent = fmt(r.result.sd);
  steps.tBodies[0].innerHTML = r.steps
    .map((s) => `<tr><td>${s.index + 1}</td><td>${fmt(s.n)}</td><td>${fmt(s.mean)}</td><td>${fmt(s.sd)}</td></tr>`)
    .join('');
  result.hidden = false;
  steps.hidden = used < 2;
}

rows.addEventListener('input', render);
rows.addEventListener('click', (event) => {
  const button = event.target.closest('.calc-remove');
  if (!button || button.disabled) return;
  const tr = button.closest('tr');
  const next = tr.nextElementSibling || tr.previousElementSibling;
  tr.remove();
  renumber();
  next?.querySelector('input')?.focus();
});
document.getElementById('comb-add').addEventListener('click', () => addRow());

addRow(false);
addRow(false);
