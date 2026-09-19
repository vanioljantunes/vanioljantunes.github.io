import { medianToMean } from './calc.js';

const FIELDS = { 1: ['min', 'median', 'max'], 2: ['q1', 'median', 'q3'], 3: ['min', 'q1', 'median', 'q3', 'max'] };

document.querySelectorAll('[data-scenario]').forEach((section) => {
  const k = Number(section.dataset.scenario);
  const message = section.querySelector('.calc-message');
  const result = section.querySelector('.calc-stats');
  const read = (name) => {
    const v = document.getElementById(`s${k}-${name}`).value.trim();
    return v === '' ? NaN : Number(v);
  };

  const render = () => {
    const names = ['n', ...FIELDS[k]];
    const values = Object.fromEntries(names.map((name) => [name, read(name)]));
    if (names.some((name) => Number.isNaN(values[name]))) {
      result.hidden = true;
      message.textContent = 'Fill in all values.';
      message.classList.remove('is-warning');
      return;
    }
    const r = medianToMean(k, values);
    if (r.error) {
      result.hidden = true;
      message.textContent = r.error;
      message.classList.remove('is-warning');
      return;
    }
    result.querySelector('[data-k="mean"]').textContent = r.mean.toFixed(4);
    result.querySelector('[data-k="sd"]').textContent = Number.isFinite(r.sd) ? r.sd.toFixed(4) : 'not defined';
    result.hidden = false;
    message.textContent = r.skewed
      ? 'By Shi et al. (2023), the data are significantly skewed away from normality. The normal-based estimates below are not recommended.'
      : 'By Shi et al. (2023), there is no significant evidence of skewness.';
    message.classList.toggle('is-warning', r.skewed);
  };

  section.querySelector('form').addEventListener('input', render);
  render();
});
