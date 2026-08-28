#!/usr/bin/env node
const { answerQuestion } = require('./resume-answers');
const policy = require('./question-policy');
const { loadLog } = require('./logger');
const { suggestFix } = require('./failure-report');
const { buildNumericCandidates } = require('./field-value');

const YN = ['Yes', 'No'];

const CORPUS = [
  ['Contact & basics', 'What is your email address?', []],
  ['Contact & basics', 'Mobile phone number', []],
  ['Contact & basics', 'What city do you currently live in?', []],
  ['Contact & basics', 'LinkedIn profile URL', []],

  ['Money & timing', 'What is your current CTC?', []],
  ['Money & timing', 'What is your expected CTC (in LPA)?', []],
  ['Money & timing', 'Expected annual salary in INR', []],
  ['Money & timing', 'What percentage hike are you expecting?', []],
  [
    'Money & timing',
    'What is your notice period?',
    ['Immediate', '15 days', '30 days', '60 days', '90 days'],
  ],
  ['Money & timing', 'Notice period in days', []],
  ['Money & timing', 'Are you an immediate joiner?', YN],
  ['Money & timing', 'What is your last working day?', []],

  ['Experience', 'How many years of total work experience do you have?', []],
  ['Experience', 'How many years of experience do you have with Java?', []],
  [
    'Experience',
    'Years of experience in Spring Boot',
    ['0-1 years', '1-3 years', '3-5 years', '5+ years'],
  ],
  ['Experience', 'How many years of experience do you have with React?', []],
  ['Experience', 'How many years of experience do you have with Python?', []],
  ['Experience', 'How many years of experience do you have with Kubernetes?', []],
  ['Experience', 'How long have you been at your current company?', []],
  ['Experience', 'What is your tenure at your current organisation?', []],
  ['Experience', 'How long have you been working in software?', []],

  ['Skill claims', 'Do you have experience with Kong Gateway?', YN],
  ['Skill claims', 'Do you have experience with Kubernetes?', YN],
  ['Skill claims', 'Do you have experience with Rust?', YN],
  ['Skill claims', 'Are you proficient in COBOL?', YN],
  ['Skill claims', 'Do you have hands-on experience with Kafka?', YN],
  ['Skill claims', 'Do you have experience working in fast-paced environments?', YN],

  ['Credentials', 'Do you have a Bachelor’s degree?', YN],
  ['Credentials', 'Do you have a Master’s degree?', YN],
  ['Credentials', 'Do you have an MBA?', YN],
  ['Credentials', 'Do you hold a PMP certification?', YN],
  ['Credentials', 'Are you AWS certified?', YN],
  ['Credentials', 'Do you have any relevant certifications?', YN],

  ['Eligibility', 'Are you legally authorized to work in India?', YN],
  ['Eligibility', 'Are you legally authorized to work in the United States?', YN],
  ['Eligibility', 'Do you have the right to work in the UK?', YN],
  ['Eligibility', 'Are you legally authorized to work?', YN],
  ['Eligibility', 'Will you now or in the future require sponsorship for a US work visa?', YN],
  ['Eligibility', 'Will you require visa sponsorship to work in India?', YN],

  ['Protected', 'What is your gender?', ['Male', 'Female', 'I prefer not to say']],
  ['Protected', 'What is your race/ethnicity?', ['Asian', 'White', 'Decline to self-identify']],
  ['Protected', 'Are you a protected veteran?', ['Yes', 'No', 'I prefer not to answer']],
  ['Protected', 'Do you have a disability?', ['Yes', 'No']],
  ['Protected', 'What is your date of birth?', []],

  ['Legal', 'Have you ever been convicted of a felony?', YN],
  ['Legal', 'Are you currently subject to a non-compete agreement?', YN],

  ['Consent', 'Do you consent to a background check?', YN],
  ['Consent', 'I certify that the information provided is accurate', YN],
  ['Consent', 'Do you agree to our privacy policy?', YN],

  ['Logistics', 'Are you willing to relocate to Thane?', YN],
  ['Logistics', 'Are you willing to relocate to Bangalore?', YN],
  ['Logistics', 'Are you willing to relocate?', YN],
  ['Logistics', 'Are you willing to work night shifts?', YN],
  ['Logistics', 'Are you comfortable working from the office 5 days a week?', YN],
];

