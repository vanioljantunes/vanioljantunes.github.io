import { diagnostic } from './calc.js';

const $ = (id) => document.getElementById(id);
const num = (id) => {
  const v = $(id).value.trim();
  return v === '' ? NaN : Number(v);
};
const count = (x) => (Math.abs(x - Math.round(x)) < 1e-9 ? String(Math.round(x)) : x.toFixed(1));

function render() {
  const values = [num('sens'), num('spec'), num('diseased'), num('prev')];
  const tree = $('diag-tree');
  const message = $('diag-message');
  if (values.some(Number.isNaN)) {
    tree.hidden = true;
    message.hidden = false;
    message.textContent = 'Fill in the four inputs to build the matrix.';
    return;
  }
  const [sens, spec, diseased, prev] = values;
  const r = diagnostic({ sensitivity: sens / 100, specificity: spec / 100, diseased, prevalence: prev / 100 });
  if (r.errors.length) {
    tree.hidden = true;
    message.hidden = false;
    message.textContent = r.errors.join(' ');
    return;
  }
  tree.querySelectorAll('[data-k]').forEach((el) => {
    el.textContent = count(r[el.dataset.k]);
  });
  message.hidden = true;
  tree.hidden = false;
}

$('diag-form').addEventListener('input', render);
render();
