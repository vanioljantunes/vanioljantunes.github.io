// Risk of bias instruments for /tools/robvis/: the domains, the signalling questions and the
// rules that turn answers into a suggested domain judgement. No DOM access here.
//
// RoB 2 follows the algorithm published with the Cochrane RoB 2 tool. ROBINS-I and QUADAS-2
// have no equivalent published algorithm, so the rules below encode those tools' guidance as
// a suggestion the assessor is expected to read and, where it is wrong, override.

/** Answer sets. The value is what gets stored; the label is what the dropdown shows. */
export const ANSWER_SETS = {
  ynni: [
    { v: 'Y', label: 'Yes' },
    { v: 'PY', label: 'Probably yes' },
    { v: 'PN', label: 'Probably no' },
    { v: 'N', label: 'No' },
    { v: 'NI', label: 'No information' },
  ],
  ynu: [
    { v: 'Y', label: 'Yes' },
    { v: 'N', label: 'No' },
    { v: 'U', label: 'Unclear' },
  ],
};

/**
 * How each judgement is drawn, in the plot and in the Word table. `data` is the word the
 * robvis R package expects in its input column, which is not always the label.
 */
export const LEVELS = {
  low: { label: 'Low risk', data: 'Low', symbol: '+', bg: '#2e7d32', fg: '#ffffff' },
  some: { label: 'Some concerns', data: 'Some concerns', symbol: '!', bg: '#efc000', fg: '#1c2430' },
  moderate: { label: 'Moderate risk', data: 'Moderate', symbol: '!', bg: '#efc000', fg: '#1c2430' },
  serious: { label: 'Serious risk', data: 'Serious', symbol: '−', bg: '#c62828', fg: '#ffffff' },
  critical: { label: 'Critical risk', data: 'Critical', symbol: '×', bg: '#7f1d1d', fg: '#ffffff' },
  high: { label: 'High risk', data: 'High', symbol: '−', bg: '#c62828', fg: '#ffffff' },
  unclear: { label: 'Unclear', data: 'Unclear', symbol: '?', bg: '#2b6cb0', fg: '#ffffff' },
  ni: { label: 'No information', data: 'No information', symbol: '?', bg: '#2b6cb0', fg: '#ffffff' },
  na: { label: 'Not applicable', data: 'NA', symbol: '–', bg: '#b5bcc6', fg: '#1c2430' },
};

const yes = (a) => a === 'Y' || a === 'PY';
const no = (a) => a === 'N' || a === 'PN';
const unknown = (a) => a === 'NI' || a === 'U' || !a;
/** "Yes, probably yes, or no information" - the branch condition the tools use. */
const yesOrNI = (a) => yes(a) || a === 'NI';
const noOrNI = (a) => no(a) || a === 'NI';

/** The worst of a set of judgements, by the order given. */
const worstOf = (order) => (levels) => {
  let worst = order[0];
  for (const level of levels) {
    if (order.indexOf(level) > order.indexOf(worst)) worst = level;
  }
  return worst;
};
const worstRob2 = worstOf(['low', 'some', 'high']);
const worstQuadas = worstOf(['low', 'unclear', 'high']);

// ---------------------------------------------------------------------------
// RoB 2 - randomized trials, effect of assignment to intervention
// ---------------------------------------------------------------------------

