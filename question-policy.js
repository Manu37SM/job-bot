// Guardrails for questions where a wrong answer is not just a lost application.
//
// Easy Apply forms mix three very different kinds of question together:
//   - harmless mechanics ("do you consent to a background check?")
//   - claims about you that must be TRUE ("are you authorized to work in the US?")
//   - protected-characteristic questions that are yours alone to answer
//
// The old behaviour was to guess "Yes" at anything phrased as "Do you…/Are you…"
// so the form would never stall. That trades a stalled form for a false statement
// submitted under the candidate's name — a much worse deal. This module decides
// which questions the bot is allowed to guess at, and answers the country-sensitive
// ones correctly instead of optimistically.
const config = require('./config');

// Protected characteristics. Never invented, never guessed — the honest answer is
// whatever decline-to-answer option the form offers, and nothing otherwise.
const EEO = new RegExp(
  [
    '\\b(?:races?|ethnicit\\w*|hispanic|latino|african american|caucasian|native hawaiian|alaska native|two or more races)\\b',
    '\\bgender\\b|\\bsex\\b|\\bpronouns?\\b|sexual orientation|\\blgbt\\w*|\\btransgender\\b',
    '\\bveterans?\\b|military status|\\bdisabilit\\w*|\\bdisabled\\b|chronic (?:condition|illness)|neurodiver\\w*',
    '\\breligio\\w*|\\bcaste\\b|marital status|\\bpregnan\\w*',
    '\\bage (?:range|group|bracket)\\b|date of birth|how old are you|\\bare you (?:at least |over )?\\d{2}\\b',
  ].join('|'),
  'i'
);

const DECLINE =
  /prefer not|decline|do not wish|don'?t wish|choose not|not to (answer|say|disclose|self-identify)|i do not want|no answer|unspecified|rather not/i;

const WORK_AUTHORIZATION =
  /\b(legally (authorized|authorised|entitled|eligible)|work authorization|work authorisation|authorized to work|authorised to work|eligible to work|right to work|work permit|work eligibility|permanent resident|citizen(ship)? status)\b/i;

const SPONSORSHIP =
  /\bsponsor\w*|\bh-?1b\b|employment pass|\b(?:work|employment|student|dependent|tn)\s+visa\b|\bvisa\s+(?:status|support|sponsor\w*)\b|\brequir\w*\s+(?:a\s+)?visa\b/i;

// "…authorized to work in the US WITHOUT sponsorship?" asks about authorization, and
// the honest answer is No. Classified as sponsorship it would answer "Yes" — the
// exact opposite — because "yes, sponsorship is required" is the right answer to the
// other question. The qualifier decides which question is actually being asked.
const WITHOUT_SPONSORSHIP = /\bwithout\s+(?:requiring\s+|the\s+need\s+for\s+|needing\s+)?(?:visa\s+)?sponsor\w*/i;
const ASKS_IF_REQUIRED = /\brequir\w*|\bneed\w*|\bwill you\b|\bdo you\b/i;

const LEGAL_HISTORY =
  /\bfelony\b|\bconvict\w*|\bcriminal\w*|\barrest\w*|\bmisdemeanou?r\w*|\blawsuit\w*|\blitigation\b|\bdebarred\b|\bdisciplinar\w*|\bmisconduct\b|terminated for cause|fired for|non-?compete|\bgarnish\w*|\bbankrupt\w*/i;

const CONSENT =
  /\bconsent\w*|\bagree\w*|\backnowledg\w*|\bi certify\b|certify that|certify the (?:above|information|details)|confirm that|terms (?:and|&) conditions|privacy (?:policy|notice)|background check|reference check|drug (?:test|screen)\w*|data (?:processing|protection)|\bgdpr\b|accurate to the best|i understand|authorize .* to contact|willing to (?:undergo|complete)/i;

// Commitments about where and when the candidate will work. Both were previously
// answered "Yes" by the generic fallback whenever relocationAnswer / the shift rule
// declined to commit — which is how a bot with `dayShiftOnly: true` in its config
// ended up agreeing to night shifts.
const RELOCATION = /\brelocat\w*|\bwilling to move\b|\bshift base\b|\brelocation\b/i;
const SHIFT =
  /\bnight shift\w*|\bgraveyard\b|\brotational shift\w*|\bovernight\b|\bus shift\w*|\buk shift\w*|\bnight hours\b|\bshift timings?\b|\bwork at night\b/i;

