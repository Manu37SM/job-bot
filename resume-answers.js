// Answers Easy Apply questions entirely from local data: config.js facts + the CV
// text/structured profile in resume-profile.js. No AI provider, no network call, no
// API key. This intentionally replaces the old ai.js, which called out to Anthropic.
const config = require('./config');
const { current, expected } = require('./salary-helper');
const { deterministicAnswer, localFallback, matchOption, matchNumericOption } = require('./answer-utils');
const profile = require('./resume-profile');

function findOption(options, pattern) {
  return options.find((o) => pattern.test(o)) || '';
}

const CONSENT_WORDS =
  /consent|agree|acknowledge|confirm|certify|terms (and|&) conditions|privacy policy|background check|reference check|drug test|data (processing|protection)|gdpr|accurate to the best|understand that/i;

const NEGATIVE_WORDS =
  /felony|lawsuit|convicted|criminal|terminated|fired|non-compete|debarred|disciplinary|misconduct/i;

const SPONSOR_WORDS = /sponsor|visa/i;

// Last-resort answer for a question with a fixed set of options (radio/select/
// checkbox). Easy Apply will not let the form advance if a required field is left
// blank, so — unlike the old AI fallback — this never returns '' when options exist.
function bestGuessFromOptions(question, options) {
  const q = String(question || '').toLowerCase();

  if (NEGATIVE_WORDS.test(q) || SPONSOR_WORDS.test(q)) {
    return findOption(options, /\bno\b/i) || options[options.length - 1] || '';
  }
  if (
    CONSENT_WORDS.test(q) ||
    /^(do|have|are|can|will|is|has)\b/.test(q) ||
    /relocat|authoriz|eligible|available/.test(q)
  ) {
    return findOption(options, /\byes\b/i) || options[0] || '';
  }
  // Truly ambiguous: still pick something so the form can advance rather than
  // stalling on a blank required field.
  return options[0] || '';
}

function buildTextareaAnswer(question, jobTitle, company) {
  const q = String(question || '').toLowerCase();

  if (/cover|letter|introduce|about yourself|why (are you|do you want)|why should/.test(q)) {
    return coverLetter(jobTitle, company);
  }

  const fromResume = profile.answerFromResume(question, 'textarea', []);
  if (fromResume) return fromResume;

  return profile.summary;
}

function coverLetter(jobTitle, company) {
  const role = jobTitle ? ` for the ${jobTitle} role` : '';
  const at = company ? ` at ${company}` : '';
  return (
    `${profile.summary} With ${config.experienceYears} years of experience, I'm confident I can contribute` +
    `${role}${at} from day one. My current CTC is ${current.full()}, my expectation is ${expected.full()}, ` +
    `and my notice period is ${config.noticePeriod}.`
  );
}

function answerQuestion(question, jobTitle = '', company = '', inputType = 'text', options = []) {
  console.log(`\n📄 Filling from CV/config [${inputType}]: "${question}"`);
  if (options.length) console.log(`   Options: ${options.join(' | ')}`);

  // 1. Deterministic facts from config.js (salary, notice period, experience, etc.)
  let answer = deterministicAnswer(question, inputType, options);

  // 2. Facts sourced from the CV (skills, certifications, education, employers).
  if (!answer) answer = profile.answerFromResume(question, inputType, options);

  // 3. Textarea prompts (cover letter, "about yourself", open-ended) built from the
  //    resume summary — never sent to an external model.
  if (!answer && inputType === 'textarea') answer = buildTextareaAnswer(question, jobTitle, company);

  // 4. Conservative heuristic fallback (yes/no phrasing, generic patterns).
  if (!answer) answer = localFallback(question, inputType, options);

  // 5. Never leave a field with fixed options blank — that stalls Easy Apply.
  if (!answer && options.length > 0) answer = bestGuessFromOptions(question, options);

  // Resolve against the option list. Numeric answers skip matchOption's loose
  // substring matching (e.g. "0" is a substring of "30 days" — that would silently
  // match the wrong option) and go straight to exact/numeric-range matching.
  const isNumericAnswer = /^-?\d+(?:\.\d+)?$/.test(String(answer).trim());
  let normalized = answer;
  if (options.length) {
    if (isNumericAnswer) {
      const exact = options.find((o) => String(o).trim() === String(answer).trim());
      normalized = exact || matchNumericOption(answer, options) || answer;
    } else {
      normalized = matchOption(answer, options) || matchNumericOption(answer, options) || answer;
    }
  }
  console.log(`✅ Answer: "${normalized}"`);
  return Promise.resolve(normalized);
}

function generateCoverLetter(jobTitle, company) {
  console.log(`\n📝 Building cover letter from CV for ${jobTitle} at ${company}...`);
  return Promise.resolve(coverLetter(jobTitle, company));
}

module.exports = { answerQuestion, generateCoverLetter };