const ROB2 = {
  id: 'rob2',
  name: 'RoB 2',
  longName: 'Cochrane risk-of-bias tool for randomized trials, version 2',
  alsoCalled: 'sometimes written ROBINS-II',
  designs: 'Randomized trials',
  blurb:
    'Five domains, 22 signalling questions, for the effect of assignment to intervention. The suggested judgement is the algorithm published with the tool.',
  sourceLabel: 'RoB 2 guidance (riskofbias.info)',
  sourceUrl: 'https://www.riskofbias.info/welcome/rob-2-0-tool',
  answerSet: 'ynni',
  levels: ['low', 'some', 'high'],
  algorithmIsOfficial: true,
  domains: [
    {
      id: 'D1',
      label: 'Randomization process',
      full: 'Bias arising from the randomization process',
      questions: [
        { id: '1.1', text: 'Was the allocation sequence random?' },
        {
          id: '1.2',
          text: 'Was the allocation sequence concealed until participants were enrolled and assigned to interventions?',
        },
        {
          id: '1.3',
          text: 'Did baseline differences between intervention groups suggest a problem with the randomization process?',
        },
      ],
      judge(a) {
        if (no(a['1.1']) || no(a['1.2']) || yes(a['1.3'])) return 'high';
        if (yes(a['1.1']) && yes(a['1.2']) && no(a['1.3'])) return 'low';
        return 'some';
      },
    },
    {
      id: 'D2',
      label: 'Deviations from intended interventions',
      full: 'Bias due to deviations from intended interventions (effect of assignment to intervention)',
      questions: [
        { id: '2.1', text: 'Were participants aware of their assigned intervention during the trial?' },
        {
          id: '2.2',
          text: 'Were carers and people delivering the interventions aware of the assigned intervention during the trial?',
        },
        {
          id: '2.3',
          text: 'Were there deviations from the intended intervention that arose because of the experimental context?',
          when: (a) => yesOrNI(a['2.1']) || yesOrNI(a['2.2']),
        },
        {
          id: '2.4',
          text: 'Were these deviations likely to have affected the outcome?',
          when: (a) => yes(a['2.3']),
        },
        {
          id: '2.5',
          text: 'Were these deviations from intended intervention balanced between groups?',
          when: (a) => yesOrNI(a['2.4']),
        },
        {
          id: '2.6',
          text: 'Was an appropriate analysis used to estimate the effect of assignment to intervention?',
        },
        {
          id: '2.7',
          text: 'Was there potential for a substantial impact (on the result) of the failure to analyse participants in the group to which they were randomized?',
          when: (a) => noOrNI(a['2.6']),
        },
      ],
      judge(a) {
        let deviations;
        if ((no(a['2.1']) && no(a['2.2'])) || no(a['2.3']) || (yes(a['2.3']) && no(a['2.4']))) {
          deviations = 'low';
        } else if (no(a['2.5'])) {
          deviations = 'high';
        } else if (yes(a['2.5'])) {
          deviations = 'low';
        } else {
          deviations = 'some';
        }
        let analysis;
        if (yes(a['2.6'])) analysis = 'low';
        else if (no(a['2.6']) && yes(a['2.7'])) analysis = 'high';
        else analysis = 'some';
        return worstRob2([deviations, analysis]);
      },
    },
    {
      id: 'D3',
      label: 'Missing outcome data',
      full: 'Bias due to missing outcome data',
      questions: [
        {
          id: '3.1',
          text: 'Were data for this outcome available for all, or nearly all, participants randomized?',
        },
        {
          id: '3.2',
          text: 'Is there evidence that the result was not biased by missing outcome data?',
          when: (a) => noOrNI(a['3.1']),
        },
        {
          id: '3.3',
          text: 'Could missingness in the outcome depend on its true value?',
          when: (a) => no(a['3.2']),
        },
        {
          id: '3.4',
          text: 'Is it likely that missingness in the outcome depended on its true value?',
          when: (a) => yesOrNI(a['3.3']),
        },
      ],
      judge(a) {
        if (yes(a['3.1']) || yes(a['3.2']) || no(a['3.3'])) return 'low';
        if (yes(a['3.4'])) return 'high';
        return 'some';
      },
    },
    {
      id: 'D4',
      label: 'Measurement of the outcome',
      full: 'Bias in measurement of the outcome',
      questions: [
        { id: '4.1', text: 'Was the method of measuring the outcome inappropriate?' },
        {
          id: '4.2',
          text: 'Could measurement or ascertainment of the outcome have differed between intervention groups?',
        },
        {
          id: '4.3',
          text: 'Were outcome assessors aware of the intervention received by study participants?',
          when: (a) => noOrNI(a['4.1']) && noOrNI(a['4.2']),
        },
        {
          id: '4.4',
          text: 'Could assessment of the outcome have been influenced by knowledge of intervention received?',
          when: (a) => yesOrNI(a['4.3']),
        },
        {
          id: '4.5',
          text: 'Is it likely that assessment of the outcome was influenced by knowledge of intervention received?',
          when: (a) => yesOrNI(a['4.4']),
        },
      ],
      judge(a) {
        if (yes(a['4.1']) || yes(a['4.2']) || yes(a['4.5'])) return 'high';
        if (no(a['4.1']) && no(a['4.2']) && (no(a['4.3']) || no(a['4.4']))) return 'low';
        return 'some';
      },
    },
    {
      id: 'D5',
      label: 'Selection of the reported result',
      full: 'Bias in selection of the reported result',
      questions: [
        {
          id: '5.1',
          text: 'Were the data that produced this result analysed in accordance with a pre-specified analysis plan that was finalized before unblinded outcome data were available for analysis?',
        },
        {
          id: '5.2',
          text: 'Is the numerical result being assessed likely to have been selected, on the basis of the results, from multiple eligible outcome measurements within the outcome domain?',
        },
        {
          id: '5.3',
          text: 'Is the numerical result being assessed likely to have been selected, on the basis of the results, from multiple eligible analyses of the data?',
        },
      ],
      judge(a) {
        if (yes(a['5.2']) || yes(a['5.3'])) return 'high';
        if (yes(a['5.1']) && no(a['5.2']) && no(a['5.3'])) return 'low';
        return 'some';
      },
    },
  ],
  overall(judgements) {
    const values = Object.values(judgements).filter(Boolean);
    if (!values.length) return '';
    if (values.includes('high')) return 'high';
    if (values.includes('some')) return 'some';
    return 'low';
  },
  overallNote(judgements) {
    const concerns = Object.values(judgements).filter((j) => j === 'some').length;
    if (!Object.values(judgements).includes('high') && concerns >= 3) {
      return 'Some concerns in several domains. The guidance allows a high-risk overall judgement when the concerns together substantially lower confidence in the result.';
    }
    return '';
  },
};