// A claim to hold a specific credential. Kept distinct from CONSENT because both
// share the "certif-" stem, and distinct from a plain skill because a fabricated
// certification is a materially worse claim than an overstated familiarity.
const CREDENTIAL = /\bcertif\w*|\bcredential\w*|\blicen[cs]e\w*|\baccredit\w*/i;

// Attestation phrasing, which shares the "certif-" stem with CREDENTIAL and must be
// matched first or "I certify that the above is accurate" reads as a claim to hold
// a certification and gets refused instead of ticked.
const CERTIFY_CONSENT =
  /\b(?:i|we)\s+(?:hereby\s+)?certify\b|certify that|certify the (?:above|information|details|accuracy)|\bhereby certify\b/i;

// "Do you have experience with X?", "Are you proficient in Y?" — a claim about the
// candidate's skills. Answerable from the CV, never by an optimistic default.
const CAPABILITY =
  /\bexperienc\w*|\bproficien\w*|\bfamiliar\w*|\bskilled\b|\bexpertise\b|knowledge of|worked with|hands[- ]on|comfortable with|\bcapable of\b|certified in|fluent in|\byears?\s+(?:of|in|with)\b/i;

// Countries a work-authorization question can name. Only what a job posting
// realistically asks about — the point is to notice "this is asking about a
// DIFFERENT country than the one I can work in", not to be a gazetteer.
const COUNTRY_ALIASES = {
  india: /\b(india|indian)\b/i,
  // NOTE: no case-insensitive "u.s." here. Matched case-insensitively it also
  // catches the pronoun — "let us know", "work with us" — and the consequence is
  // answering "No" to an authorization question about the candidate's own country.
  // The abbreviations live in COUNTRY_ABBREVIATIONS below and are matched only in
  // their uppercase form.
  'united states': /\b(united states|america|american|stateside)\b/i,
  'united kingdom': /\b(united kingdom|britain|british|england)\b/i,
  canada: /\b(canada|canadian)\b/i,
  australia: /\b(australia|australian)\b/i,
  germany: /\b(germany|german)\b/i,
  netherlands: /\b(netherlands|dutch|holland)\b/i,
  ireland: /\b(ireland|irish)\b/i,
  singapore: /\b(singapore|singaporean)\b/i,
  uae: /\b(uae|united arab emirates|dubai|abu dhabi)\b/i,
  'european union': /\b(european union|\beu\b|schengen|eea)\b/i,
  'new zealand': /\b(new zealand)\b/i,
  'south africa': /\b(south africa)\b/i,
  japan: /\b(japan|japanese)\b/i,
};

// Matched WITHOUT the /i flag, so only the genuine abbreviation counts.
const COUNTRY_ABBREVIATIONS = {
  'united states': /\b(?:U\.S\.A\.|U\.S\.|USA|US)(?![A-Za-z])/,
  'united kingdom': /\b(?:U\.K\.|UK)(?![A-Za-z])/,
  uae: /\b(?:U\.A\.E\.|UAE)(?![A-Za-z])/,
  'european union': /\b(?:E\.U\.|EU)(?![A-Za-z])/,
};

// "How long have you been at your current company?" is about TENURE, not career
// length. It contains "how long" and "experience"-adjacent words, so the generic
// experience branch answered it with total years — claiming a whole career at one
// employer. Defined here so answer-utils and resume-profile cannot disagree.
const EMPLOYER_REFERENCE =
  '(?:current|present|this|latest|most recent|last)\\s*(?:company|employer|organi\\w*|firm|role|position|job|team)?|\\b(?:company|employer|organi\\w*|firm)\\b';

const TENURE = new RegExp(
  [
    `\\btenure\\b`,
    `\\bhow long\\b[^?]*\\b(?:been|worked|working|with|at|in)\\b[^?]*(?:${EMPLOYER_REFERENCE})`,
    `\\bhow many (?:months|years)\\b[^?]*\\b(?:been|worked|working|with|at)\\b[^?]*(?:${EMPLOYER_REFERENCE})`,
    `\\btime (?:at|with|in) (?:your |the )?(?:current|present|this)\\b`,
    `\\bduration\\b[^?]*\\b(?:current|present)\\b`,
    `\\byears? (?:at|with) (?:your |the )?(?:current|present)\\b`,
  ].join('|'),
  'i'
);

function isTenureQuestion(question) {
  return TENURE.test(String(question || ''));
}

function findOption(options, pattern) {
  return (options || []).find((option) => pattern.test(String(option))) || '';
}

