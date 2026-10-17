// Page script for /tools/robvis/. Four steps: pick the instrument, name the studies, answer
// the signalling questions, read the table and take the figure away. Everything is held in
// one state object, mirrored to localStorage so a closed tab does not lose an afternoon.

import {
  ANSWER_SETS,
  INSTRUMENTS,
  LEVELS,
  getInstrument,
  isQuestionActive,
  resolveDomain,
} from './rob-instruments.js';
import { robDocxBlob } from './rob-docx.js';
import { svgBlob, svgToPngBlob, trafficLightSvg } from './rob-traffic.js';
import { copyText, downloadBlob, rowsToTsv } from './xlsx.js';

const STORE_KEY = 'robvis.v1';
const STEPS = ['Instrument', 'Studies', 'Assessment', 'Figure and table'];

const state = {
  step: 1,
  instrument: '',
  domainOnly: false,
  studies: [],
  openDomain: '',
  options: { includeOverall: true, showWords: false, title: '' },
};

let nextStudyId = 1;

const el = (id) => document.getElementById(id);
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function instrument() {
  return getInstrument(state.instrument);
}

// --- persistence ------------------------------------------------------------

function save() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        instrument: state.instrument,
        domainOnly: state.domainOnly,
        studies: state.studies,
        options: state.options,
      }),
    );
  } catch {
    // A private window, or storage turned off. The page still works, it just forgets.
  }
}

function restore() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch {
    saved = null;
  }
  if (!saved || !getInstrument(saved.instrument) || !Array.isArray(saved.studies) || !saved.studies.length) {
    return false;
  }
  state.instrument = saved.instrument;
  state.domainOnly = Boolean(saved.domainOnly);
  state.studies = saved.studies.map((study, index) => ({
    id: study.id || `s${index + 1}`,
    name: String(study.name || ''),
    answers: study.answers && typeof study.answers === 'object' ? study.answers : {},
    overrides: study.overrides && typeof study.overrides === 'object' ? study.overrides : {},
    notes: study.notes && typeof study.notes === 'object' ? study.notes : {},
  }));
  nextStudyId = state.studies.length + 1;
  state.options = { ...state.options, ...(saved.options || {}) };
  return true;
}

// --- model helpers ----------------------------------------------------------

function addStudy(name = '') {
  state.studies.push({ id: `s${nextStudyId++}`, name, answers: {}, overrides: {}, notes: {} });
}

function namedStudies() {
  return state.studies.filter((study) => study.name.trim());
}

/** Judgement per domain plus the overall column, for one study. */
function studyJudgements(study) {
  const tool = instrument();
  const cells = tool.domains.map((domain) => {
    if (state.domainOnly) {
      const level = (study.overrides && study.overrides[domain.id]) || '';
      return { domain, level, suggested: '', overridden: false, state: level ? 'complete' : 'empty' };
    }
    return { domain, ...resolveDomain(domain, study) };
  });
  const byId = {};
  for (const item of cells) {
    if (item.level) byId[item.domain.id] = item.level;
  }
  const overallOverride = study.overrides && study.overrides.overall;
  const suggestedOverall = Object.keys(byId).length === tool.domains.length ? tool.overall(byId) : '';
  return {
    cells,
    overall: {
      level: overallOverride || suggestedOverall,
      suggested: suggestedOverall,
      overridden: Boolean(overallOverride) && overallOverride !== suggestedOverall,
    },
  };
}

function figureRows() {
  return namedStudies().map((study) => {
    const { cells, overall } = studyJudgements(study);
    return {
      study: study.name.trim(),
      cells: cells.map((item) => ({ level: item.level, label: item.level ? LEVELS[item.level].label : '' })),
      overall: { level: overall.level, label: overall.level ? LEVELS[overall.level].label : '' },
    };
  });
}

function dataRows() {
  const tool = instrument();
  const header = ['Study', ...tool.domains.map((d) => d.id)];
  if (state.options.includeOverall) header.push('Overall');
  const body = figureRows().map((row) => {
    const cells = [row.study, ...row.cells.map((c) => (c.level ? LEVELS[c.level].data : ''))];
    if (state.options.includeOverall) cells.push(row.overall.level ? LEVELS[row.overall.level].data : '');
    return cells;
  });
  return [header, ...body];
}

function completeness() {
  const tool = instrument();
  const studies = namedStudies();
  let filled = 0;
  for (const study of studies) {
    const { cells } = studyJudgements(study);
    filled += cells.filter((item) => item.level).length;
  }
  return { filled, total: studies.length * tool.domains.length };
}

