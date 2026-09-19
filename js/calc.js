// Pure calculations for the tools pages. No DOM access: each page script reads its inputs,
// calls these functions and renders the result. Also imported by the Node check script.

/** Inverse standard normal CDF (Acklam's algorithm, the same one median2mean uses). */
export function normSInv(p) {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-7.78489400243029e-3, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [7.78469570904146e-3, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const low = 0.02425;
  const high = 1 - low;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= high) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/**
 * Diagnostic 2x2 table from sensitivity, specificity (both 0-1), the number of people with the
 * outcome and the total sample size.
 */
export function diagnostic({ sensitivity, specificity, diseased, total }) {
  const errors = [];
  if (!(sensitivity >= 0 && sensitivity <= 1)) errors.push('Sensitivity must be between 0 and 100%.');
  if (!(specificity >= 0 && specificity <= 1)) errors.push('Specificity must be between 0 and 100%.');
  if (!(diseased >= 0)) errors.push('People with the outcome cannot be negative.');
  if (!(total > 0)) errors.push('Sample size must be greater than 0.');
  if (diseased > total) errors.push('People with the outcome cannot exceed the sample size.');
  if (errors.length) return { errors };

  const healthy = total - diseased;
  const tp = sensitivity * diseased;
  const tn = specificity * healthy;
  return { errors, total, diseased, healthy, tp, fn: diseased - tp, tn, fp: healthy - tn };
}

/**
 * Combine groups with Cochrane's formula (Handbook 5.1, table 7.7.a), applied pairwise in order.
 * Groups with any empty or invalid field are skipped. Returns the running combination per group.
 */
export function combineGroups(groups) {
  const valid = groups
    .map((g, index) => ({ ...g, index }))
    .filter((g) => Number.isFinite(g.n) && g.n > 0 && Number.isFinite(g.mean) && Number.isFinite(g.sd) && g.sd >= 0);
  if (valid.length === 0) return { steps: [], result: null, skipped: groups.length };

  const steps = [];
  let oldN = valid[0].n;
  let oldMean = valid[0].mean;
  let oldSD = valid[0].sd;
  steps.push({ index: valid[0].index, n: oldN, mean: oldMean, sd: oldSD });
  for (const g of valid.slice(1)) {
    const newN = oldN + g.n;
    const newMean = (oldN * oldMean + g.n * g.mean) / newN;
    const newSD = Math.sqrt(
      ((oldN - 1) * oldSD ** 2 + (g.n - 1) * g.sd ** 2 +
        (oldN * g.n) / newN * (oldMean ** 2 + g.mean ** 2 - 2 * oldMean * g.mean)) /
        (newN - 1),
    );
    oldN = newN;
    oldMean = newMean;
    oldSD = newSD;
    steps.push({ index: g.index, n: newN, mean: newMean, sd: newSD });
  }
  return { steps, result: steps[steps.length - 1], skipped: groups.length - valid.length };
}

const ordered = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] <= x);

/**
 * Mean and SD from a five-number summary, replicating median2mean (Tong et al.):
 * mean from Luo et al. (2018); SD from Wan et al. (2014) in scenarios 1 and 2 and Shi et al.
 * (2020) in scenario 3; skewness test from Shi et al. (2023).
 * S1: min, median, max. S2: q1, median, q3. S3: all five.
 */
export function medianToMean(scenario, { n, min, q1, median, q3, max }) {
  if (!(n >= 1)) return { error: 'Sample size must be at least 1.' };
  if (scenario === 1) {
    if (![min, median, max].every(Number.isFinite)) return { error: 'Fill in the minimum, median and maximum.' };
    if (!ordered([min, median, max])) return { error: 'Values must satisfy minimum ≤ median ≤ maximum.' };
    const w = 4 / (4 + n ** 0.75);
    return {
      mean: w * (min + max) / 2 + (1 - w) * median,
      sd: (max - min) / (2 * normSInv((n - 0.375) / (n + 0.25))),
      skewed: Math.abs((min + max - 2 * median) / (max - min)) > 2.5 / (n + 1) + 1 / Math.log(n + 9),
      meanMethod: 'Luo et al. (2018)',
      sdMethod: 'Wan et al. (2014)',
    };
  }
  if (scenario === 2) {
    if (![q1, median, q3].every(Number.isFinite)) return { error: 'Fill in the first quartile, median and third quartile.' };
    if (!ordered([q1, median, q3])) return { error: 'Values must satisfy first quartile ≤ median ≤ third quartile.' };
    const w = 0.7 + 0.39 / n;
    return {
      mean: w * (q1 + q3) / 2 + (1 - w) * median,
      sd: (q3 - q1) / (2 * normSInv((0.75 * n - 0.125) / (n + 0.25))),
      skewed: Math.abs((q1 + q3 - 2 * median) / (q3 - q1)) > 2.65 / n ** 0.5 - 6 / n ** 2,
      meanMethod: 'Luo et al. (2018)',
      sdMethod: 'Wan et al. (2014)',
    };
  }
  if (![min, q1, median, q3, max].every(Number.isFinite)) return { error: 'Fill in all five values.' };
  if (!ordered([min, q1, median, q3, max])) return { error: 'Values must satisfy minimum ≤ Q1 ≤ median ≤ Q3 ≤ maximum.' };
  const w1 = 2.2 / (2.2 + n ** 0.75);
  const w2 = 0.7 - 0.72 / n ** 0.55;
  const w3 = 1 / (1 + 0.07 * n ** 0.6);
  return {
    mean: w1 * (min + max) / 2 + w2 * (q1 + q3) / 2 + (1 - w1 - w2) * median,
    sd: w3 * (max - min) / (2 * normSInv((n - 0.375) / (n + 0.25))) +
      (1 - w3) * (q3 - q1) / (2 * normSInv((0.75 * n - 0.125) / (n + 0.25))),
    skewed: Math.max(
      2.65 * Math.log(0.6 * n) / n ** 0.5 * Math.abs((min + max - 2 * median) / (max - min)),
      Math.abs((q1 + q3 - 2 * median) / (q3 - q1)),
    ) > 3 / n ** 0.5 - 40 / n ** 3,
    meanMethod: 'Luo et al. (2018)',
    sdMethod: 'Shi et al. (2020)',
  };
}