function silence(fn) {
  const original = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = original;
  }
}

async function runCorpus() {
  console.log('\n🔍 ANSWER PREFLIGHT — what the bot would say, using your current config\n');

  let refused = 0;
  let answered = 0;
  let group = '';

  for (const [category, question, options] of CORPUS) {
    if (category !== group) {
      group = category;
      console.log(`\n\x1b[1m${category}\x1b[0m`);
    }
    const type = options.length ? 'radio' : 'text';
    const answer = await silence(() =>
      answerQuestion(question, 'Backend Engineer', 'Acme', type, options)
    );
    const value = String(answer || '');
    const kind = policy.classify(question);

    if (value) {
      answered++;
      let shown = value;
      if (!options.length && /^-?\d+(?:\.\d+)?$/.test(value)) {
        const candidates = buildNumericCandidates(value, question, {
          inputType: 'number',
          step: '',
        });
        if (candidates.length && candidates[0] !== value) {
          shown = `${candidates[0]}  \x1b[2m(from ${value})\x1b[0m`;
        }
      }
      console.log(`  ✓ ${shown.padEnd(42)} ${question}`);
    } else {
      refused++;
      console.log(`  ⚠ ${'(no answer)'.padEnd(42)} ${question}`);
      console.log(
        `    ${''.padEnd(42)} \x1b[2m${kind} — ${suggestFix({ question, options })}\x1b[0m`
      );
    }
  }

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`${answered} answered · ${refused} deliberately unanswered`);
  if (refused) {
    console.log('\nUnanswered is not a bug — these are questions where a guess would be a');
    console.log('claim the bot cannot support. Add them to config.customAnswers to fill them.');
  }
  console.log();
}

function auditLog() {
  const log = loadLog();
  const withAnswers = log.filter((e) => e.status === 'applied' && e.answers?.length);

  console.log('\n📋 SUBMITTED ANSWERS — what has gone out under your name\n');

  if (!withAnswers.length) {
    const applied = log.filter((e) => e.status === 'applied').length;
    console.log(`No answer trail recorded yet (${applied} applications predate this feature).`);
    console.log('Answers are captured from the next run onward.\n');
    return;
  }

  const byQuestion = new Map();
  for (const entry of withAnswers) {
    for (const { question, answer } of entry.answers) {
      const key = question.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!byQuestion.has(key)) byQuestion.set(key, { question, answers: new Map() });
      const bucket = byQuestion.get(key).answers;
      bucket.set(answer, (bucket.get(answer) || 0) + 1);
    }
  }

  const rows = [...byQuestion.values()].sort(
    (a, b) =>
      [...b.answers.values()].reduce((x, y) => x + y, 0) -
      [...a.answers.values()].reduce((x, y) => x + y, 0)
  );

  for (const row of rows) {
    const variants = [...row.answers.entries()].sort((a, b) => b[1] - a[1]);
    const flag = variants.length > 1 ? ' \x1b[33m⚠ inconsistent\x1b[0m' : '';
    console.log(`\x1b[1m${row.question.slice(0, 90)}\x1b[0m${flag}`);
    for (const [answer, count] of variants) {
      console.log(`   ${String(count).padStart(4)}×  ${answer.slice(0, 80)}`);
    }
    console.log();
  }

  console.log(`${'─'.repeat(72)}`);
  console.log(`${rows.length} distinct questions across ${withAnswers.length} applications\n`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--log') return auditLog();

  if (args[0] && !args[0].startsWith('--')) {
    const question = args[0];
    const options = args[1] ? args[1].split(',').map((o) => o.trim()) : [];
    const answer = await answerQuestion(
      question,
      'Backend Engineer',
      'Acme',
      options.length ? 'radio' : 'text',
      options
    );
    console.log(`\nclassified as : ${policy.classify(question)}`);
    console.log(`may guess     : ${policy.mayGuess(question)}`);
    console.log(`answer        : ${answer ? `"${answer}"` : '(none — would stall the form)'}\n`);
    return;
  }

  await runCorpus();
}

if (require.main === module) main();

module.exports = { CORPUS, runCorpus, auditLog };
