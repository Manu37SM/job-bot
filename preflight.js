// Config validation that runs before any browser opens. Every problem here used to
// surface as a mysterious mid-run failure — a missing resume meant upload fields
// were silently skipped, a bad customAnswers entry was ignored without a word, and
// a typo'd skill name simply never matched. Ten seconds of checking beats
// discovering it twenty applications in.
const fs = require('fs');
const path = require('path');
const config = require('./config');

function fileIssues() {
  const issues = [];

  const resume = path.resolve(__dirname, config.resumePath || '');
  if (!config.resumePath) {
    issues.push({ level: 'error', message: 'config.resumePath is not set.' });
  } else if (!fs.existsSync(resume)) {
    issues.push({
      level: 'error',
      message: `Resume not found at ${config.resumePath} — upload fields would be skipped silently.`,
    });
  }

  const cvText = resume.replace(/\.pdf$/i, '.txt');
  if (fs.existsSync(resume) && !fs.existsSync(cvText)) {
    issues.push({
      level: 'warn',
      message: `No CV text at ${path.basename(cvText)} — skill questions fall back to the shorter skills list in resume-profile.js.`,
    });
  }

  if (!fs.existsSync(path.join(__dirname, 'session-linkedin.json'))) {
    issues.push({
      level: 'error',
      message: 'No saved session. Run: node save-session.js linkedin',
    });
  }

  return issues;
}

function numberIssues() {
  const issues = [];
  const { currentCTC, expectedCTC, experienceYears, skillExperienceYears } = config;

  const current = (currentCTC?.fixed || 0) + (currentCTC?.variable || 0);
  const expected = (expectedCTC?.fixed || 0) + (expectedCTC?.variable || 0);

  if (!(current > 0))
    issues.push({ level: 'warn', message: 'currentCTC is zero — salary answers will be 0.' });
  if (!(expected > 0))
    issues.push({ level: 'warn', message: 'expectedCTC is zero — salary answers will be 0.' });
  if (current > 0 && expected > 0 && expected < current) {
    issues.push({
      level: 'warn',
      message: `expectedCTC (${expected}) is below currentCTC (${current}) — the derived hike would be negative.`,
    });
  }

  if (!(Number(experienceYears) > 0)) {
    issues.push({ level: 'error', message: 'experienceYears must be a positive number.' });
  }

  for (const [skill, years] of Object.entries(skillExperienceYears || {})) {
    if (!Number.isFinite(Number(years))) {
      issues.push({ level: 'error', message: `skillExperienceYears['${skill}'] is not a number.` });
    } else if (Number(years) > Number(experienceYears || 0)) {
      issues.push({
        level: 'warn',
        message: `skillExperienceYears['${skill}'] (${years}) exceeds your total experience (${experienceYears}).`,
      });
    }
  }

  return issues;
}

// The resume summary and config.experienceYears are both quoted to recruiters —
// the cover letter prints the config figure in the same paragraph as the summary.
// A mismatch between them reads as carelessness at best.
function consistencyIssues() {
  const issues = [];
  let profile;
  try {
    profile = require('./resume-profile');
  } catch {
    return issues;
  }

  const claimed = String(profile.summary || '').match(/(\d+(?:\.\d+)?)\s*\+?\s*years?/i);
  if (!claimed) return issues;

  const summaryYears = Number(claimed[1]);
  const configYears = Number(config.experienceYears);
  if (!Number.isFinite(summaryYears) || !Number.isFinite(configYears)) return issues;

  if (Math.abs(summaryYears - configYears) >= 1) {
    issues.push({
      level: 'warn',
      message:
        `Your resume summary says "${claimed[0]}" but config.experienceYears is ${configYears}. ` +
        'The cover letter prints both in the same paragraph.',
    });
  }

  return issues;
}

