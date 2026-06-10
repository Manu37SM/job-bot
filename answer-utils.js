const config = require('./config');
const { current, expected } = require('./salary-helper');

function noticeDays() {
  return parseInt(String(config.noticePeriod).match(/\d+/)?.[0] || '0', 10);
}

function findOption(options, pattern) {
  return options.find((option) => pattern.test(option)) || '';
}

function matchOption(answer, options) {
  const value = String(answer || '').trim().toLowerCase();
  if (!value || options.length === 0) return '';

  return (
    options.find((option) => option.toLowerCase() === value) ||
    options.find(
      (option) =>
        option.toLowerCase().includes(value) || value.includes(option.toLowerCase())
    ) ||
    ''
  );
}

function isNumericQuestion(label, inputType) {
  if (inputType === 'number') return true;
  const l = String(label).toLowerCase();
  return /experience|years|month|ctc|salary|compensation|pay|ectc|notice|days|period|hike|increment|mobile|phone|number/.test(l);
}

function deterministicAnswer(question, inputType = 'text', options = []) {
  const q = String(question || '').toLowerCase();
  const yes = () => findOption(options, /\byes\b/i) || 'Yes';
  const no = () => findOption(options, /\bno\b/i) || 'No';

  if (q.includes('email')) return config.email;
  if (q.includes('phone') || q.includes('mobile')) return config.phone;
  if (q.includes('current location') || q.includes('city')) return config.location;

  const salaryQuestion = /ctc|salary|compensation|remuneration|pay/.test(q);
  if (salaryQuestion) {
    const isExpected = /expected|expectation|desired|ectc/.test(q);
    const salary = isExpected ? expected : current;
    if (q.includes('fixed')) return String(salary.fixed());
    if (/variable|bonus/.test(q)) return String(salary.variable());
    return String(salary.total());
  }

  if (/hike|increment|percentage increase/.test(q)) return '30';

  if (/notice|available to join|availability|joining/.test(q)) {
    if (/immediate|immediately/.test(q)) return noticeDays() === 0 ? yes() : no();
    return String(noticeDays());
  }

  if (/last working day|lwd/.test(q)) return config.lastWorkingDay;

  if (/experience|years? worked|how long/.test(q)) {
    // Check for specific skill years
    for (const [skill, years] of Object.entries(config.skillExperienceYears || {})) {
      if (q.includes(skill.toLowerCase())) {
        if (/months?/.test(q)) return String(Math.round(years * 12));
        return String(years);
      }
    }
    if (/months?/.test(q)) return String(Math.round(config.experienceYears * 12));
    return String(config.experienceYears);
  }

  if (/relocat/.test(q)) return yes();
  if (/work authorization|authoriz|eligible to work|legally work/.test(q)) return yes();
  if (/sponsor|visa/.test(q)) return no();
  if (/felony|lawsuit|criminal|crime|non-compete/.test(q)) return no();

  if (options.length > 0) return '';
  if (inputType === 'number') return '';
  return '';
}

function normalizeAnswer(answer, inputType = 'text', options = []) {
  let value = String(answer || '')
    .replace(/^["']|["']$/g, '')
    .trim();

  if (!value) return '';

  if (options.length > 0) return matchOption(value, options);

  if (inputType === 'number') {
    const numeric = value.match(/-?\d+(?:\.\d+)?/);
    return numeric ? numeric[0] : '';
  }

  if (inputType === 'checkbox') {
    if (/^(yes|true|checked)$/i.test(value)) return 'Yes';
    if (/^(no|false|unchecked)$/i.test(value)) return 'No';
    return '';
  }

  return value;
}

function localFallback(question, inputType = 'text', options = []) {
  const known = deterministicAnswer(question, inputType, options);
  if (known) return known;

  const q = String(question || '').toLowerCase();
  if (options.length > 0) {
    if (/do you|have you|are you|can you/.test(q)) {
      return findOption(options, /\byes\b/i) || '';
    }
    return '';
  }

  if (inputType === 'number') return '';
  if (/do you|have you|are you|can you/.test(q)) return 'Yes';
  return '';
}

module.exports = {
  deterministicAnswer,
  localFallback,
  matchOption,
  normalizeAnswer,
  noticeDays,
  isNumericQuestion,
};
