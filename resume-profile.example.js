// Structured facts pulled from the candidate's CV. No network calls, no AI provider —
// this is the "manual" reference the bot uses to fill out Easy Apply questions that
// config.js alone can't answer (skills, certifications, education, project history).
//
// Copy this file to resume-profile.js and fill in your own details. resume-profile.js
// is gitignored (like config.js) because it contains personal information — employer
// names, institution, GPA — that shouldn't be committed.
const fs = require('fs');
const config = require('./config');

const skills = [
  'JavaScript',
  'TypeScript',
  'Node.js',
  'React',
  'SQL',
  // Add every technology, framework, and tool your CV mentions. The bot matches
  // these word-for-word (and against the resume text below) to answer "Do you have
  // experience with X?" questions.
];

const certifications = [
  // e.g. 'AWS Certified Solutions Architect'
];

const education = {
  degree: 'Bachelor of Science in Computer Science',
  degreeLevel: 'bachelor',
  institution: 'Your University',
  years: '2018–2022',
  gpaPercent: 0,
};

const employers = [
  { title: 'Your Current Title', company: 'Current Employer', period: 'Month Year – Present' },
  { title: 'Your Previous Title', company: 'Previous Employer', period: 'Month Year – Month Year' },
];

const summary =
  'One or two sentences summarizing your experience, the way you would want it to appear ' +
  'in a "Tell us about yourself" field or cover letter opener.';

let resumeText = '';
function loadResumeText() {
  if (resumeText) return resumeText;
  try {
    const txtPath = config.resumePath.replace(/\.pdf$/i, '.txt');
    if (fs.existsSync(txtPath)) {
      resumeText = fs.readFileSync(txtPath, 'utf-8');
    }
  } catch (e) {
    // No resume text on disk — structured facts above still cover most questions.
  }
  return resumeText;
}

// Does the resume/skill list mention this technology? Word-boundary match so "Go"
// doesn't match "Google" etc.
function mentionsSkill(text) {
  const needle = String(text || '')
    .trim()
    .toLowerCase();
  if (!needle) return false;
  if (skills.some((s) => s.toLowerCase() === needle)) return true;

  const haystacks = [...skills.map((s) => s.toLowerCase()), loadResumeText().toLowerCase()];
  return haystacks.some((h) => h.includes(needle));
}

// Extract the technology/skill name a question is asking about, e.g.
// "Do you have experience with Kong Gateway?" -> "Kong Gateway"
function extractSkillFromQuestion(question) {
  const q = String(question || '');
  for (const skill of skills) {
    const re = new RegExp(`\\b${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(q)) return skill;
  }
  return null;
}

function findOption(options, pattern) {
  return options.find((o) => pattern.test(o)) || '';
}

// Best-effort answer sourced from the CV for questions config.js can't resolve.
// Returns '' when nothing in the resume is relevant (caller falls back further).
function answerFromResume(question, inputType = 'text', options = []) {
  const q = String(question || '').toLowerCase();
  const yes = () => findOption(options, /\byes\b/i) || 'Yes';
  const no = () => findOption(options, /\bno\b/i) || 'No';

  // Degree / education questions.
  if (/degree|bachelor|graduate|qualification|diploma/.test(q)) {
    if (/do you have|have you completed|are you a graduate/.test(q) || options.length) {
      return yes();
    }
    return education.degree;
  }
  if (/university|college|institution/.test(q)) return education.institution;
  if (/gpa|percentage|cgpa/.test(q) && /education|academic|college|degree/.test(q)) {
    return String(education.gpaPercent);
  }

  // Certification questions.
  const askedCert = certifications.find((c) => q.includes(c.toLowerCase()));
  if (askedCert) return options.length ? yes() : 'Yes';
  if (/certificat/.test(q) && (/do you have|any relevant/.test(q) || options.length)) {
    return certifications.length ? yes() : no();
  }

  // Skill / technology familiarity questions ("Do you have experience with X?",
  // "Are you proficient in X?", checkbox lists of tech stacks, etc.)
  const skillFromQuestion = extractSkillFromQuestion(question);
  if (skillFromQuestion) {
    if (options.length) return mentionsSkill(skillFromQuestion) ? yes() : no();
    if (/do you|have you|are you|experience|familiar|proficient|skilled|knowledge of/.test(q)) {
      return mentionsSkill(skillFromQuestion) ? 'Yes' : 'No';
    }
  }

  // Current/previous employer questions.
  if (/current company|current employer|where do you (currently )?work/.test(q)) {
    return employers[0]?.company || '';
  }
  if (/previous company|previous employer|last company/.test(q)) {
    return employers[1]?.company || '';
  }

  // Open-ended prompts ("tell us about yourself", "professional summary",
  // "why should we hire you") — answer with the resume summary, no LLM involved.
  if (
    inputType === 'textarea' ||
    /tell us about yourself|professional summary|about you\b/.test(q)
  ) {
    return summary;
  }

  return '';
}

module.exports = {
  skills,
  certifications,
  education,
  employers,
  summary,
  loadResumeText,
  mentionsSkill,
  extractSkillFromQuestion,
  answerFromResume,
};
