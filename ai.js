const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const config = require('./config');
const { current, expected } = require('./salary-helper');

const anthropicConfig = config.ai.providers.find((p) => p.name === 'anthropic');
const client = new Anthropic.Anthropic({ apiKey: anthropicConfig?.apiKey || '' });

let resumeText = '';
function loadResume() {
  if (resumeText) return resumeText;
  try {
    const txtPath = config.resumePath.replace('.pdf', '.txt');
    if (fs.existsSync(txtPath)) {
      resumeText = fs.readFileSync(txtPath, 'utf-8');
    } else {
      resumeText = `
        Name: ${config.name}
        Experience: ${config.experienceYears} years
        Skills: Full Stack Development, Node.js, React, PostgreSQL, Express.js, JavaScript, TypeScript
        Current CTC: ${current.full()}
        Expected CTC: ${expected.full()}
        Notice Period: ${config.noticePeriod}
        Location: ${config.location}
      `;
    }
  } catch (e) {
    console.log('Resume file not found, using config details.');
  }
  return resumeText;
}

function getCandidateProfile() {
  return `
CANDIDATE PROFILE:
- Name: ${config.name}
- Experience: ${config.experienceYears} years
- Current CTC: ${current.full()} (fixed: ${current.fixed()} LPA, variable: ${current.variable()} LPA)
- Expected CTC: ${expected.full()}
- Notice Period: ${config.noticePeriod}
- Last Working Day: ${config.lastWorkingDay}
- Location: ${config.location}
- Job Types Applying For: ${config.jobTypes.join(', ')}
RESUME SUMMARY:
${loadResume()}`.trim();
}