// ---------------------------------------------------------------------------
// ROBINS-I - non-randomised studies of interventions
// ---------------------------------------------------------------------------

const ROBINS_I = {
  id: 'robins-i',
  name: 'ROBINS-I',
  longName: 'Risk Of Bias In Non-randomized Studies - of Interventions',
  alsoCalled: '',
  designs: 'Non-randomised studies of interventions',
  blurb:
    'Seven domains compared against a hypothetical target trial, judged low, moderate, serious or critical. The questions here are for the effect of assignment to intervention.',
  sourceLabel: 'ROBINS-I guidance (riskofbias.info)',
  sourceUrl: 'https://www.riskofbias.info/welcome/home',
  answerSet: 'ynni',
  levels: ['low', 'moderate', 'serious', 'critical', 'ni'],
  algorithmIsOfficial: false,
  domains: [
    {
      id: 'D1',
      label: 'Confounding',
      full: 'Bias due to confounding',
      questions: [
        { id: '1.1', text: 'Is there potential for confounding of the effect of intervention in this study?' },
        {
          id: '1.2',
          text: 'Was the analysis based on splitting follow-up time according to intervention received?',
          when: (a) => yes(a['1.1']),
        },
        {
          id: '1.3',
          text: 'Were intervention discontinuations or switches likely to be related to factors that are prognostic for the outcome?',
          when: (a) => yes(a['1.1']) && yes(a['1.2']),
        },
        {
          id: '1.4',
          text: 'Did the authors use an appropriate analysis method that controlled for all the important confounding domains?',
          when: (a) => yes(a['1.1']) && (noOrNI(a['1.2']) || no(a['1.3'])),
        },
        {
          id: '1.5',
          text: 'Were confounding domains that were controlled for measured validly and reliably by the variables available in this study?',
          when: (a) => yes(a['1.4']),
        },
        {
          id: '1.6',
          text: 'Did the authors control for any post-intervention variables that could have been affected by the intervention?',
          when: (a) => yes(a['1.1']) && (noOrNI(a['1.2']) || no(a['1.3'])),
        },
        {
          id: '1.7',
          text: 'Did the authors use an appropriate analysis method that controlled for all the important confounding domains and for time-varying confounding?',
          when: (a) => yes(a['1.2']) && yesOrNI(a['1.3']),
        },
        {
          id: '1.8',
          text: 'Were the time-varying confounding domains that were controlled for measured validly and reliably by the variables available in this study?',
          when: (a) => yes(a['1.7']),
        },
      ],
      judge(a) {
        if (no(a['1.1'])) return 'low';
        if (unknown(a['1.1'])) return 'ni';
        const timeVarying = yes(a['1.2']) && yesOrNI(a['1.3']);
        const controlled = timeVarying ? a['1.7'] : a['1.4'];
        const measured = timeVarying ? a['1.8'] : a['1.5'];
        if (no(controlled)) return 'critical';
        if (unknown(controlled)) return 'ni';
        if (yes(a['1.6'])) return 'serious';
        if (no(measured)) return 'serious';
        if (unknown(measured)) return 'moderate';
        return timeVarying ? 'moderate' : 'low';
      },
    },
    {
      id: 'D2',
      label: 'Selection of participants',
      full: 'Bias in selection of participants into the study',
      questions: [
        {
          id: '2.1',
          text: 'Was selection of participants into the study (or into the analysis) based on participant characteristics observed after the start of intervention?',
        },
        {
          id: '2.2',
          text: 'Were the post-intervention variables that influenced selection likely to be associated with intervention?',
          when: (a) => yes(a['2.1']),
        },
        {
          id: '2.3',
          text: 'Were the post-intervention variables that influenced selection likely to be influenced by the outcome or a cause of the outcome?',
          when: (a) => yes(a['2.2']),
        },
        { id: '2.4', text: 'Do start of follow-up and start of intervention coincide for most participants?' },
        {
          id: '2.5',
          text: 'Were adjustment techniques used that are likely to correct for the presence of selection biases?',
          when: (a) => (yes(a['2.2']) && yes(a['2.3'])) || no(a['2.4']),
        },
      ],
      judge(a) {
        const selectionBias = (yes(a['2.2']) && yes(a['2.3'])) || no(a['2.4']);
        if (!selectionBias) {
          if (no(a['2.1']) && yes(a['2.4'])) return 'low';
          if (unknown(a['2.1']) || unknown(a['2.4'])) return 'ni';
          return 'moderate';
        }
        if (yes(a['2.5'])) return 'moderate';
        if (unknown(a['2.5'])) return 'serious';
        return yes(a['2.2']) && yes(a['2.3']) && no(a['2.4']) ? 'critical' : 'serious';
      },
    },
    {
      id: 'D3',
      label: 'Classification of interventions',
      full: 'Bias in classification of interventions',
      questions: [
        { id: '3.1', text: 'Were intervention groups clearly defined?' },
        {
          id: '3.2',
          text: 'Was the information used to define intervention groups recorded at the start of the intervention?',
        },
        {
          id: '3.3',
          text: 'Could classification of intervention status have been affected by knowledge of the outcome or risk of the outcome?',
        },
      ],
      judge(a) {
        if (yes(a['3.3'])) return 'serious';
        if (no(a['3.1'])) return 'serious';
        if (no(a['3.2'])) return 'moderate';
        if (unknown(a['3.1']) || unknown(a['3.2']) || unknown(a['3.3'])) return 'ni';
        return 'low';
      },
    },
    {
      id: 'D4',
      label: 'Deviations from intended interventions',
      full: 'Bias due to deviations from intended interventions',
      questions: [
        {
          id: '4.1',
          text: 'Were there deviations from the intended intervention beyond what would be expected in usual practice?',
        },
        {
          id: '4.2',
          text: 'Were these deviations from intended intervention unbalanced between groups and likely to have affected the outcome?',
          when: (a) => yes(a['4.1']),
        },
      ],
      judge(a) {
        if (no(a['4.1'])) return 'low';
        if (unknown(a['4.1'])) return 'ni';
        if (yes(a['4.2'])) return 'serious';
        if (no(a['4.2'])) return 'low';
        return 'moderate';
      },
    },
    {
      id: 'D5',
      label: 'Missing data',
      full: 'Bias due to missing data',
      questions: [
        { id: '5.1', text: 'Were outcome data available for all, or nearly all, participants?' },
        { id: '5.2', text: 'Were participants excluded due to missing data on intervention status?' },
        {
          id: '5.3',
          text: 'Were participants excluded due to missing data on other variables needed for the analysis?',
        },
        {
          id: '5.4',
          text: 'Are the proportion of participants and reasons for missing data similar across interventions?',
          when: (a) => noOrNI(a['5.1']) || yesOrNI(a['5.2']) || yesOrNI(a['5.3']),
        },
        {
          id: '5.5',
          text: 'Is there evidence that results were robust to the presence of missing data?',
          when: (a) => noOrNI(a['5.1']) || yesOrNI(a['5.2']) || yesOrNI(a['5.3']),
        },
      ],
      judge(a) {
        const complete = yes(a['5.1']) && no(a['5.2']) && no(a['5.3']);
        if (complete) return 'low';
        if (unknown(a['5.1']) && unknown(a['5.2']) && unknown(a['5.3'])) return 'ni';
        if (yes(a['5.5'])) return 'low';
        if (yes(a['5.4'])) return 'moderate';
        if (no(a['5.4']) && no(a['5.5'])) return 'serious';
        return 'moderate';
      },
    },
    {
      id: 'D6',
      label: 'Measurement of outcomes',
      full: 'Bias in measurement of outcomes',
      questions: [
        { id: '6.1', text: 'Could the outcome measure have been influenced by knowledge of the intervention received?' },
        { id: '6.2', text: 'Were outcome assessors aware of the intervention received by study participants?' },
        { id: '6.3', text: 'Were the methods of outcome assessment comparable across intervention groups?' },
        {
          id: '6.4',
          text: 'Were any systematic errors in measurement of the outcome related to intervention received?',
        },
      ],
      judge(a) {
        if (yes(a['6.4']) || no(a['6.3'])) return 'serious';
        if (yes(a['6.1']) && yes(a['6.2'])) return 'serious';
        if (yes(a['6.1']) || yes(a['6.2'])) return 'moderate';
        if (unknown(a['6.1']) || unknown(a['6.2']) || unknown(a['6.3']) || unknown(a['6.4'])) return 'ni';
        return 'low';
      },
    },
    {
      id: 'D7',
      label: 'Selection of the reported result',
      full: 'Bias in selection of the reported result',
      questions: [
        {
          id: '7.1',
          text: 'Is the reported effect estimate likely to be selected, on the basis of the results, from multiple outcome measurements within the outcome domain?',
        },
        {
          id: '7.2',
          text: 'Is the reported effect estimate likely to be selected, on the basis of the results, from multiple analyses of the intervention-outcome relationship?',
        },
        {
          id: '7.3',
          text: 'Is the reported effect estimate likely to be selected, on the basis of the results, from different subgroups?',
        },
      ],
      judge(a) {
        const flags = ['7.1', '7.2', '7.3'].map((id) => a[id]);
        if (flags.filter(yes).length >= 2) return 'critical';
        if (flags.some(yes)) return 'serious';
        if (flags.every(no)) return 'low';
        return 'moderate';
      },
    },
  ],
  overall(judgements) {
    const values = Object.values(judgements).filter(Boolean);
    if (!values.length) return '';
    if (values.includes('critical')) return 'critical';
    if (values.includes('serious')) return 'serious';
    if (values.includes('ni')) return 'ni';
    if (values.includes('moderate')) return 'moderate';
    return 'low';
  },
  overallNote() {
    return 'ROBINS-I takes the overall judgement from the worst domain: a study at serious risk in any one domain is at serious risk overall.';
  },
};

