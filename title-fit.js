// Screens a job TITLE before the description is even read.
//
// The experience screen in job-fit.js catches "10+ years required". It cannot catch
// a posting that is simply for a different job. On the first real dry run, five of
// the eight jobs the bot would have applied to were a .NET role, a Data Engineer
// role, an AI Test Engineer role, a frontend-only role, and a Junior position — for
// a mid-career Java/Node backend developer. At fifteen applications a day, that is
// most of the budget spent on postings that were never going to reply.
//
// Deliberately exclusion-only: it never requires a title to match something, because
// "Software Engineer" is a perfectly good title that names no technology at all. It
// only skips a title that positively names a different stack, discipline, or level.
const config = require('./config');
const profile = require('./resume-profile');

// Technologies that define a role. A title naming one of these is that job — and if
// the CV does not mention it, applying is noise. Checked against the CV rather than
// hard-coded, so this list stays right if the CV changes.
const STACK_MARKERS = [
  '.net',
  'c#',
  'asp.net',
  'vb.net',
  'php',
  'laravel',
  'ruby on rails',
  'rails',
  'golang',
  'go developer',
  'django',
  'flask',
  'salesforce',
  'sap',
  'abap',
  'powerbuilder',
  'mainframe',
  'cobol',
  'sharepoint',
  'drupal',
  'wordpress',
  'magento',
  'servicenow',
  'pega',
  'sitecore',
  'adobe experience',
  'sitefinity',
  'perl',
  'scala',
  'rust',
  'elixir',
  'delphi',
];

// Disciplines that are not this candidate's job, however senior.
const ROLE_EXCLUDES = [
  'data engineer',
  'data scientist',
  'data analyst',
  'machine learning',
  'ml engineer',
  'ai engineer',
  'ai test',
  'test engineer',
  'qa engineer',
  'quality engineer',
  'automation test',
  'test automation',
  'sdet',
  'devops',
  'site reliability',
  'sre',
  'network engineer',
  'security analyst',
  'penetration test',
  'business analyst',
  'product manager',
  'project manager',
  'scrum master',
  'delivery manager',
  'ui/ux',
  'ux designer',
  'ui designer',
  'graphic designer',
  'technical writer',
  'support engineer',
  'android developer',
  'ios developer',
  'flutter',
  'react native developer',
  'embedded',
  'firmware',
  // Frontend-only. The CV has React and Angular, but the stated target roles are
  // FullStack / Backend / Java. Remove this line if you want frontend roles.
  'frontend developer',
  'front end developer',
  'front-end developer',
  'frontend engineer',
];

// Levels below this candidate. Only applied once they have real experience.
const SENIORITY_EXCLUDES = [
  'intern',
  'internship',
  'trainee',
  'fresher',
  'junior',
  'graduate engineer',
  'apprentice',
];

function filters() {
  const configured = config.titleFilters || {};
  return {
    enabled: configured.enabled !== false,
    stack: [...STACK_MARKERS, ...(configured.extraExcludes || [])],
    roles: [...ROLE_EXCLUDES, ...(configured.extraExcludes || [])],
    seniority: configured.excludeJuniorRoles === false ? [] : SENIORITY_EXCLUDES,
    allow: (configured.allow || []).map((a) => String(a).toLowerCase()),
  };
}

// Word-ish containment: "go developer" must not match "Django developer", and
// ".net" must not match "kubernetes.network".
function titleMentions(title, term) {
  const haystack = ` ${String(title)
    .toLowerCase()
    .replace(/[^a-z0-9.#+/ -]/g, ' ')
    .replace(/\s+/g, ' ')} `;
  const needle = String(term).toLowerCase();
  const index = haystack.indexOf(needle);
  if (index === -1) return false;
  const before = haystack[index - 1];
  const after = haystack[index + needle.length];
  const isBoundary = (ch) => ch === undefined || /[^a-z0-9]/.test(ch);
  return isBoundary(before) && isBoundary(after);
}

// Returns { skip: false } or { skip: true, reason }.
function assessTitle(title, { experienceYears = config.experienceYears } = {}) {
  const text = String(title || '').trim();
  const { enabled, stack, roles, seniority, allow } = filters();
  if (!enabled || !text) return { skip: false };

  // An explicit allow entry wins over every rule below.
  if (allow.some((term) => titleMentions(text, term))) return { skip: false };

  for (const marker of stack) {
    if (!titleMentions(text, marker)) continue;
    // Only a mismatch if the CV does not have it.
    if (profile.mentionsSkill(marker)) continue;
    return { skip: true, reason: `title names ${marker}, which is not on your CV` };
  }

  for (const role of roles) {
    if (titleMentions(text, role)) {
      return { skip: true, reason: `${role} is a different discipline` };
    }
  }

  if (Number(experienceYears) >= 2) {
    for (const level of seniority) {
      if (titleMentions(text, level)) {
        return { skip: true, reason: `${level} role, and you have ${experienceYears} years` };
      }
    }
  }

  return { skip: false };
}

module.exports = { assessTitle, titleMentions, STACK_MARKERS, ROLE_EXCLUDES, SENIORITY_EXCLUDES };
