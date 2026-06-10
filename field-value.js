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
  const wantsRupees = /rupees|inr|annual salary|per annum|yearly/.test(q);
  const values = [];

  if (integerOnly) {
    if (isSalary && wantsRupees && Math.abs(value) < 1000) {
      values.push(Math.round(value * 100000));
    } else {
      values.push(Math.round(value), Math.floor(value), Math.ceil(value));
    }
  } else {
    values.push(value);
    if (decimalPlaces(value) > 2) values.push(Number(value.toFixed(2)));
  }

  return [...new Set(values)].filter((candidate) => withinBounds(candidate, metadata)).map(String);
}

module.exports = { buildNumericCandidates, isIntegerOnly };
