const config = require('./config');

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

const WITHOUT_SPONSORSHIP =
  /\bwithout\s+(?:requiring\s+|the\s+need\s+for\s+|needing\s+)?(?:visa\s+)?sponsor\w*/i;
const ASKS_IF_REQUIRED = /\brequir\w*|\bneed\w*|\bwill you\b|\bdo you\b/i;

const LEGAL_HISTORY =
  /\bfelony\b|\bconvict\w*|\bcriminal\w*|\barrest\w*|\bmisdemeanou?r\w*|\blawsuit\w*|\blitigation\b|\bdebarred\b|\bdisciplinar\w*|\bmisconduct\b|terminated for cause|fired for|non-?compete|\bgarnish\w*|\bbankrupt\w*/i;

const CONSENT =
  /\bconsent\w*|\bagree\w*|\backnowledg\w*|\bi certify\b|certify that|certify the (?:above|information|details)|confirm that|terms (?:and|&) conditions|privacy (?:policy|notice)|background check|reference check|drug (?:test|screen)\w*|data (?:processing|protection)|\bgdpr\b|accurate to the best|i understand|authorize .* to contact|willing to (?:undergo|complete)/i;

const RELOCATION = /\brelocat\w*|\bwilling to move\b|\bshift base\b|\brelocation\b/i;
const SHIFT =
  /\bnight shift\w*|\bgraveyard\b|\brotational shift\w*|\bovernight\b|\bus shift\w*|\buk shift\w*|\bnight hours\b|\bshift timings?\b|\bwork at night\b/i;

const CREDENTIAL = /\bcertif\w*|\bcredential\w*|\blicen[cs]e\w*|\baccredit\w*/i;

const CERTIFY_CONSENT =
  /\b(?:i|we)\s+(?:hereby\s+)?certify\b|certify that|certify the (?:above|information|details|accuracy)|\bhereby certify\b/i;

const CAPABILITY =
  /\bexperienc\w*|\bproficien\w*|\bfamiliar\w*|\bskilled\b|\bexpertise\b|knowledge of|worked with|hands[- ]on|comfortable with|\bcapable of\b|certified in|fluent in|\byears?\s+(?:of|in|with)\b/i;

const COUNTRY_ALIASES = {
  india: /\b(india|indian)\b/i,
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

const COUNTRY_ABBREVIATIONS = {
  'united states': /\b(?:U\.S\.A\.|U\.S\.|USA|US)(?![A-Za-z])/,
  'united kingdom': /\b(?:U\.K\.|UK)(?![A-Za-z])/,
  uae: /\b(?:U\.A\.E\.|UAE)(?![A-Za-z])/,
  'european union': /\b(?:E\.U\.|EU)(?![A-Za-z])/,
};

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
  if (EEO.test(q)) return 'eeo';

  const sponsorship = SPONSORSHIP.test(q);
  const authorization = WORK_AUTHORIZATION.test(q);
  if (sponsorship || authorization) {
    if (authorization && WITHOUT_SPONSORSHIP.test(q)) return 'work_authorization';
    if (sponsorship && (!authorization || ASKS_IF_REQUIRED.test(q))) return 'sponsorship';
    return 'work_authorization';
  }
  if (LEGAL_HISTORY.test(q)) return 'legal_history';
  if (RELOCATION.test(q)) return 'relocation';
  if (SHIFT.test(q)) return 'shift';
  if (CERTIFY_CONSENT.test(q)) return 'consent';
  if (CREDENTIAL.test(q)) return 'capability';
  if (CONSENT.test(q)) return 'consent';
  if (CAPABILITY.test(q)) return 'capability';
  return 'generic';
}

function mayGuess(question) {
  const kind = classify(question);
  return kind === 'consent' || kind === 'generic';
}

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

function workAuthorizationAnswer(question, options = []) {
  const status = authorizationStatus(question);
  if (status === 'yes') return yesOption(options);
  if (status === 'no') return noOption(options);
  return config.authorization?.assumeAuthorizedWhenCountryUnstated === false
    ? ''
    : yesOption(options);
}

function sponsorshipAnswer(question, options = []) {
  const status = authorizationStatus(question);
  if (status === 'no') return yesOption(options);
  if (status === 'yes') return noOption(options);
  return config.authorization?.assumeAuthorizedWhenCountryUnstated === false
    ? ''
    : noOption(options);
}

function relocationAnswer(question, options = []) {
  const q = String(question || '').toLowerCase();
  const locations = config.locations || {};
  const preferred = (locations.preferredCities || []).map((c) => c.toLowerCase());
  const other = (locations.otherCities || []).map((c) => c.toLowerCase());

  const namedPreferred = preferred.find((city) => q.includes(city));
  if (namedPreferred) return yesOption(options);

  const namedOther = other.find((city) => q.includes(city));
  if (namedOther) {
    const modes = locations.otherCityModes || [];
    return modes.includes('onsite') || modes.includes('hybrid')
      ? yesOption(options)
      : noOption(options);
  }

  if (config.willingToRelocate === true) return yesOption(options);
  if (config.willingToRelocate === false) return noOption(options);
  return '';
}

function eeoAnswer(options = []) {
  return findOption(options, DECLINE) || '';
}

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

const NON_TECHNOLOGY =
  /\b(environments?|teams?|industr\w*|domains?|cultures?|comp(?:any|anies)|startups?|enterprises?|clients?|customers?|stakeholders?|methodolog\w*|process(?:es)?|practices?|roles?|positions?|projects?|people|persons?|management|leadership|communication|collaboration|remote work|fast[- ]paced|agile|scrum|waterfall|hybrid|onsite|shifts?|travel|veterans?|students?|children|kids|patients?|seniors?|minors?|volunteers?|communit\w*|users?|vendors?|partners?|budgets?|deadlines?)\b/i;

const ANCHORS = 'with|in|using|of|on';
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