// --- step 1: instrument -----------------------------------------------------

function renderInstruments() {
  const list = el('rv-instruments');
  list.textContent = '';
  for (const tool of INSTRUMENTS) {
    const item = make('li');
    const button = make('button', 'rv-pick');
    button.type = 'button';
    button.dataset.instrument = tool.id;
    if (state.instrument === tool.id) {
      button.classList.add('is-chosen');
      button.setAttribute('aria-pressed', 'true');
    } else {
      button.setAttribute('aria-pressed', 'false');
    }
    const name = make('span', 'rv-pick__name', tool.name);
    if (tool.alsoCalled) name.append(make('span', 'rv-pick__alias', tool.alsoCalled));
    button.append(name);
    button.append(make('span', 'rv-pick__designs', tool.designs));
    button.append(make('span', 'rv-pick__blurb', tool.blurb));
    const questions = tool.domains.reduce((n, d) => n + d.questions.length, 0);
    button.append(make('span', 'rv-pick__meta', `${tool.domains.length} domains, ${questions} signalling questions`));
    item.append(button);
    list.append(item);
  }
}

// --- step 2: studies --------------------------------------------------------

function renderStudies() {
  const body = el('rv-study-rows');
  body.textContent = '';
  state.studies.forEach((study, index) => {
    const row = make('tr');
    const number = make('th', 'rv-study-n', String(index + 1));
    number.scope = 'row';
    row.append(number);

    const nameCell = make('td');
    const input = make('input', 'rv-input');
    input.type = 'text';
    input.value = study.name;
    input.placeholder = 'Author year, for example Oliveira 2021';
    input.dataset.field = 'study-name';
    input.dataset.id = study.id;
    input.setAttribute('aria-label', `Name of study ${index + 1}`);
    nameCell.append(input);
    row.append(nameCell);

    const removeCell = make('td', 'rv-study-remove');
    const remove = make('button', 'calc-remove');
    remove.type = 'button';
    remove.dataset.action = 'remove-study';
    remove.dataset.id = study.id;
    remove.setAttribute('aria-label', `Remove study ${index + 1}`);
    remove.textContent = '×';
    removeCell.append(remove);
    row.append(removeCell);
    body.append(row);
  });
  el('rv-study-count').textContent = `${namedStudies().length} named`;
}

// --- step 3: assessment -----------------------------------------------------

function answerSelect({ value, options, blankLabel, dataset, label, disabled }) {
  const select = make('select', 'rv-select');
  const blank = make('option', '', blankLabel);
  blank.value = '';
  select.append(blank);
  for (const option of options) {
    const node = make('option', '', option.label);
    node.value = option.v;
    if (option.v === value) node.selected = true;
    select.append(node);
  }
  Object.assign(select.dataset, dataset);
  if (label) select.setAttribute('aria-label', label);
  if (disabled) select.disabled = true;
  return select;
}

function judgementPill(level, { suggested, overridden } = {}) {
  const wrap = make('span', 'rv-pill');
  if (!level) {
    wrap.classList.add('is-empty');
    wrap.textContent = 'Not judged';
    return wrap;
  }
  const meta = LEVELS[level];
  wrap.classList.add(`is-${level}`);
  wrap.append(make('span', 'rv-pill__mark', meta.symbol));
  wrap.append(make('span', 'rv-pill__text', meta.label));
  if (overridden && suggested) {
    const tag = make('span', 'rv-pill__tag', 'overridden');
    tag.title = `The algorithm suggested ${LEVELS[suggested].label.toLowerCase()}.`;
    wrap.append(tag);
  }
  return wrap;
}