function pacingIssues() {
  const issues = [];
  const pacing = config.pacing || {};
  const min = Number(pacing.minSecondsBetweenApps);
  const max = Number(pacing.maxSecondsBetweenApps);

  if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
    issues.push({
      level: 'error',
      message: 'pacing.minSecondsBetweenApps is greater than the max.',
    });
  }
  if (Number.isFinite(min) && min < 20) {
    issues.push({
      level: 'warn',
      message: `pacing.minSecondsBetweenApps is ${min}s — fast enough to look automated. 45s+ is safer.`,
    });
  }

  const limits = config.maxApplications?.linkedin || {};
  if ((limits.perDay ?? 15) > 40) {
    issues.push({
      level: 'warn',
      message: `perDay is ${limits.perDay} — well above what one person plausibly submits by hand.`,
    });
  }
  if (limits.perRun > (limits.perDay ?? 15)) {
    issues.push({
      level: 'warn',
      message: 'perRun exceeds perDay, so perDay is the real ceiling.',
    });
  }

  return issues;
}

function answerIssues() {
  const issues = [];

  const entries = config.customAnswers;
  if (entries != null && !Array.isArray(entries)) {
    issues.push({ level: 'error', message: 'config.customAnswers must be an array.' });
  } else {
    (entries || []).forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        issues.push({ level: 'error', message: `customAnswers[${index}] is not an object.` });
        return;
      }
      const okMatch = typeof entry.match === 'string' || entry.match instanceof RegExp;
      if (!okMatch) {
        issues.push({
          level: 'error',
          message: `customAnswers[${index}].match must be a string or a RegExp — this entry never matches.`,
        });
      }
      if (entry.answer == null || String(entry.answer).trim() === '') {
        issues.push({
          level: 'warn',
          message: `customAnswers[${index}] has an empty answer — it is ignored. (Paste-ready entries ship blank on purpose.)`,
        });
      }
    });
  }

  const countries = config.authorization?.authorizedCountries;
  if (Array.isArray(countries) && countries.length === 0) {
    issues.push({
      level: 'error',
      message:
        'authorization.authorizedCountries is empty — every work-authorization question would answer No.',
    });
  }

  if (!config.positions?.length)
    issues.push({ level: 'error', message: 'config.positions is empty.' });
  if (!config.locations?.preferredCities?.length && !config.locations?.otherCities?.length) {
    issues.push({ level: 'error', message: 'No search locations configured.' });
  }

  return issues;
}

// An unrecognised level name produces an EMPTY f_E filter, which silently widens
// the search to every seniority instead of narrowing it — the opposite of intent.
function searchIssues() {
  const issues = [];
  const search = config.search || {};
  const { LEVELS } = require('./search-filters');

  if (search.experienceLevels != null) {
    if (!Array.isArray(search.experienceLevels)) {
      issues.push({ level: 'error', message: 'search.experienceLevels must be an array.' });
    } else {
      const unknown = search.experienceLevels.filter(
        (name) => !LEVELS[String(name).toLowerCase().trim()]
      );
      if (unknown.length) {
        issues.push({
          level: 'error',
          message: `Unknown search.experienceLevels: ${unknown.join(', ')}. Valid: ${Object.keys(LEVELS).join(', ')}.`,
        });
      }
    }
  }

  const days = search.postedWithinDays;
  if (days != null && (!Number.isFinite(Number(days)) || Number(days) < 0)) {
    issues.push({ level: 'error', message: 'search.postedWithinDays must be a positive number or null.' });
  }
  if (Number(days) > 0 && Number(days) < 1) {
    issues.push({
      level: 'warn',
      message: `search.postedWithinDays is ${days} — under a day is a very narrow window.`,
    });
  }

  return issues;
}

function collectIssues() {
  return [
    ...fileIssues(),
    ...numberIssues(),
    ...pacingIssues(),
    ...answerIssues(),
    ...searchIssues(),
    ...consistencyIssues(),
  ];
}

// Returns true when it is safe to proceed.
function runPreflight({ quiet = false } = {}) {
  const issues = collectIssues();
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warn');

  if (!issues.length) {
    if (!quiet) console.log('✅ Preflight: config looks good.');
    return true;
  }

  console.log('\n🔎 Preflight');
  for (const issue of errors) console.log(`   ❌ ${issue.message}`);
  for (const issue of warnings) console.log(`   ⚠️  ${issue.message}`);

  if (errors.length) {
    console.log('\n   Fix the errors above before running. Nothing was applied to.\n');
    return false;
  }
  console.log('');
  return true;
}

module.exports = { runPreflight, collectIssues };
