const config = require('./config');
const profile = require('./resume-profile');

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
  'progress developer',
  'openedge',
  'mulesoft',
  'informatica',
  'talend',
  'tibco',
  'siebel',
  'peoplesoft',
  'dynamics 365',
  'guidewire',
  'duck creek',
  'oracle apps',
  'oracle ebs',
  'oracle integration cloud',
];

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
  'security engineer',
  'cyber security',
  'cybersecurity',
  'infosec',
  'soc analyst',
  'sase',
  'solutions engineer',
  'solution engineer',
  'sales engineer',
  'presales',
  'pre-sales',
  'system administrator',
  'database administrator',
  'dba',
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
];

const CORE_ROLE_MARKERS = [
  'full stack',
  'fullstack',
  'full-stack',
  'backend',
  'back end',
  'back-end',
  'java developer',
  'java engineer',
  'node',
  'api developer',
  'api engineer',
  'spring boot',
  'software developer',
  'software engineer',
  'application developer',
];

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

function assessTitle(title, { experienceYears = config.experienceYears } = {}) {
  const text = String(title || '').trim();
  const { enabled, stack, roles, seniority, allow } = filters();
  if (!enabled || !text) return { skip: false };

  if (allow.some((term) => titleMentions(text, term))) return { skip: false };

  for (const marker of stack) {
    if (!titleMentions(text, marker)) continue;
    if (profile.mentionsSkill(marker)) continue;
    return { skip: true, reason: `title names ${marker}, which is not on your CV` };
  }

  const namesCoreRole = CORE_ROLE_MARKERS.some((marker) => titleMentions(text, marker));
  if (!namesCoreRole) {
    for (const role of roles) {
      if (titleMentions(text, role)) {
        return { skip: true, reason: `${role} is a different discipline` };
      }
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

module.exports = {
  assessTitle,
  titleMentions,
  STACK_MARKERS,
  ROLE_EXCLUDES,
  SENIORITY_EXCLUDES,
  CORE_ROLE_MARKERS,
};