function renderDomainOnly() {
  const tool = instrument();
  const host = el('rv-assessment');
  host.textContent = '';
  const wrap = make('div', 'calc-table-wrap');
  const table = make('table', 'calc-table rv-grid');
  const head = make('thead');
  const headRow = make('tr');
  const studyHead = make('th', '', 'Study');
  studyHead.scope = 'col';
  headRow.append(studyHead);
  for (const domain of tool.domains) {
    const cell = make('th', '', domain.id);
    cell.scope = 'col';
    cell.title = domain.full;
    headRow.append(cell);
  }
  const overallHead = make('th', '', 'Overall');
  overallHead.scope = 'col';
  headRow.append(overallHead);
  head.append(headRow);
  table.append(head);

  const body = make('tbody');
  for (const study of namedStudies()) {
    const row = make('tr');
    const name = make('th', 'rv-grid__study', study.name.trim());
    name.scope = 'row';
    row.append(name);
    for (const domain of tool.domains) {
      const cell = make('td');
      cell.append(
        answerSelect({
          value: (study.overrides && study.overrides[domain.id]) || '',
          options: tool.levels.map((key) => ({ v: key, label: LEVELS[key].label })),
          blankLabel: 'Not judged',
          dataset: { field: 'judgement', id: study.id, domain: domain.id },
          label: `${domain.full} for ${study.name.trim()}`,
        }),
      );
      row.append(cell);
    }
    const { overall } = studyJudgements(study);
    const overallCell = make('td');
    overallCell.append(
      answerSelect({
        value: (study.overrides && study.overrides.overall) || '',
        options: tool.levels.map((key) => ({ v: key, label: LEVELS[key].label })),
        blankLabel: overall.suggested ? `From domains: ${LEVELS[overall.suggested].label}` : 'Not judged',
        dataset: { field: 'judgement', id: study.id, domain: 'overall' },
        label: `Overall judgement for ${study.name.trim()}`,
      }),
    );
    row.append(overallCell);
    body.append(row);
  }
  table.append(body);
  wrap.append(table);
  host.append(wrap);
  host.append(
    make(
      'p',
      'calc-note',
      'Leave the overall cell blank to take it from the domains. Turn the switch off to answer the signalling questions instead; judgements you typed here are kept either way.',
    ),
  );
}

