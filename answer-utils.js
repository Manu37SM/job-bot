const config = require('./config');
const { current, expected } = require('./salary-helper');
const policy = require('./question-policy');

function noticeDays() {
  return parseInt(String(config.noticePeriod).match(/\d+/)?.[0] || '0', 10);
}

function findOption(options, pattern) {
  return options.find((option) => pattern.test(option)) || '';
}

function matchOption(answer, options) {
  const value = String(answer || '')
    .trim()
    .toLowerCase();
  if (!value || options.length === 0) return '';

  return (
    options.find((option) => option.toLowerCase() === value) ||
    options.find(
      (option) => option.toLowerCase().includes(value) || value.includes(option.toLowerCase())
    ) ||
    ''
  );
}

const WORD_QUANTITIES = [
  {
    value: 0,
    pattern:
      /\bimmediate(?:ly)?\b|\bright away\b|\bavailable now\b|\basap\b|\bnone\b|\bnil\b|\bzero\b|\bcurrently serving\b/i,
  },
];

const OPEN_UPPER =
  /\bmore than\b|\bover\b|\bat least\b|\bgreater than\b|\babove\b|\bminimum\b|\bplus\b|\band above\b|\bor more\b/i;
const OPEN_LOWER =
  /\bless than\b|\bunder\b|\bbelow\b|\bfewer than\b|\bup to\b|\bat most\b|\bmaximum\b|\bor fewer\b|\bor less\b/i;

function optionRange(text) {
  const word = WORD_QUANTITIES.find((entry) => entry.pattern.test(text));
  const nums = (text.match(/\d+(?:\.\d+)?/g) || []).map(Number);

  if (word && nums.length === 0) return { lo: word.value, hi: word.value };
  if (nums.length === 0) return null;

  if (nums.length >= 2) return { lo: Math.min(...nums), hi: Math.max(...nums) };
  if (/\+/.test(text) || OPEN_UPPER.test(text)) return { lo: nums[0], hi: Infinity };
  if (OPEN_LOWER.test(text)) return { lo: -Infinity, hi: nums[0] };
  return { lo: nums[0], hi: nums[0] };
}

function matchNumericOption(value, options) {
  const num = Number(value);
  if (!Number.isFinite(num) || !options || options.length === 0) return '';

  let nearest = '';
  let nearestDistance = Infinity;

  for (const option of options) {
    const range = optionRange(String(option));
    if (!range) continue;

    const { lo, hi } = range;
    if (num >= lo && num <= hi) return option;

    const distance = num < lo ? lo - num : num - hi;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = option;
    }
  }

  return nearest;
}

function isNumericQuestion(label, inputType) {
  if (inputType === 'number') return true;
  const l = String(label).toLowerCase();
  return /experience|years|month|ctc|salary|compensation|pay|ectc|notice|days|period|hike|increment|mobile|phone|number/.test(
    l
  );
}

function skillExperienceYearsFor(question) {
  const q = String(question || '').toLowerCase();
  for (const [skill, years] of Object.entries(config.skillExperienceYears || {})) {
    if (q.includes(skill.toLowerCase())) return years;
  }
  return null;
}

function asksForSpecificSkillExperience(question) {
  const q = String(question || '').toLowerCase();
  if (!/experience|years?/.test(q)) return false;

  if (/\b(?:total|overall|cumulative|professional|relevant|work|industry)\s+experience\b/.test(q)) {
    return false;
  }

  const subject = policy.extractSubject(question);
  return Boolean(subject) && policy.looksLikeTechnology(subject);
}

function isCurrentlyEmployed() {
  const lwd = new Date(config.lastWorkingDay);
  if (!Number.isNaN(lwd.getTime())) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    lwd.setHours(0, 0, 0, 0);
    return lwd.getTime() > today.getTime();
  }
  return noticeDays() > 0;
}