function classify(question) {
  const q = String(question || '');
  if (!q.trim()) return 'generic';
  // Order matters: a question can match several patterns, and the strictest
  // classification has to win. "Are you a protected veteran?" contains "are you",
  // which the consent branch would otherwise happily answer "Yes" to.
  if (EEO.test(q)) return 'eeo';

  const sponsorship = SPONSORSHIP.test(q);
  const authorization = WORK_AUTHORIZATION.test(q);
  if (sponsorship || authorization) {
    // "authorized … without sponsorship" is an authorization question wearing a
    // sponsorship word.
    if (authorization && WITHOUT_SPONSORSHIP.test(q)) return 'work_authorization';
    if (sponsorship && (!authorization || ASKS_IF_REQUIRED.test(q))) return 'sponsorship';
    return 'work_authorization';
  }
  if (LEGAL_HISTORY.test(q)) return 'legal_history';
  if (RELOCATION.test(q)) return 'relocation';
  if (SHIFT.test(q)) return 'shift';
  if (CERTIFY_CONSENT.test(q)) return 'consent';
  // Credentials outrank consent: "Are you AWS certified?" is a claim, not a tickbox.
  if (CREDENTIAL.test(q)) return 'capability';
  if (CONSENT.test(q)) return 'consent';
  if (CAPABILITY.test(q)) return 'capability';
  return 'generic';
}

// Whether the bot may fall back to a heuristic guess for this question. False for
// anything where a wrong answer is a false statement rather than a lost chance.
function mayGuess(question) {
  const kind = classify(question);
  return kind === 'consent' || kind === 'generic';
}

// The countries the candidate can actually work in without sponsorship.
function authorizedCountries() {
  const declared = config.authorization?.authorizedCountries;
  if (Array.isArray(declared) && declared.length)
    return declared.map((c) => String(c).toLowerCase());
  return [String(config.country || 'India').toLowerCase()];
}

function countriesMentioned(question) {
  const q = String(question || '');
  const found = new Set();
  for (const [name, pattern] of Object.entries(COUNTRY_ALIASES)) {
    if (pattern.test(q)) found.add(name);
  }
  for (const [name, pattern] of Object.entries(COUNTRY_ABBREVIATIONS)) {
    if (pattern.test(q)) found.add(name);
  }
  return [...found];
}

// Is the country named in this question one the candidate can work in?
//   'yes'     — the question names a country they are authorized in
//   'no'      — the question names only countries they are NOT authorized in
//   'unknown' — no country named at all
function authorizationStatus(question) {
  const mentioned = countriesMentioned(question);
  if (mentioned.length === 0) return 'unknown';
  const authorized = authorizedCountries();
  const matches = mentioned.some((country) =>
    authorized.some((own) => own.includes(country) || country.includes(own))
  );
  return matches ? 'yes' : 'no';
}

function yesOption(options) {
  return findOption(options, /\byes\b/i) || 'Yes';
}
function noOption(options) {
  return findOption(options, /\bno\b/i) || 'No';
}

// "Are you legally authorized to work in <country>?"
function workAuthorizationAnswer(question, options = []) {
  const status = authorizationStatus(question);
  if (status === 'yes') return yesOption(options);
  if (status === 'no') return noOption(options);
  // No country named. Assume the posting means the country the candidate is
  // searching in — true for the location filters this bot runs — but let it be
  // turned off for anyone applying across borders.
  return config.authorization?.assumeAuthorizedWhenCountryUnstated === false
    ? ''
    : yesOption(options);
}

// "Will you now or in the future require sponsorship?" — the mirror image, and the
// one the old code got backwards: it answered a flat "No", which is only true for
// countries the candidate is already authorized in.
function sponsorshipAnswer(question, options = []) {
  const status = authorizationStatus(question);
  if (status === 'no') return yesOption(options); // different country → yes, sponsorship needed
  if (status === 'yes') return noOption(options);
  return config.authorization?.assumeAuthorizedWhenCountryUnstated === false
    ? ''
    : noOption(options);
}

// "Are you willing to relocate to <city>?" — answered from the candidate's own
// location preferences instead of an unconditional "Yes".
function relocationAnswer(question, options = []) {
  const q = String(question || '').toLowerCase();
  const locations = config.locations || {};
  const preferred = (locations.preferredCities || []).map((c) => c.toLowerCase());
  const other = (locations.otherCities || []).map((c) => c.toLowerCase());

  const namedPreferred = preferred.find((city) => q.includes(city));
  if (namedPreferred) return yesOption(options);

  const namedOther = other.find((city) => q.includes(city));
  if (namedOther) {
    // Cities listed under otherCities are only acceptable on the modes listed for
    // them (remote by default) — so a relocation question about one is a "no"
    // unless relocation was explicitly opted into.
    const modes = locations.otherCityModes || [];
    return modes.includes('onsite') || modes.includes('hybrid')
      ? yesOption(options)
      : noOption(options);
  }

  if (config.willingToRelocate === true) return yesOption(options);
  if (config.willingToRelocate === false) return noOption(options);
  return ''; // unnamed city and no stated policy — ask the candidate, don't invent one
}