function renderQuestions() {
  const tool = instrument();
  const studies = namedStudies();
  const host = el('rv-assessment');
  host.textContent = '';
  if (!state.openDomain || !tool.domains.some((d) => d.id === state.openDomain)) {
    state.openDomain = tool.domains[0].id;
  }

  const tabs = make('div', 'rv-domain-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Domains');
  for (const domain of tool.domains) {
    const button = make('button', 'rv-domain-tab');
    button.type = 'button';
    button.dataset.action = 'open-domain';
    button.dataset.domain = domain.id;
    button.setAttribute('role', 'tab');
    const open = domain.id === state.openDomain;
    button.setAttribute('aria-selected', open ? 'true' : 'false');
    if (open) button.classList.add('is-open');
    button.append(make('span', 'rv-domain-tab__id', domain.id));
    button.append(make('span', 'rv-domain-tab__label', domain.label));
    const judged = studies.filter((study) => resolveDomain(domain, study).level).length;
    const count = make('span', 'rv-domain-tab__count', `${judged}/${studies.length}`);
    if (judged === studies.length && studies.length) count.classList.add('is-done');
    button.append(count);
    tabs.append(button);
  }
  host.append(tabs);

  const domain = tool.domains.find((d) => d.id === state.openDomain);
  const panel = make('section', 'rv-domain');
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-label', domain.full);
  panel.append(make('h3', 'rv-domain__title', `${domain.id}. ${domain.full}`));

  const wrap = make('div', 'calc-table-wrap');
  const table = make('table', 'calc-table rv-questions');
  const head = make('thead');
  const headRow = make('tr');
  const qHead = make('th', 'rv-questions__q', 'Signalling question');
  qHead.scope = 'col';
  headRow.append(qHead);
  for (const study of studies) {
    const cell = make('th', 'rv-questions__study', study.name.trim());
    cell.scope = 'col';
    headRow.append(cell);
  }
  head.append(headRow);
  table.append(head);

  const body = make('tbody');
  const options = ANSWER_SETS[tool.answerSet];
  for (const question of domain.questions) {
    const row = make('tr');
    const label = make('th', 'rv-questions__q');
    label.scope = 'row';
    label.append(make('span', 'rv-q-id', question.id));
    label.append(make('span', 'rv-q-text', question.text));
    row.append(label);
    for (const study of studies) {
      const answers = (study.answers && study.answers[domain.id]) || {};
      const active = isQuestionActive(question, answers);
      const cell = make('td', active ? '' : 'is-inactive');
      cell.append(
        answerSelect({
          value: answers[question.id] || '',
          options,
          blankLabel: active ? '—' : 'Not applicable',
          dataset: { field: 'answer', id: study.id, domain: domain.id, question: question.id },
          label: `Question ${question.id} for ${study.name.trim()}`,
          disabled: !active,
        }),
      );
      row.append(cell);
    }
    body.append(row);
  }

  if (tool.hasApplicability && domain.applicability) {
    const row = make('tr', 'rv-questions__applicability');
    const label = make('th', 'rv-questions__q');
    label.scope = 'row';
    label.append(make('span', 'rv-q-id', 'App.'));
    label.append(make('span', 'rv-q-text', domain.applicability));
    row.append(label);
    for (const study of studies) {
      const cell = make('td');
      cell.append(
        answerSelect({
          value: (study.notes && study.notes[`app-${domain.id}`]) || '',
          options: ['low', 'high', 'unclear'].map((key) => ({ v: key, label: LEVELS[key].label })),
          blankLabel: '—',
          dataset: { field: 'applicability', id: study.id, domain: domain.id },
          label: `Applicability concern, ${domain.label}, ${study.name.trim()}`,
        }),
      );
      row.append(cell);
    }
    body.append(row);
  }

  const judgementRow = make('tr', 'rv-questions__judgement');
  const judgementLabel = make('th', 'rv-questions__q');
  judgementLabel.scope = 'row';
  judgementLabel.append(make('span', 'rv-q-text', 'Domain judgement'));
  judgementRow.append(judgementLabel);
  for (const study of studies) {
    const resolved = resolveDomain(domain, study);
    const cell = make('td', 'rv-judge-cell');
    cell.append(judgementPill(resolved.level, resolved));
    if (resolved.state === 'partial') {
      cell.append(make('span', 'rv-judge-cell__partial', `${resolved.answered} of ${resolved.active} answered`));
    }
    cell.append(
      answerSelect({
        value: (study.overrides && study.overrides[domain.id]) || '',
        options: tool.levels.map((key) => ({ v: key, label: LEVELS[key].label })),
        blankLabel: resolved.suggested ? `Keep: ${LEVELS[resolved.suggested].label}` : 'Not judged',
        dataset: { field: 'judgement', id: study.id, domain: domain.id },
        label: `Override the judgement for ${domain.full}, ${study.name.trim()}`,
      }),
    );
    judgementRow.append(cell);
  }
  body.append(judgementRow);
  table.append(body);
  wrap.append(table);
  panel.append(wrap);

  const note = make('p', 'calc-note');
  note.textContent = tool.algorithmIsOfficial
    ? 'The suggested judgement is the algorithm published with the tool. Override it when your reading of the study says otherwise.'
    : `${tool.name} publishes no judgement algorithm. The suggestion here reads the tool's guidance and is a starting point, not an answer; override it freely.`;
  panel.append(note);

  const nav = make('div', 'rv-domain-nav');
  const index = tool.domains.findIndex((d) => d.id === domain.id);
  if (index > 0) {
    const previous = make('button', 'calc-button', `Back to ${tool.domains[index - 1].id}`);
    previous.type = 'button';
    previous.dataset.action = 'open-domain';
    previous.dataset.domain = tool.domains[index - 1].id;
    nav.append(previous);
  }
  if (index < tool.domains.length - 1) {
    const next = make('button', 'calc-button calc-button--primary', `Next domain: ${tool.domains[index + 1].label}`);
    next.type = 'button';
    next.dataset.action = 'open-domain';
    next.dataset.domain = tool.domains[index + 1].id;
    nav.append(next);
  }
  panel.append(nav);
  host.append(panel);
}

function renderAssessment() {
  if (!instrument() || !namedStudies().length) return;
  el('rv-domain-only').checked = state.domainOnly;
  if (state.domainOnly) renderDomainOnly();
  else renderQuestions();
  const { filled, total } = completeness();
  el('rv-assessment-progress').textContent = total
    ? `${filled} of ${total} domain judgements made`
    : 'No studies named yet';
}

// --- step 4: figure and table ----------------------------------------------

function currentSvg() {
  const tool = instrument();
  return trafficLightSvg({
    rows: figureRows(),
    columns: tool.domains.map((d) => ({ id: d.id, label: d.label })),
    title: state.options.title.trim(),
    includeOverall: state.options.includeOverall,
    legendLevels: tool.levels,
  });
}