function deterministicAnswer(question, inputType = 'text', options = []) {
  const q = String(question || '').toLowerCase();
  const yes = () => findOption(options, /\byes\b/i) || 'Yes';
  const no = () => findOption(options, /\bno\b/i) || 'No';
  const num = (value) => {
    if (!value || options.length === 0) return value;
    if (/^-?\d+(?:\.\d+)?$/.test(String(value).trim())) {
      const exact = options.find((o) => String(o).trim() === String(value).trim());
      return exact || matchNumericOption(value, options) || '';
    }
    return matchOption(value, options) || matchNumericOption(value, options) || '';
  };

  const kind = policy.classify(question);
  if (kind === 'eeo') return policy.eeoAnswer(options);
  if (kind === 'work_authorization') return policy.workAuthorizationAnswer(question, options);
  if (kind === 'sponsorship') return policy.sponsorshipAnswer(question, options);
  if (kind === 'legal_history') return no();
  if (kind === 'shift' && config.dayShiftOnly) return no();

  if (q.includes('email')) return config.email;
  if (q.includes('phone') || q.includes('mobile')) return config.phone;
  if (/country code/.test(q)) return config.phoneCountryCode || '';
  if (q.includes('current location') || q.includes('city')) return config.location;
  if (q.includes('country') && !/country code/.test(q)) return config.country || '';
  if (/linkedin/.test(q) && /url|profile|link/.test(q)) return config.linkedinUrl || '';
  if (/github/.test(q) && /url|profile|link/.test(q)) return config.githubUrl || '';

  if (/currently employed|presently employed|are you employed|working currently/.test(q)) {
    return isCurrentlyEmployed() ? yes() : no();
  }

  const salaryQuestion = /ctc|salary|compensation|remuneration|pay/.test(q);
  if (salaryQuestion) {
    const isExpected = /expected|expectation|desired|ectc/.test(q);
    const salary = isExpected ? expected : current;
    if (q.includes('fixed')) return num(String(salary.fixed()));
    if (/variable|bonus/.test(q)) return num(String(salary.variable()));
    return num(String(salary.total()));
  }

  if (/hike|increment|percentage increase|percentage hike/.test(q)) {
    const from = current.total();
    const to = expected.total();
    if (from > 0 && to > 0) return num(String(Math.round(((to - from) / from) * 100)));
    return '';
  }

  if (/notice|available to join|availability|joining/.test(q)) {
    if (/immediate|immediately/.test(q)) return noticeDays() === 0 ? yes() : no();
    return num(String(noticeDays()));
  }

  if (/last working day|lwd/.test(q)) return config.lastWorkingDay;

  if (policy.isTenureQuestion(question)) return '';

  if (/experience|years? worked|how long/.test(q)) {
    const skillYears = skillExperienceYearsFor(q);
    if (skillYears != null) {
      if (/months?/.test(q)) return num(String(Math.round(skillYears * 12)));
      return num(String(skillYears));
    }

    if (asksForSpecificSkillExperience(q)) return '';

    if (/months?/.test(q)) return num(String(Math.round(config.experienceYears * 12)));
    return num(String(config.experienceYears));
  }

  if (/relocat/.test(q)) return policy.relocationAnswer(question, options);

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

  if (!policy.mayGuess(question)) return '';

  const q = String(question || '').toLowerCase();
  if (options.length > 0) {
    if (/do you|have you|are you|can you|will you/.test(q)) {
      return findOption(options, /\byes\b/i) || '';
    }
    return '';
  }

  if (inputType === 'number') return '';
  if (/do you|have you|are you|can you|will you/.test(q)) return 'Yes';
  return '';
}

module.exports = {
  isCurrentlyEmployed,
  deterministicAnswer,
  localFallback,
  matchOption,
  matchNumericOption,
  optionRange,
  normalizeAnswer,
  noticeDays,
  isNumericQuestion,
  asksForSpecificSkillExperience,
  skillExperienceYearsFor,
};
