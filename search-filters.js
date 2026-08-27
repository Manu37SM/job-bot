// LinkedIn search filter construction.
//
// These were hard-coded: `f_E=2,3,4` (Entry + Associate + Mid-Senior) for everyone,
// and no date filter at all. Both cost applications from a deliberately small daily
// budget — Entry-level postings for a mid-career candidate, and postings from six
// weeks ago that have already been filled.
const config = require('./config');

// LinkedIn's experience-level codes.
const LEVELS = {
  internship: '1',
  entry: '2',
  associate: '3',
  'mid-senior': '4',
  director: '5',
  executive: '6',
};

// Bands chosen to overlap by design: a 4-year candidate is a plausible fit for both
// Associate and Mid-Senior postings, and excluding either loses real matches.
function levelsForExperience(years) {
  const value = Number(years);
  if (!Number.isFinite(value) || value < 0) return ['associate', 'mid-senior'];
  if (value < 1) return ['internship', 'entry'];
  if (value < 3) return ['entry', 'associate'];
  if (value < 7) return ['associate', 'mid-senior'];
  if (value < 12) return ['mid-senior', 'director'];
  return ['director', 'executive'];
}

function experienceLevelParam() {
  const configured = config.search?.experienceLevels;
  const names =
    Array.isArray(configured) && configured.length
      ? configured
      : levelsForExperience(config.experienceYears);

  const codes = names
    .map((name) => LEVELS[String(name).toLowerCase().trim()])
    .filter(Boolean);

  return [...new Set(codes)].sort().join(',');
}

// LinkedIn's "date posted" filter is seconds-ago. A posting that has been up for six
// weeks has usually been filled or buried; fresh ones are where a reply comes from.
function postedWithinParam() {
  const days = config.search?.postedWithinDays;
  if (days == null) return '';
  const value = Number(days);
  if (!Number.isFinite(value) || value <= 0) return '';
  return `r${Math.round(value * 86400)}`;
}

function buildSearchUrl({ position, location, workModes }) {
  const workModeMap = { onsite: '1', remote: '2', hybrid: '3' };
  const workModeParam = (workModes || [])
    .map((m) => workModeMap[String(m).toLowerCase()])
    .filter(Boolean)
    .join(',');

  const jobTypeMap = { permanent: 'F', 'full-time': 'F', contract: 'C', internship: 'I', 'part-time': 'P', temporary: 'T' };
  const jobTypeParam = (config.jobTypes || [])
    .map((t) => jobTypeMap[String(t).toLowerCase()])
    .filter(Boolean)
    .join(',');

  // Built by hand rather than with URLSearchParams: that encodes spaces as "+"
  // and commas as "%2C", and the existing URL format (spaces as %20, literal
  // commas in f_E/f_WT) is known to work. Not worth changing what works.
  const parts = [
    `keywords=${encodeURIComponent(position)}`,
    `location=${encodeURIComponent(location)}`,
    'f_LF=f_AL', // Easy Apply only
  ];

  const levels = experienceLevelParam();
  if (levels) parts.push(`f_E=${levels}`);
  if (workModeParam) parts.push(`f_WT=${workModeParam}`);
  if (jobTypeParam) parts.push(`f_JT=${jobTypeParam}`);

  const posted = postedWithinParam();
  if (posted) parts.push(`f_TPR=${posted}`);
  if (config.search?.sortByDate) parts.push('sortBy=DD');

  return `https://www.linkedin.com/jobs/search/?${parts.join('&')}`;
}

function describeFilters() {
  const levels = Object.entries(LEVELS)
    .filter(([, code]) => experienceLevelParam().split(',').includes(code))
    .map(([name]) => name);
  const days = config.search?.postedWithinDays;
  return {
    levels,
    postedWithinDays: Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : null,
  };
}

module.exports = { buildSearchUrl, levelsForExperience, experienceLevelParam, postedWithinParam, describeFilters, LEVELS };
