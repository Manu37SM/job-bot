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

// "yrs" is at least as common as "years" in real postings, especially Indian ones.
// Without it, "Minimum 12 yrs experience" matched nothing and the posting sailed
// through the screen as if it had stated no requirement at all.
const YEARS = '(?:years?|yrs?\\.?)';

const MINIMUM_PATTERNS = [
  // "5-8 years", "5 to 8 yrs" -> the floor is 5
  new RegExp(`(\\d{1,2})\\s*(?:\\+)?\\s*(?:-|–|—|to)\\s*(\\d{1,2})\\s*\\+?\\s*${YEARS}`, 'gi'),
  // "8+ years", "8 plus yrs"
  new RegExp(`(\\d{1,2})\\s*(?:\\+|plus)\\s*${YEARS}`, 'gi'),
  // "minimum 8 years", "at least 8 yrs", "no less than 8 years"
  new RegExp(
    `(?:minimum(?:\\s+of)?|at\\s+least|no\\s+less\\s+than|not\\s+less\\s+than)\\s+(\\d{1,2})\\s*${YEARS}`,
    'gi'
  ),
  // "8 years of experience"
  new RegExp(
    `(\\d{1,2})\\s*${YEARS}\\s+(?:of\\s+)?(?:relevant\\s+|professional\\s+|hands[- ]on\\s+|proven\\s+|solid\\s+|strong\\s+)?experience`,
    'gi'
  ),
];

// Words that mark a number as a REQUIREMENT ON THE CANDIDATE rather than a fact
// about the company. Deliberately does not include the unit itself: "yrs" was in
// this list as a proxy for an experience context, and once "yrs" also became a
// recognised unit it satisfied the check on its own — so "our founders bring 20+
// yrs to the industry" read as a 20-year requirement.
const EXPERIENCE_CONTEXT =
  /experien|\bexp\b|background|track record|similar role|relevant|required|requirement|minimum|at least|hands[- ]on|working in|candidate|you (?:have|bring|will)/i;

function nearExperience(text, index) {
  const from = Math.max(0, index - CONTEXT_WINDOW);
  const slice = text.slice(from, index + CONTEXT_WINDOW);
  return EXPERIENCE_CONTEXT.test(slice);
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
