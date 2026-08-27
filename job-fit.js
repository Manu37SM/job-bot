// Cheap pre-screen of the job description, run before the Easy Apply form opens.
//
// The per-day application budget is small and deliberately so, which makes each
// application worth something. Spending one on a posting that opens with
// "10+ years of experience required" is a guaranteed rejection at the first human
// filter — better to skip it and give the slot to a job that can actually land.
//
// Deliberately conservative: it only acts on a clearly stated minimum, takes the
// LOWEST such number in the posting, and applies a tolerance on top. The failure
// mode to avoid is skipping a job the candidate could have got.
const config = require('./config');

// A number only counts when it sits near the word "experience" — postings are full
// of unrelated figures ("10+ million users", "founded 8 years ago").
const CONTEXT_WINDOW = 70;

const MINIMUM_PATTERNS = [
  // "5-8 years", "5 to 8 years" → the floor is 5
  /(\d{1,2})\s*(?:\+)?\s*(?:-|–|—|to)\s*(\d{1,2})\s*\+?\s*years?/gi,
  // "8+ years", "8 plus years"
  /(\d{1,2})\s*(?:\+|plus)\s*years?/gi,
  // "minimum 8 years", "at least 8 years", "no less than 8 years"
  /(?:minimum(?:\s+of)?|at\s+least|no\s+less\s+than|not\s+less\s+than)\s+(\d{1,2})\s*years?/gi,
  // "8 years of experience"
  /(\d{1,2})\s*years?\s+(?:of\s+)?(?:relevant\s+|professional\s+|hands[- ]on\s+|proven\s+|solid\s+|strong\s+)?experience/gi,
];

function nearExperience(text, index) {
  const from = Math.max(0, index - CONTEXT_WINDOW);
  const slice = text.slice(from, index + CONTEXT_WINDOW);
  return /experien|exp\b|yrs|background|track record/i.test(slice);
}

// The lowest clearly-stated minimum in the posting, or null when none is stated.
// Lowest, not highest: a posting that says "3-5 years for the core stack, 8+ for
// the lead track" is open to a 4-year candidate.
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

// Returns { skip: false } or { skip: true, reason }.
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
