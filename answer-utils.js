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

// Resolves a bare number (e.g. "4.1") against range-style options like "3-5 years",
// "5+ years", or "Less than 1 year" — common on LinkedIn for experience/salary/notice
// questions asked as a dropdown or radio group instead of a free number field. Without
// this, a raw number never matches any option text and the caller falls back to
// blindly picking the first option, which is silently wrong.
function matchNumericOption(value, options) {
  const num = Number(value);
  if (!Number.isFinite(num) || !options || options.length === 0) return '';

  let nearest = '';
  let nearestDistance = Infinity;

  for (const option of options) {
    const text = String(option);
    const nums = (text.match(/\d+(?:\.\d+)?/g) || []).map(Number);
    if (nums.length === 0) continue;

    const isPlus = /\+/.test(text);
    const isUnder = /less than|under|below|fewer than/i.test(text);

    let lo, hi;
    if (nums.length >= 2) {
      lo = Math.min(...nums);
      hi = Math.max(...nums);
    } else if (isPlus) {
      lo = nums[0];
      hi = Infinity;
    } else if (isUnder) {
      lo = -Infinity;
      hi = nums[0];
    } else {
      lo = hi = nums[0];
    }

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
  return /experience|years|month|ctc|salary|compensation|pay|ectc|notice|days|period|hike|increment|mobile|phone|number/.test(l);
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
  if (/total|overall|professional|relevant|work experience|experience do you have/.test(q)) {
    return false;
  }

  return (
    /years?\s+(?:of|in|with)\s+[\w#+.\-/ ]+\s+experience/.test(q) ||
    /experience\s+(?:in|with|on)\s+[\w#+.\-/ ]+/.test(q)
  );
}

// True when config.lastWorkingDay is today or in the past — i.e. the candidate has
// already left their previous job and is available immediately, regardless of what
// noticePeriod says. Falls back to noticePeriod === 0 if the date can't be parsed.
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
  // Numeric facts (salary, notice period, experience) must resolve to one of the
  // supplied options when the question is a radio/dropdown with range choices —
  // otherwise a bare "4.1" never matches "3-5 years" and the caller silently picks
  // whatever option happens to be first.
  const num = (value) => {
    if (!value || options.length === 0) return value;
    // Skip matchOption's loose substring matching for numeric values: "0" is a
    // substring of "30 days" and "60 days", so a naive .includes() check would
    // match the wrong option. Numeric values get an exact match or a proper
    // numeric-range match only.
    if (/^-?\d+(?:\.\d+)?$/.test(String(value).trim())) {
      const exact = options.find((o) => String(o).trim() === String(value).trim());
      return exact || matchNumericOption(value, options) || '';
    }
    return matchOption(value, options) || matchNumericOption(value, options) || '';
  };

  if (q.includes('email')) return config.email;
  if (q.includes('phone') || q.includes('mobile')) return config.phone;
  if (q.includes('current location') || q.includes('city')) return config.location;
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

  if (/hike|increment|percentage increase/.test(q)) return num('30');

  if (/notice|available to join|availability|joining/.test(q)) {
    if (/immediate|immediately/.test(q)) return noticeDays() === 0 ? yes() : no();
    return num(String(noticeDays()));
  }

  if (/last working day|lwd/.test(q)) return config.lastWorkingDay;

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
  isCurrentlyEmployed,
  deterministicAnswer,
  localFallback,
  matchOption,
  matchNumericOption,
  normalizeAnswer,
  noticeDays,
  isNumericQuestion,
  asksForSpecificSkillExperience,
  skillExperienceYearsFor,
};