// For a protected-characteristic question, the only honest automated answer is the
// form's own decline option. If it doesn't offer one, the bot leaves it alone.
function eeoAnswer(options = []) {
  return findOption(options, DECLINE) || '';
}

// User-supplied answers for anything the bot can't work out. Checked before every
// other strategy, so it is always the final word — this is what needs-review.md
// tells the candidate to add.
function customAnswer(question, options = []) {
  const entries = config.customAnswers;
  if (!Array.isArray(entries) || !entries.length) return '';
  const q = String(question || '');
  if (!q.trim()) return '';

  for (const entry of entries) {
    if (!entry || entry.answer == null) continue;
    const { match } = entry;
    let hit = false;
    if (match instanceof RegExp) hit = match.test(q);
    else if (typeof match === 'string') hit = q.toLowerCase().includes(match.toLowerCase());
    if (!hit) continue;

    const answer = String(entry.answer);
    if (!options.length) return answer;
    return (
      options.find((o) => String(o).toLowerCase() === answer.toLowerCase()) ||
      options.find((o) => String(o).toLowerCase().includes(answer.toLowerCase())) ||
      answer
    );
  }
  return '';
}

// Generic nouns that make a capability question about a working style rather than
// a technology. "Experience with Rust" can be answered honestly from the CV;
// "experience with fast-paced environments" cannot, and is left for the candidate.
const NON_TECHNOLOGY =
  /\b(environments?|teams?|industr\w*|domains?|cultures?|comp(?:any|anies)|startups?|enterprises?|clients?|customers?|stakeholders?|methodolog\w*|process(?:es)?|practices?|roles?|positions?|projects?|people|persons?|management|leadership|communication|collaboration|remote work|fast[- ]paced|agile|scrum|waterfall|hybrid|onsite|shifts?|travel|veterans?|students?|children|kids|patients?|seniors?|minors?|volunteers?|communit\w*|users?|vendors?|partners?|budgets?|deadlines?)\b/i;

// Pull the subject out of a capability question. The LAST "with"/"in"/"using" is
// the right anchor: "How many years of experience do you have with Kubernetes?"
// has an earlier "of" that would otherwise swallow the whole sentence.
const ANCHORS = 'with|in|using|of|on';
// A captured token may not itself be an anchor or a filler word — otherwise the
// first "of" swallows "experience in Spring" and the real subject ("Spring Boot")
// is never reached, because a global regex cannot match inside what it consumed.
const SUBJECT_TOKEN = `(?!(?:${ANCHORS}|and|or|the|a|an)\\b)[A-Za-z][\\w+#.\\-]*`;
const SUBJECT_RE = new RegExp(
  `\\b(?:${ANCHORS})\\s+(${SUBJECT_TOKEN}(?:\\s+${SUBJECT_TOKEN}){0,2})`,
  'gi'
);

function extractSubject(question) {
  const matches = [...String(question || '').matchAll(SUBJECT_RE)];
  if (!matches.length) return '';
  const candidate = matches[matches.length - 1][1]
    .replace(/\b(?:a|an|the|your|this|years?|experience|working|work|do|you|have|has|any)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return candidate.length >= 2 && candidate.length <= 40 ? candidate : '';
}

// Safe to answer "no" from the CV when absent: a concrete, technology-shaped
// subject. Anything vaguer is left for the candidate to answer once by hand.
function looksLikeTechnology(subject) {
  const text = String(subject || '').trim();
  if (!text || text.length > 30) return false;
  if (NON_TECHNOLOGY.test(text)) return false;
  return text.split(/\s+/).length <= 3;
}

module.exports = {
  classify,
  isTenureQuestion,
  RELOCATION,
  SHIFT,
  extractSubject,
  looksLikeTechnology,
  NON_TECHNOLOGY,
  mayGuess,
  customAnswer,
  eeoAnswer,
  workAuthorizationAnswer,
  sponsorshipAnswer,
  relocationAnswer,
  authorizationStatus,
  countriesMentioned,
  authorizedCountries,
  DECLINE,
};
