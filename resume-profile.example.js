// YOUR CV, as data. Copy this file to resume-profile.js and fill in your details.
// resume-profile.js is gitignored (like config.js) because it holds personal
// information — employer names, institution, GPA — that shouldn't be committed.
//
// This file contains DATA ONLY. All of the answering logic lives in resume-logic.js
// and is shared, so this template can never drift behind the real implementation.
// It used to carry its own copy, and that copy fell behind: it still claimed a
// Master's degree off the back of a bachelor's, and still claimed certifications
// the CV did not contain, long after both were fixed in the file people actually
// ran. Anyone setting up from the template inherited the fabrications.
const { buildProfile } = require('./resume-logic');

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

module.exports = buildProfile({ skills, certifications, education, employers, summary });
