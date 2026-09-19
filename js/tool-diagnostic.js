import { diagnostic } from './calc.js';

const $ = (id) => document.getElementById(id);
const num = (id) => {
  const v = $(id).value.trim();
  return v === '' ? NaN : Number(v);
};
const count = (x) => (Math.abs(x - Math.round(x)) < 1e-9 ? String(Math.round(x)) : x.toFixed(1));
const values = () => $('diag-tree').querySelectorAll('[data-k]');

function clear(text) {
  values().forEach((el) => {
    el.textContent = '–';
    el.classList.add('is-empty');
  });
  $('diag-message').textContent = text;
}

$('diag-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = [num('sens'), num('spec'), num('diseased'), num('total')];
  if (input.some(Number.isNaN)) {
    clear('Fill in all four inputs, then press Calculate.');
    return;
  }
  const [sens, spec, diseased, total] = input;
  const r = diagnostic({ sensitivity: sens / 100, specificity: spec / 100, diseased, total });
  if (r.errors.length) {
    clear(r.errors.join(' '));
    return;
  }
  values().forEach((el) => {
    el.textContent = count(r[el.dataset.k]);
    el.classList.remove('is-empty');
  });
  $('diag-message').textContent = 'Calculated.';
});