async function answerQuestion(
  question,
  jobTitle = '',
  company = '',
  inputType = 'text',
  options = []
) {
  console.log(`\n🤖 AI answering [${inputType}]: "${question}"`);
  if (options.length) console.log(`   Options: ${options.join(' | ')}`);

  const optionsText = options.length
    ? `AVAILABLE OPTIONS (pick exactly one): ${options.join(' | ')}`
    : '';

  const formatInstructions = getFormatInstructions(inputType, options);

  const prompt = `
You are filling out a job application form for a candidate.

JOB: ${jobTitle} at ${company}

${getCandidateProfile()}

FORM QUESTION: "${question}"
INPUT TYPE: ${inputType}
${optionsText}

${formatInstructions}

RULES:
- If asked about salary/CTC: current is ${current.total()} LPA, expected is ${expected.total()} LPA
- If asked about notice period: ${config.noticePeriod}
- If asked about experience: ${config.experienceYears} years
- If asked about relocation: Yes (candidate is open to it)
- If asked about work authorization/eligibility in India: Yes
- If asked about visa sponsorship needed: No
- If asked about immediate joining: No, notice period is ${config.noticePeriod}
- For yes/no questions about skills/tools mentioned in resume: Yes
- For yes/no questions about illegal activity, lawsuits, felonies: No

ANSWER (just the value, nothing else):`.trim();

  try {
    const response = await client.messages.create({
      model: anthropicConfig?.model || 'claude-3-5-sonnet-latest',
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    });

    let answer = response.content[0].text.trim();

    answer = answer.replace(/^["']|["']$/g, '').trim();

    if (options.length > 0) {
      const match = options.find(
        (o) =>
          o.toLowerCase() === answer.toLowerCase() ||
          o.toLowerCase().includes(answer.toLowerCase()) ||
          answer.toLowerCase().includes(o.toLowerCase())
      );
      if (match) answer = match;
      else answer = options[0];
    }

    console.log(`✅ AI Answer: "${answer}"`);
    return answer;
  } catch (err) {
    console.error('AI error:', err.message);
    return smartFallback(question, inputType, options);
  }
}

function getFormatInstructions(inputType, options) {
  switch (inputType) {
    case 'radio':
    case 'select':
      return `Return ONLY one of the available options EXACTLY as written. Nothing else.`;
    case 'number':
      return `Return ONLY a number. No units, no text, just the digits (e.g. 3, 5.5, 570000).`;
    case 'checkbox':
      return `Return "Yes" or "No" only.`;
    case 'textarea':
      return `Return a professional 2-3 sentence response. Be concise and relevant to the job.`;
    default:
      return `Return a short, direct answer. For yes/no questions return "Yes" or "No". For numeric questions return just the number.`;
  }
}

function smartFallback(question, inputType, options) {
  console.log('  ⚡ Using smart fallback (no API credits)');
  const l = question.toLowerCase();

  if (
    l.includes('current') &&
    (l.includes('ctc') || l.includes('salary') || l.includes('compensation') || l.includes('etc'))
  )
    return String(current.total());
  if (
    (l.includes('expect') || l.includes('desired') || l.includes('ectc')) &&
    (l.includes('ctc') || l.includes('salary') || l.includes('compensation') || l.includes('etc'))
  )
    return String(expected.total());
  if (l === 'what is your ctc?' || l === 'what is your ctc' || l === 'ctc?')
    return String(current.total());
  if (
    l === 'what is your etc?' ||
    l === 'what is your etc' ||
    l === 'what is your ectc?' ||
    l === 'ectc?'
  )
    return String(expected.total());
  if (l.includes('ctc') && !l.includes('expect')) return String(current.total());
  if (l.includes('ectc') || l.includes('expected ctc')) return String(expected.total());
  if (l.includes('salary') && !l.includes('expect')) return String(current.total());
  if (l.includes('salary') && l.includes('expect')) return String(expected.total());
  if (l.includes('fixed') && l.includes('current')) return String(current.fixed());
  if (l.includes('variable') || l.includes('bonus')) return String(current.variable());
  if (l.includes('hike') || l.includes('increment')) return '30';

  if (l.includes('year') && l.includes('experience')) return String(config.experienceYears);
  if (l.includes('how long') && l.includes('work')) return String(config.experienceYears);
  if (l.includes('total experience')) return String(config.experienceYears);

  if (l.includes('notice') || l.includes('last working') || l.includes('joining'))
    return config.noticePeriod.replace(/\D/g, '');

  if (l.includes('current location') || l.includes('city')) return config.location;
  if (l.includes('willing to relocate') || l.includes('relocat')) {
    if (options.length) return options.find((o) => /yes/i.test(o)) || options[0];
    return 'Yes';
  }

  if (l.includes('authoriz') || l.includes('eligible') || l.includes('legally')) {
    if (options.length) return options.find((o) => /yes/i.test(o)) || options[0];
    return 'Yes';
  }
  if (l.includes('sponsor') || l.includes('visa')) {
    if (options.length) return options.find((o) => /no/i.test(o)) || options[options.length - 1];
    return 'No';
  }

  if (
    l.includes('have you') ||
    l.includes('do you') ||
    l.includes('are you') ||
    l.includes('can you')
  ) {
    if (
      l.includes('felony') ||
      l.includes('lawsuit') ||
      l.includes('crime') ||
      l.includes('terminated') ||
      l.includes('non-compete')
    )
      return options.find((o) => /no/i.test(o)) || 'No';

    if (options.length) return options.find((o) => /yes/i.test(o)) || options[0];
    return 'Yes';
  }

  if (options.length > 0) return options[0];

  if (inputType === 'number') return String(config.experienceYears);

  return 'Yes';
}

async function generateCoverLetter(jobTitle, company, jobDescription = '') {
  console.log(`\n📝 Generating cover letter for ${jobTitle} at ${company}...`);

  const prompt = `
Write a SHORT cover letter (3 sentences) for a job application.

JOB: ${jobTitle} at ${company}
${jobDescription ? `JD: ${jobDescription.slice(0, 300)}` : ''}

${getCandidateProfile()}

Rules:
- Exactly 3 sentences
- Sound human, confident, not robotic
- Mention current CTC ${current.full()}, expected ${expected.full()}, notice period ${config.noticePeriod}
- Start with a strong value statement, not "Dear Hiring Manager"
- No filler phrases like "I am writing to express my interest"

Cover Letter:`.trim();

  try {
    const response = await client.messages.create({
      model: anthropicConfig?.model || 'claude-3-5-sonnet-latest',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    const letter = response.content[0].text.trim();
    console.log('✅ Cover letter ready');
    return letter;
  } catch (err) {
    console.error('Cover letter error:', err.message);
    return `With ${config.experienceYears} years of full-stack development experience, I am confident I can contribute immediately to ${company}'s engineering goals. My current CTC is ${current.full()} and I am seeking ${expected.full()} with a notice period of ${config.noticePeriod}. I look forward to discussing how my skills align with the ${jobTitle} role.`;
  }
}

module.exports = { answerQuestion, generateCoverLetter };
