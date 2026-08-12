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
  // "LPA" / "lakhs per annum" mean the field wants the LPA number itself (e.g. 4.7),
  // NOT rupees — these must never be treated as a rupee-conversion cue.
  const wantsLPA = /\blpa\b|lakhs?\s*(per\s*annum)?/.test(q);
  const wantsRupees = !wantsLPA && /rupees|inr|annual salary|per annum|yearly/.test(q);
  const values = [];

  if (integerOnly) {
    if (isSalary && wantsLPA && Math.abs(value) < 1000) {
      // Label explicitly says LPA/lakhs → keep the LPA value, no rupee conversion.
      values.push(Math.round(value), Math.floor(value), Math.ceil(value));
    } else if (isSalary && wantsRupees && Math.abs(value) < 1000) {
      // Label explicitly asks for INR/rupees/annual figure → convert LPA → rupees.
      values.push(Math.round(value * 100000));
    } else if (isSalary && Math.abs(value) < 1000) {
      // Salary field with no unit hint. Try rupees first (LinkedIn's common case),
      // then the LPA value forced to an integer, so the field validator picks one.
      values.push(Math.round(value * 100000));
      values.push(Math.round(value), Math.floor(value), Math.ceil(value));
    } else {
      // Keep the decimal answer as a fallback even for integer-only fields — some
      // "number" inputs accept decimals despite step=1 (browsers are inconsistent).
      // Integer variants come first since a plain <input type=number step=1> will
      // reject the decimal at checkValidity(); the decimal only wins if accepted.
      values.push(Math.round(value), Math.floor(value), Math.ceil(value));
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

module.exports = { buildNumericCandidates, isIntegerOnly };
