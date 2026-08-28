const config = require('./config');

const CONTEXT_WINDOW = 70;

const YEARS = '(?:years?|yrs?\\.?)';

const MINIMUM_PATTERNS = [
  new RegExp(`(\\d{1,2})\\s*(?:\\+)?\\s*(?:-|–|—|to)\\s*(\\d{1,2})\\s*\\+?\\s*${YEARS}`, 'gi'),
  new RegExp(`(\\d{1,2})\\s*(?:\\+|plus)\\s*${YEARS}`, 'gi'),
  new RegExp(
    `(?:minimum(?:\\s+of)?|at\\s+least|no\\s+less\\s+than|not\\s+less\\s+than)\\s+(\\d{1,2})\\s*${YEARS}`,
    'gi'
  ),
  new RegExp(
    `(\\d{1,2})\\s*${YEARS}\\s+(?:of\\s+)?(?:relevant\\s+|professional\\s+|hands[- ]on\\s+|proven\\s+|solid\\s+|strong\\s+)?experience`,
    'gi'
  ),
];

const EXPERIENCE_CONTEXT =
  /experien|\bexp\b|background|track record|similar role|relevant|required|requirement|minimum|at least|hands[- ]on|working in|candidate|you (?:have|bring|will)/i;

function nearExperience(text, index) {
  const from = Math.max(0, index - CONTEXT_WINDOW);
  const slice = text.slice(from, index + CONTEXT_WINDOW);
  return EXPERIENCE_CONTEXT.test(slice);
}

function requiredExperienceYears(jobDescription) {
  const text = String(jobDescription || '');
  if (!text.trim()) return null;

  const found = [];
  for (const pattern of MINIMUM_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (!nearExperience(text, match.index)) continue;
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value <= 30) found.push(value);
    }
  }

  return found.length ? Math.min(...found) : null;
}

function fitConfig() {
  const fit = config.fit || {};
  return {
    enabled: fit.skipOverqualifiedPostings !== false,
    tolerance: Number.isFinite(Number(fit.experienceToleranceYears))
      ? Number(fit.experienceToleranceYears)
      : 2,
  };
}

function assessFit(jobDescription, { experienceYears = config.experienceYears } = {}) {
  const { enabled, tolerance } = fitConfig();
  if (!enabled) return { skip: false };

  const required = requiredExperienceYears(jobDescription);
  if (required == null) return { skip: false };

  const have = Number(experienceYears) || 0;
  if (required <= have + tolerance) return { skip: false };

  return {
    skip: true,
    required,
    reason: `posting asks for ${required}+ years, you have ${have} (tolerance ${tolerance})`,
  };
}

module.exports = { requiredExperienceYears, assessFit, fitConfig };