// ---------------------------------------------------------------------------
// QUADAS-2 - diagnostic accuracy studies
// ---------------------------------------------------------------------------

const QUADAS2 = {
  id: 'quadas-2',
  name: 'QUADAS-2',
  longName: 'Quality Assessment of Diagnostic Accuracy Studies, version 2',
  alsoCalled: 'sometimes written QUADAS',
  designs: 'Diagnostic accuracy studies',
  blurb:
    'Four domains for risk of bias, three of them also judged for applicability to the review question. Signalling questions answer yes, no or unclear.',
  sourceLabel: 'QUADAS-2 (University of Bristol)',
  sourceUrl: 'https://www.bristol.ac.uk/population-health-sciences/projects/quadas/quadas-2/',
  answerSet: 'ynu',
  levels: ['low', 'high', 'unclear'],
  algorithmIsOfficial: false,
  hasApplicability: true,
  domains: [
    {
      id: 'D1',
      label: 'Patient selection',
      full: 'Patient selection',
      applicability: 'Are there concerns that the included patients and setting do not match the review question?',
      questions: [
        { id: '1.1', text: 'Was a consecutive or random sample of patients enrolled?' },
        { id: '1.2', text: 'Was a case-control design avoided?' },
        { id: '1.3', text: 'Did the study avoid inappropriate exclusions?' },
      ],
    },
    {
      id: 'D2',
      label: 'Index test',
      full: 'Index test',
      applicability:
        'Are there concerns that the index test, its conduct, or its interpretation differ from the review question?',
      questions: [
        {
          id: '2.1',
          text: 'Were the index test results interpreted without knowledge of the results of the reference standard?',
        },
        { id: '2.2', text: 'If a threshold was used, was it pre-specified?' },
      ],
    },
    {
      id: 'D3',
      label: 'Reference standard',
      full: 'Reference standard',
      applicability:
        'Are there concerns that the target condition as defined by the reference standard does not match the review question?',
      questions: [
        { id: '3.1', text: 'Is the reference standard likely to correctly classify the target condition?' },
        {
          id: '3.2',
          text: 'Were the reference standard results interpreted without knowledge of the results of the index test?',
        },
      ],
    },
    {
      id: 'D4',
      label: 'Flow and timing',
      full: 'Flow and timing',
      applicability: '',
      questions: [
        { id: '4.1', text: 'Was there an appropriate interval between the index test and the reference standard?' },
        { id: '4.2', text: 'Did all patients receive a reference standard?' },
        { id: '4.3', text: 'Did patients receive the same reference standard?' },
        { id: '4.4', text: 'Were all patients included in the analysis?' },
      ],
    },
  ],
  overall(judgements) {
    const values = Object.values(judgements).filter(Boolean);
    if (!values.length) return '';
    return worstQuadas(values);
  },
  overallNote() {
    return 'QUADAS-2 defines no overall score. This column is the worst domain judgement, kept because robvis plots expect one; leave it out of the figure if your review reports domains only.';
  },
};