function renderResults() {
  const tool = instrument();
  if (!tool) return;
  const rows = dataRows();
  const head = el('rv-data-head');
  head.textContent = '';
  const headRow = make('tr');
  rows[0].forEach((text, index) => {
    const cell = make('th', '', text);
    cell.scope = 'col';
    if (index > 0 && index <= tool.domains.length) cell.title = tool.domains[index - 1].full;
    headRow.append(cell);
  });
  head.append(headRow);

  const body = el('rv-data-rows');
  body.textContent = '';
  for (const row of rows.slice(1)) {
    const tr = make('tr');
    row.forEach((value, index) => {
      if (index === 0) {
        const th = make('th', 'rv-grid__study', value);
        th.scope = 'row';
        tr.append(th);
        return;
      }
      const td = make('td', 'rv-data__cell');
      if (value) {
        const key = Object.keys(LEVELS).find((k) => LEVELS[k].data === value);
        if (key) td.classList.add(`is-${key}`);
      }
      td.textContent = value || '—';
      tr.append(td);
    });
    body.append(tr);
  }

  const figure = el('rv-figure');
  figure.textContent = '';
  if (!rows.slice(1).length) {
    figure.append(make('p', 'calc-note', 'Name at least one study to draw the figure.'));
  } else {
    figure.innerHTML = currentSvg();
  }

  const note = el('rv-overall-note');
  const judgements = {};
  for (const row of figureRows()) {
    row.cells.forEach((cell, index) => {
      if (cell.level) judgements[tool.domains[index].id] = cell.level;
    });
  }
  const text = typeof tool.overallNote === 'function' ? tool.overallNote(judgements) : '';
  note.textContent = text;
  note.hidden = !text;
}

// --- step plumbing ----------------------------------------------------------

function stepReady(step) {
  if (step <= 1) return true;
  if (step === 2) return Boolean(instrument());
  return Boolean(instrument()) && namedStudies().length > 0;
}

function renderStepper() {
  const list = el('rv-stepper');
  list.textContent = '';
  STEPS.forEach((label, index) => {
    const step = index + 1;
    const item = make('li');
    const button = make('button', 'rv-step');
    button.type = 'button';
    button.dataset.action = 'goto';
    button.dataset.step = String(step);
    if (step === state.step) button.classList.add('is-current');
    if (!stepReady(step)) {
      button.disabled = true;
      button.classList.add('is-locked');
    }
    button.setAttribute('aria-current', step === state.step ? 'step' : 'false');
    button.append(make('span', 'rv-step__n', String(step)));
    button.append(make('span', 'rv-step__label', label));
    item.append(button);
    list.append(item);
  });
}

function go(step) {
  if (!stepReady(step)) return;
  state.step = step;
  render();
  const panel = el(`rv-step-${step}`);
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function render() {
  renderStepper();
  for (let step = 1; step <= STEPS.length; step += 1) {
    el(`rv-step-${step}`).hidden = step !== state.step;
  }
  if (state.step === 1) renderInstruments();
  if (state.step === 2) {
    renderStudies();
    const tool = instrument();
    el('rv-studies-for').textContent = tool ? `${tool.name}: ${tool.longName}` : '';
  }
  if (state.step === 3) renderAssessment();
  if (state.step === 4) renderResults();
}

function status(message) {
  const node = el('rv-status');
  node.textContent = message;
  if (message) {
    clearTimeout(status.timer);
    status.timer = setTimeout(() => {
      node.textContent = '';
    }, 5000);
  }
}

// --- events -----------------------------------------------------------------

function findStudy(id) {
  return state.studies.find((study) => study.id === id);
}

function onClick(event) {
  const target = event.target.closest('button');
  if (!target) return;

  if (target.dataset.instrument) {
    state.instrument = target.dataset.instrument;
    state.openDomain = '';
    if (!state.studies.length) {
      addStudy();
      addStudy();
      addStudy();
    }
    save();
    go(2);
    return;
  }

  const action = target.dataset.action;
  if (!action) return;

  if (action === 'goto') go(Number(target.dataset.step));
  if (action === 'next') go(state.step + 1);
  if (action === 'back') go(state.step - 1);
  if (action === 'open-domain') {
    state.openDomain = target.dataset.domain;
    renderAssessment();
  }
  if (action === 'add-study') {
    addStudy();
    renderStudies();
    save();
    const inputs = el('rv-study-rows').querySelectorAll('input');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }
  if (action === 'remove-study') {
    state.studies = state.studies.filter((study) => study.id !== target.dataset.id);
    if (!state.studies.length) addStudy();
    renderStudies();
    renderStepper();
    save();
  }
  if (action === 'paste-studies') {
    const names = el('rv-paste')
      .value.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!names.length) {
      status('Paste one study name per line first.');
      return;
    }
    state.studies = state.studies.filter((study) => study.name.trim());
    for (const name of names) addStudy(name);
    el('rv-paste').value = '';
    renderStudies();
    renderStepper();
    save();
    status(`${names.length} ${names.length === 1 ? 'study' : 'studies'} added.`);
  }
  if (action === 'copy-table') {
    copyText(rowsToTsv(dataRows())).then((ok) =>
      status(ok ? 'Table copied. Paste it into a spreadsheet, or into robvis in R.' : 'The browser blocked the copy.'),
    );
  }
  if (action === 'download-svg') {
    downloadBlob(svgBlob(currentSvg()), `risk-of-bias-${state.instrument}.svg`);
    status('SVG saved.');
  }
  if (action === 'download-png') {
    svgToPngBlob(currentSvg(), 3)
      .then((blob) => {
        downloadBlob(blob, `risk-of-bias-${state.instrument}.png`);
        status('PNG saved at three times the on-screen size.');
      })
      .catch((error) => status(error.message));
  }
  if (action === 'download-docx') {
    const tool = instrument();
    const rows = figureRows();
    if (!rows.length) {
      status('Name at least one study first.');
      return;
    }
    const blob = robDocxBlob({
      rows,
      columns: tool.domains.map((d) => ({ id: d.id, label: d.full })),
      title: state.options.title.trim() || 'Risk of bias assessment',
      subtitle: `${tool.name}. ${tool.longName}. ${rows.length} ${rows.length === 1 ? 'study' : 'studies'}.`,
      includeOverall: state.options.includeOverall,
      showWords: state.options.showWords,
      legendLevels: tool.levels,
      note: typeof tool.overallNote === 'function' ? tool.overallNote({}) : '',
    });
    downloadBlob(blob, `risk-of-bias-${state.instrument}.docx`);
    status('Word file saved.');
  }
  if (action === 'reset') {
    if (!window.confirm('Clear the instrument, the studies and every judgement on this page?')) return;
    state.instrument = '';
    state.studies = [];
    state.domainOnly = false;
    state.openDomain = '';
    nextStudyId = 1;
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      // Nothing was stored in the first place.
    }
    go(1);
    status('Cleared.');
  }
}

