const config = require('./config');
const { current, expected } = require('./salary-helper');
const {
  deterministicAnswer,
  localFallback,
  matchOption,
  matchNumericOption,
} = require('./answer-utils');
const policy = require('./question-policy');
const profile = require('./resume-profile');

function findOption(options, pattern) {
  return options.find((o) => pattern.test(o)) || '';
}

const CONSENT_WORDS =
  /consent|agree|acknowledge|confirm|certify|terms (and|&) conditions|privacy policy|background check|reference check|drug test|data (processing|protection)|gdpr|accurate to the best|understand that/i;

const NEGATIVE_WORDS =
  /felony|lawsuit|convicted|criminal|terminated|fired|non-compete|debarred|disciplinary|misconduct/i;

const SPONSOR_WORDS = /sponsor|visa/i;

function bestGuessFromOptions(question, options) {
  const q = String(question || '').toLowerCase();

  if (!policy.mayGuess(question)) return '';

  if (NEGATIVE_WORDS.test(q) || SPONSOR_WORDS.test(q)) {
    return findOption(options, /\bno\b/i) || options[options.length - 1] || '';
  }
  if (
    CONSENT_WORDS.test(q) ||
    /^(do|have|are|can|will|is|has)\b/.test(q) ||
    /relocat|eligible|available/.test(q)
  ) {
    return findOption(options, /\byes\b/i) || options[0] || '';
  }
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
  const preferences = config.coverLetter || {};

  const parts = [
    profile.summary,
    `With ${config.experienceYears} years of experience, I'm confident I can contribute${role}${at} from day one.`,
  ];

  if (preferences.includeSalary === true) {
    parts.push(`My current CTC is ${current.full()} and my expectation is ${expected.full()}.`);
  }
  if (preferences.includeNotice !== false) {
    parts.push(`My notice period is ${config.noticePeriod}.`);
  }

  return parts.join(' ');
}

function answerQuestion(question, jobTitle = '', company = '', inputType = 'text', options = []) {
  console.log(`\n📄 Filling from CV/config [${inputType}]: "${question}"`);
  if (options.length) console.log(`   Options: ${options.join(' | ')}`);

  let answer = policy.customAnswer(question, options);
  if (answer) console.log('   ↳ matched a config.customAnswers entry');

  if (!answer) answer = deterministicAnswer(question, inputType, options);

  if (!answer) answer = profile.answerFromResume(question, inputType, options);

  if (!answer && inputType === 'textarea')
    answer = buildTextareaAnswer(question, jobTitle, company);

  if (!answer) answer = localFallback(question, inputType, options);

  if (!answer && options.length > 0) answer = bestGuessFromOptions(question, options);

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