// Every QUADAS-2 signalling question is worded so that yes means low concern, so one rule
// serves all four domains.
for (const domain of QUADAS2.domains) {
  domain.judge = (a) => {
    const answers = domain.questions.map((q) => a[q.id]);
    if (answers.some((v) => v === 'N')) return 'high';
    if (answers.some((v) => !v || v === 'U')) return 'unclear';
    return 'low';
  };
}

export const INSTRUMENTS = [ROB2, ROBINS_I, QUADAS2];

export function getInstrument(id) {
  return INSTRUMENTS.find((i) => i.id === id) || null;
}

/** Is a question answerable given the answers already given in its domain? */
export function isQuestionActive(question, answers) {
  return typeof question.when === 'function' ? Boolean(question.when(answers)) : true;
}

/**
 * Suggested judgement for one domain of one study. Returns the level plus how far the domain
 * is from done: 'empty' when nothing is answered, 'partial' when an active question is blank.
 */
export function suggestDomain(domain, answers = {}) {
  const active = domain.questions.filter((q) => isQuestionActive(q, answers));
  const answered = active.filter((q) => answers[q.id]);
  if (!answered.length) return { level: '', state: 'empty', answered: 0, active: active.length };
  const level = domain.judge(answers);
  const state = answered.length < active.length ? 'partial' : 'complete';
  return { level, state, answered: answered.length, active: active.length };
}

/** The judgement in force for a domain: the override if there is one, else the suggestion. */
export function resolveDomain(domain, study) {
  const answers = (study.answers && study.answers[domain.id]) || {};
  const suggestion = suggestDomain(domain, answers);
  const override = study.overrides && study.overrides[domain.id];
  return {
    ...suggestion,
    suggested: suggestion.level,
    level: override || suggestion.level,
    overridden: Boolean(override) && override !== suggestion.level,
  };
}
