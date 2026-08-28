const { buildProfile } = require('./resume-logic');

const skills = ['JavaScript', 'TypeScript', 'Node.js', 'React', 'SQL'];

const certifications = [];

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