function onChange(event) {
  const node = event.target;

  if (node.id === 'rv-domain-only') {
    state.domainOnly = node.checked;
    save();
    renderAssessment();
    return;
  }
  if (node.id === 'rv-include-overall') {
    state.options.includeOverall = node.checked;
    save();
    renderResults();
    return;
  }
  if (node.id === 'rv-show-words') {
    state.options.showWords = node.checked;
    save();
    return;
  }
  if (node.id === 'rv-title') {
    state.options.title = node.value;
    save();
    renderResults();
    return;
  }

  const field = node.dataset.field;
  if (!field) return;
  const study = findStudy(node.dataset.id);
  if (!study) return;

  if (field === 'study-name') {
    study.name = node.value;
    el('rv-study-count').textContent = `${namedStudies().length} named`;
    renderStepper();
    save();
    return;
  }
  if (field === 'answer') {
    const domainId = node.dataset.domain;
    study.answers[domainId] = study.answers[domainId] || {};
    if (node.value) study.answers[domainId][node.dataset.question] = node.value;
    else delete study.answers[domainId][node.dataset.question];
    save();
    renderAssessment();
    return;
  }
  if (field === 'judgement') {
    if (node.value) study.overrides[node.dataset.domain] = node.value;
    else delete study.overrides[node.dataset.domain];
    save();
    renderAssessment();
    return;
  }
  if (field === 'applicability') {
    const key = `app-${node.dataset.domain}`;
    if (node.value) study.notes[key] = node.value;
    else delete study.notes[key];
    save();
  }
}

function init() {
  const page = el('rv-app');
  if (!page) return;
  page.addEventListener('click', onClick);
  page.addEventListener('change', onChange);
  page.addEventListener('input', (event) => {
    if (event.target.dataset.field === 'study-name' || event.target.id === 'rv-title') onChange(event);
  });

  const hadWork = restore();
  state.step = 1;
  render();
  if (hadWork) {
    const resume = el('rv-resume');
    const tool = instrument();
    el('rv-resume-text').textContent = `${tool.name}, ${state.studies.length} ${
      state.studies.length === 1 ? 'study' : 'studies'
    } from an earlier visit on this browser.`;
    resume.hidden = false;
    el('rv-resume-go').addEventListener('click', () => go(3));
  }
}

init();
