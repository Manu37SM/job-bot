// With no unit hint in the label, a salary field is genuinely ambiguous: an Indian
// posting may want "7" (LPA) or "700000" (rupees), and typing the wrong one is off
// by a factor of 100,000 in a number a recruiter reads as fact. Candidates are
// ordered by this preference and the field's own min/max filters the rest.
//   'auto'    — rupees first, then LPA (the original behaviour)
//   'lpa'     — the LPA figure first
//   'rupees'  — rupees first, and never fall back to the bare LPA number
function salaryUnitPreference() {
  try {
    const configured = require('./config').salaryUnit;
    return ['auto', 'lpa', 'rupees'].includes(configured) ? configured : 'auto';
  } catch {
    return 'auto';
  }
}

const { isTenureQuestion } = require('./question-policy');

function decimalPlaces(value) {
  const text = String(value);
  return text.includes('.') ? text.split('.')[1].length : 0;
}

function isIntegerOnly(metadata = {}) {
  const step = String(metadata.step || '').toLowerCase();
  const pattern = String(metadata.pattern || '');

  if (pattern === '\\d+' || pattern === '[0-9]*' || pattern === '[0-9]+') return true;
  if (step === 'any') return false;

  const numericStep = Number(step);
  if (step && Number.isFinite(numericStep)) return Number.isInteger(numericStep);

  return metadata.inputType === 'number';
}

function withinBounds(value, metadata = {}) {
  const min = metadata.min === '' || metadata.min == null ? null : Number(metadata.min);
  const max = metadata.max === '' || metadata.max == null ? null : Number(metadata.max);
  if (min != null && Number.isFinite(min) && value < min) return false;
  if (max != null && Number.isFinite(max) && value > max) return false;
  return true;
}

function buildNumericCandidates(answer, label = '', metadata = {}) {
  const match = String(answer || '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return [];

  const value = Number(match[0]);
  if (!Number.isFinite(value)) return [];

  const q = String(label).toLowerCase();
  const integerOnly = isIntegerOnly(metadata);
  const isSalary = /ctc|salary|compensation|remuneration|pay|ectc/.test(q);
  // A claim about yourself that has to become a whole number should round DOWN.
  // 1.7 years of tenure entered as "2" overstates it, and matchNumericOption
  // already takes the same view for option lists ("understating experience is the
  // safer error"); the two should not disagree.
  // "How long have you been at your current company?" contains none of the year
  // words, so the shared tenure classifier is consulted too rather than a second
  // copy of its patterns drifting here.
  const isSelfClaim =
    !isSalary &&
    (/experien|\byears?\b|\bmonths?\b|tenure|worked|working/.test(q) || isTenureQuestion(label));
  // "LPA" / "lakhs per annum" mean the field wants the LPA number itself (e.g. 4.7),
  // NOT rupees — these must never be treated as a rupee-conversion cue.
  const wantsLPA = /\blpa\b|\blakhs?\b/.test(q);
  const wantsRupees = !wantsLPA && /rupees|inr|annual salary|per annum|yearly/.test(q);
  // CURRENT salary is a verifiable fact about the past — companies check it against
  // payslips — so an integer-only field gets the floor. EXPECTED salary is an ask,
  // not a claim, and rounds the other way.
  const isExpectedSalary = /expected|expectation|desired|ectc|asking|require/.test(q);
  const salaryFloorFirst = isSalary && !isExpectedSalary;
  const values = [];

  if (integerOnly) {
    if (isSalary && wantsLPA && Math.abs(value) < 1000) {
      // Label explicitly says LPA/lakhs → keep the LPA value, no rupee conversion.
      if (salaryFloorFirst) values.push(Math.floor(value), Math.round(value), Math.ceil(value));
      else values.push(Math.round(value), Math.ceil(value), Math.floor(value));
    } else if (isSalary && wantsRupees && Math.abs(value) < 1000) {
      // Label explicitly asks for INR/rupees/annual figure → convert LPA → rupees.
      values.push(Math.round(value * 100000));
    } else if (isSalary && Math.abs(value) < 1000) {
      // Salary field with no unit hint — order by config.salaryUnit.
      const preference = salaryUnitPreference();
      const rupees = Math.round(value * 100000);
      const lpa = salaryFloorFirst
        ? [Math.floor(value), Math.round(value), Math.ceil(value)]
        : [Math.round(value), Math.ceil(value), Math.floor(value)];
      if (preference === 'lpa') values.push(...lpa, rupees);
      else if (preference === 'rupees') values.push(rupees);
      else values.push(rupees, ...lpa);
    } else {
      // Keep the decimal answer as a fallback even for integer-only fields — some
      // "number" inputs accept decimals despite step=1 (browsers are inconsistent).
      // Integer variants come first since a plain <input type=number step=1> will
      // reject the decimal at checkValidity(); the decimal only wins if accepted.
      if (isSelfClaim) values.push(Math.floor(value), Math.round(value), Math.ceil(value));
      else values.push(Math.round(value), Math.floor(value), Math.ceil(value));
      values.push(value);
      if (decimalPlaces(value) > 2) values.push(Number(value.toFixed(2)));
    }
  } else {
    // Field explicitly allows decimals (step="any", step="0.1", etc.). Prefer the
    // exact value, then rupee conversion for salary (skipped when the label already
    // says LPA/lakhs, since that means the LPA number itself is wanted).
    if (isSalary && !wantsLPA && Math.abs(value) < 1000) {
      values.push(Math.round(value * 100000));
    }
    values.push(value);
    if (decimalPlaces(value) > 2) values.push(Number(value.toFixed(2)));
    values.push(Math.round(value), Math.floor(value), Math.ceil(value));
  }

  return [...new Set(values)].filter((candidate) => withinBounds(candidate, metadata)).map(String);
}

module.exports = { buildNumericCandidates, isIntegerOnly, salaryUnitPreference };
