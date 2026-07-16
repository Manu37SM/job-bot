const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const config = require('./config');
const { current, expected } = require('./salary-helper');

const anthropicConfig = config.ai?.providers?.find((p) => p.name === 'anthropic');
const client = new Anthropic.Anthropic({ apiKey: anthropicConfig?.apiKey || '' });

// Hard ceiling on any single AI call. Without this, a hung / rate-limited request
// freezes the whole bot indefinitely — the #1 cause of the bot "getting stuck".
const AI_TIMEOUT_MS = 20000;

// Circuit breaker: once we've seen a few consecutive auth/quota/billing errors we
// assume the API key is exhausted and stop calling the API for the rest of the run.
// This turns every subsequent unknown question into an instant local answer/skip
// instead of a 20s-timeout-per-field death spiral.
const AI_FAILURE_THRESHOLD = 3;
let consecutiveAiFailures = 0;
let aiDisabled = false;

function isAuthOrQuotaError(err) {
  const status = err?.status || err?.response?.status;
  const msg = String(err?.message || '');
  // 401 invalid key, 403 forbidden/perms, 429 rate limit/quota, 529 overloaded,
  // messages mentioning credit/quota/billing exhaustion, OR our own timeout —
  // repeated timeouts also mean the API is effectively dead for this run.
  return (
    status === 401 ||
    status === 403 ||
    status === 429 ||
    status === 529 ||
    /timed out|timeout|credit|quota|billing|rate limit|insufficient|exceeded|unauthor|aborted/i.test(msg)
  );
}

function isAiDisabled() {
  return aiDisabled;
}

// Lightweight local answer so failures degrade gracefully without an API call.
// Uses the deterministic engine + simple heuristics (no network).
function callWithTimeout(createArgs, maxTokens) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  return client.messages
    .create({ ...createArgs, max_tokens: maxTokens }, { signal: controller.signal })
    .catch((err) => {
      if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
        throw new Error(`AI request timed out after ${AI_TIMEOUT_MS}ms`);
      }
      throw err;
    })
    .finally(() => clearTimeout(timer));
}

let resumeText = '';
function loadResume() {
  if (resumeText) return resumeText;
  try {
    const txtPath = config.resumePath.replace('.pdf', '.txt');
    if (fs.existsSync(txtPath)) {
      resumeText = fs.readFileSync(txtPath, 'utf-8');
    } else {
      const skills = Object.keys(config.skillExperienceYears || {}).join(', ') || 'Software Development';
      resumeText = `
        Name: ${config.name}
        Experience: ${config.experienceYears} years
        Skills: ${skills}
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

  // If the API key is exhausted (or persistently failing), don't even try the
  // network — go straight to the local fallback to keep the bot moving.
  if (aiDisabled || !anthropicConfig?.apiKey) {
    if (!aiDisabled && !anthropicConfig?.apiKey) {
      // First call of the run with no key — disable once.
      aiDisabled = true;
      console.log('⚡ AI disabled (no API key). Using local answers only.');
    }
    return smartFallback(question, inputType, options);
  }

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
    const response = await callWithTimeout(
      {
        model: anthropicConfig?.model || 'claude-3-5-sonnet-latest',
        messages: [{ role: 'user', content: prompt }],
      },
      100
    );

    let answer = response?.content?.[0]?.text?.trim() || '';

    answer = answer.replace(/^["']|["']$/g, '').trim();

    if (options.length > 0 && answer) {
      const match = options.find(
        (o) =>
          o.toLowerCase() === answer.toLowerCase() ||
          o.toLowerCase().includes(answer.toLowerCase()) ||
          answer.toLowerCase().includes(o.toLowerCase())
      );
      if (match) answer = match;
      else answer = '';
    }

    console.log(`✅ AI Answer: "${answer}"`);
    consecutiveAiFailures = 0; // a success resets the streak
    return answer;
  } catch (err) {
    console.error('AI error:', err.message);
    if (isAuthOrQuotaError(err)) {
      consecutiveAiFailures++;
      if (consecutiveAiFailures >= AI_FAILURE_THRESHOLD && !aiDisabled) {
        aiDisabled = true;
        console.log(
          `⛔ AI disabled for this run — API key exhausted/invalid (${consecutiveAiFailures} auth/quota errors). Using local answers; un-answerable required fields will be saved for manual application.`
        );
      }
    }
    // Prefer the deterministic engine (it knows salary/experience/notice/etc.)
    // over the looser smartFallback so AI-down produces fewer blank fields.
    const local =
      require('./answer-utils').localFallback(question, inputType, options);
    return local || smartFallback(question, inputType, options);
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

  if (options.length > 0) return '';

  if (inputType === 'number') return String(config.experienceYears);

  return 'Yes';
}

async function generateCoverLetter(jobTitle, company, jobDescription = '') {
  console.log(`\n📝 Generating cover letter for ${jobTitle} at ${company}...`);

  const stockLetter = () =>
    `With ${config.experienceYears} years of full-stack development experience, I am confident I can contribute immediately to ${company}'s engineering goals. My current CTC is ${current.full()} and I am seeking ${expected.full()} with a notice period of ${config.noticePeriod}. I look forward to discussing how my skills align with the ${jobTitle} role.`;

  // Skip the network entirely when AI is exhausted/down — go straight to the
  // pre-written cover letter so we never block on a dead API.
  if (aiDisabled || !anthropicConfig?.apiKey) {
    if (!aiDisabled && !anthropicConfig?.apiKey) aiDisabled = true;
    console.log('⚡ AI disabled — using stock cover letter.');
    return stockLetter();
  }

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
    const response = await callWithTimeout(
      {
        model: anthropicConfig?.model || 'claude-3-5-sonnet-latest',
        messages: [{ role: 'user', content: prompt }],
      },
      200
    );
    const letter = response.content[0].text.trim();
    console.log('✅ Cover letter ready');
    return letter;
  } catch (err) {
    console.error('Cover letter error:', err.message);
    if (isAuthOrQuotaError(err)) {
      consecutiveAiFailures++;
      if (consecutiveAiFailures >= AI_FAILURE_THRESHOLD && !aiDisabled) {
        aiDisabled = true;
        console.log(
          `⛔ AI disabled for this run — API key exhausted/invalid (${consecutiveAiFailures} auth/quota errors).`
        );
      }
    }
    return stockLetter();
  }
}

module.exports = { answerQuestion, generateCoverLetter, isAiDisabled };
