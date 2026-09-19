import { diagnostic } from './calc.js';

const $ = (id) => document.getElementById(id);
const num = (id) => {
  const v = $(id).value.trim();
  return v === '' ? NaN : Number(v);
};
const count = (x) => (Math.abs(x - Math.round(x)) < 1e-9 ? String(Math.round(x)) : x.toFixed(1));
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'not defined');
const ratio = (x) => (Number.isFinite(x) ? x.toFixed(2) : 'not defined');

function render() {
  const values = [num('sens'), num('spec'), num('diseased'), num('prev')];
  const table = $('diag-table');
  const stats = $('diag-stats');
  const message = $('diag-message');
  if (values.some(Number.isNaN)) {
    table.hidden = true;
    stats.hidden = true;
    message.textContent = 'Fill in the four inputs to build the table.';
    return;
  }
  const [sens, spec, diseased, prev] = values;
  const r = diagnostic({ sensitivity: sens / 100, specificity: spec / 100, diseased, prevalence: prev / 100 });
  if (r.errors.length) {
    table.hidden = true;
    stats.hidden = true;
    message.textContent = r.errors.join(' ');
    return;
  }
  message.textContent = `Total population: ${count(r.total)}.`;
  table.querySelectorAll('[data-k]').forEach((cell) => {
    cell.textContent = count(r[cell.dataset.k]);
  });
  const fmt = { ppv: pct, npv: pct, accuracy: pct, lrPositive: ratio, lrNegative: ratio };
  stats.querySelectorAll('[data-k]').forEach((dd) => {
    dd.textContent = fmt[dd.dataset.k](r[dd.dataset.k]);
  });
  table.hidden = false;
  stats.hidden = false;
}

$('diag-form').addEventListener('input', render);
render();
