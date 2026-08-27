const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_FILE = path.join(__dirname, 'applications.json');

// How many times a single job may fail before it is retired permanently.
const MAX_FAILED_ATTEMPTS = 3;

// Every failure is tagged with one of these codes so the bot can tell the
// difference between "try again in a second" and "this will fail identically
// forever until the candidate's answers change".
//   transient: true  → worth an automatic retry, and worth re-attempting on a later run.
//   transient: false → deterministic. Re-running changes nothing; the fix is in
//                      config.js / resume-profile.js, so the job is parked until
//                      one of those files actually changes.
const FAILURE_CODES = {
  unanswerable: { transient: false, label: 'Question the bot has no answer for' },
  invalid_field: { transient: false, label: 'Value rejected by the form' },
  stuck_form: { transient: true, label: 'Form stopped advancing' },
  no_action: { transient: true, label: 'No Next/Submit button appeared' },
  modal_missing: { transient: true, label: 'Application modal disappeared' },
  unconfirmed_submit: { transient: true, label: 'Submitted but not confirmed' },
  timeout: { transient: true, label: 'Timed out' },
  error: { transient: true, label: 'Unexpected error' },
};

function isTransient(code) {
  return FAILURE_CODES[code]?.transient !== false;
}

function describeCode(code) {
  // Entries written before failure diagnostics existed have no code at all —
  // say so rather than labelling them "Unknown", which reads like a bug.
  if (!code) return 'Logged before diagnostics existed';
  return FAILURE_CODES[code]?.label || code;
}

// Fingerprint of everything the bot draws answers from. A non-transient failure
// is only worth re-attempting once this changes — that is the signal that the
// user actually edited their answers, rather than just re-running the bot and
// hoping.
let fingerprintCache = null;
function answersFingerprint() {
  if (fingerprintCache) return fingerprintCache;
  const sources = ['config.js', 'resume-profile.js', 'resume-answers.js', 'answer-utils.js'];
  const hash = crypto.createHash('sha1');
  for (const file of sources) {
    const full = path.join(__dirname, file);
    try {
      hash.update(fs.readFileSync(full));
    } catch {
      hash.update(`missing:${file}`);
    }
  }
  fingerprintCache = hash.digest('hex').slice(0, 12);
  return fingerprintCache;
}

// Questions are compared loosely so the same prompt asked by two companies —
// differing only in casing, spacing, or a trailing "*" required-marker — counts
// once. Lives here rather than in failure-report.js so both the console summary
// and the report group identically (and to avoid a require cycle).
function normalizeQuestion(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[*:?.\s]+$/g, '')
    .trim();
}

function loadLog() {
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLog(log) {
  // Write to a temp file and rename, so a crash (or Ctrl+C) mid-write can never
  // leave a truncated applications.json — which loadLog would silently treat as
  // an empty history and re-apply to everything.
  const tmp = `${LOG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(log, null, 2));
  fs.renameSync(tmp, LOG_FILE);
}

function normalizeId(jobId) {
  if (jobId == null) return '';
  const value = String(jobId).trim();
  if (!value || value === 'undefined' || value === 'null') return '';
  return value;
}

function alreadyApplied(jobId) {
  const id = normalizeId(jobId);
  if (!id) return false;
  return loadLog().some((e) => e.jobId === id && e.status === 'applied');
}

function failuresFor(jobId, log = loadLog()) {
  const id = normalizeId(jobId);
  if (!id) return [];
  return log.filter((e) => e && e.jobId === id && e.status === 'failed');
}

// Smart backoff. Returns null when the job is worth attempting, or a short
// human-readable reason string when it should be skipped without opening it.
function shouldSkipJob(jobId) {
  const id = normalizeId(jobId);
  if (!id) return null;

  const failures = failuresFor(id);
  if (failures.length === 0) return null;

  if (failures.length >= MAX_FAILED_ATTEMPTS) {
    return `failed ${failures.length}× already — retired`;
  }

  const last = failures[failures.length - 1];
  if (last.code && !isTransient(last.code) && last.answersHash === answersFingerprint()) {
    const detail = last.reason ? ` (${last.reason.slice(0, 80)})` : '';
    return `${describeCode(last.code).toLowerCase()}; answers unchanged since${detail}`;
  }

  return null;
}

function appliedTodayCount(platform) {
  const log = loadLog();
  if (!platform || typeof platform !== 'string') return 0;
  const today = new Date().toISOString().slice(0, 10);
  const pLow = platform.toLowerCase();
  return log.filter(
    (e) =>
      e &&
      e.platform?.toLowerCase() === pLow &&
      e.status === 'applied' &&
      e.appliedAt?.startsWith(today)
  ).length;
}

function totalAppliedCount(platform) {
  const log = loadLog();
  if (!platform || typeof platform !== 'string') return 0;
  const pLow = platform.toLowerCase();
  return log.filter((e) => e && e.platform?.toLowerCase() === pLow && e.status === 'applied')
    .length;
}

function recordApplication({
  jobId,
  title,
  company,
  platform,
  status,
  link,
  code,
  reason,
  unanswered,
  blockers,
  attempts,
}) {
  const log = loadLog();
  const id = normalizeId(jobId) || String(jobId);
  const now = new Date().toISOString();

  // A run re-scans the same search pages, so the same job gets skipped over and
  // over. Collapse repeats into one entry with a counter instead of appending a
  // near-identical row every single run (which is what grew this file to megabytes).
  if (status === 'skipped') {
    const existing = log.find(
      (e) => e && e.jobId === id && e.platform === platform && e.status === 'skipped'
    );
    if (existing) {
      existing.seenCount = (existing.seenCount || 1) + 1;
      existing.lastSeenAt = now;
      if (reason) existing.reason = reason;
      saveLog(log);
      console.log(`⏭️  [SKIPPED] ${title} @ ${company}${reason ? ` — ${reason}` : ''}`);
      return;
    }
  }

  const entry = {
    jobId: id,
    title,
    company,
    platform,
    status,
    link,
    appliedAt: now,
  };

  if (status === 'failed') {
    entry.code = code || 'error';
    entry.reason = reason || describeCode(entry.code);
    entry.attempts = attempts || 1;
    entry.answersHash = answersFingerprint();
    entry.retryable = isTransient(entry.code);
    if (unanswered?.length) entry.unanswered = unanswered;
    if (blockers?.length) entry.blockers = blockers;
    entry.failureNumber = failuresFor(id, log).length + 1;
  } else if (reason) {
    entry.reason = reason;
  }

  if (status === 'skipped') entry.seenCount = 1;

  log.push(entry);
  saveLog(log);

  if (status === 'applied') {
    console.log(`✅ [APPLIED] ${title} @ ${company}`);
  } else if (status === 'skipped') {
    console.log(`⏭️  [SKIPPED] ${title} @ ${company}${reason ? ` — ${reason}` : ''}`);
  } else {
    const attemptNote = entry.attempts > 1 ? ` after ${entry.attempts} attempts` : '';
    const retryNote = entry.retryable
      ? `will retry next run (${entry.failureNumber}/${MAX_FAILED_ATTEMPTS})`
      : 'parked until your answers change';
    console.log(`❌ [FAILED] ${title} @ ${company}${attemptNote}`);
    console.log(`     ↳ ${describeCode(entry.code)}: ${entry.reason}`);
    console.log(`     ↳ ${retryNote}`);
  }
}

// The set of jobs that are still open problems: failed, never subsequently
// applied to. This is what the review report is built from.
function openFailures(platform) {
  const log = loadLog();
  const appliedIds = new Set(log.filter((e) => e?.status === 'applied').map((e) => e.jobId));
  const latest = new Map();
  for (const entry of log) {
    if (!entry || entry.status !== 'failed') continue;
    if (appliedIds.has(entry.jobId)) continue;
    if (platform && entry.platform?.toLowerCase() !== platform.toLowerCase()) continue;
    latest.set(entry.jobId, {
      ...entry,
      totalFailures: (latest.get(entry.jobId)?.totalFailures || 0) + 1,
    });
  }
  return [...latest.values()];
}

function printSummary() {
  const log = loadLog();
  const applied = log.filter((j) => j.status === 'applied');
  const skipped = log.filter((j) => j.status === 'skipped').length;
  const failures = openFailures();

  const byPlatform = {};
  for (const entry of applied) {
    const pName = entry.platform || 'Unknown';
    byPlatform[pName] = (byPlatform[pName] || 0) + 1;
  }

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║       APPLICATION SUMMARY (ALL TIME) ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`✅ Total Applied : ${applied.length}`);
  for (const [platform, count] of Object.entries(byPlatform)) {
    console.log(`   └─ ${platform.padEnd(10)}: ${count}`);
  }
  console.log(`⏭️  Skipped      : ${skipped}`);
  console.log(`❌ Open failures : ${failures.length}`);

  if (failures.length) {
    const byCode = {};
    for (const f of failures) byCode[f.code || 'error'] = (byCode[f.code || 'error'] || 0) + 1;
    const ordered = Object.entries(byCode).sort((a, b) => b[1] - a[1]);
    for (const [code, count] of ordered) {
      const tag = isTransient(code) ? 'retryable' : 'needs an answer from you';
      console.log(`   └─ ${describeCode(code).padEnd(34)}: ${String(count).padStart(3)}  (${tag})`);
    }

    const questions = new Map();
    for (const f of failures) {
      for (const u of f.unanswered || []) {
        const key = normalizeQuestion(u.question);
        if (!key) continue;
        const seen = questions.get(key) || { question: (u.question || '').trim(), count: 0 };
        seen.count++;
        questions.set(key, seen);
      }
    }
    const topQuestions = [...questions.values()].sort((a, b) => b.count - a.count).slice(0, 5);
    if (topQuestions.length) {
      console.log('\n🔎 Questions blocking the most applications:');
      for (const { question, count } of topQuestions) {
        console.log(`   ${String(count).padStart(3)}× ${question.slice(0, 90)}`);
      }
      console.log('   → see needs-review.md for where to answer them');
    }
  }

  console.log(`\n📁 Full log     : applications.json`);
  console.log('════════════════════════════════════════\n');
}

module.exports = {
  alreadyApplied,
  appliedTodayCount,
  totalAppliedCount,
  recordApplication,
  printSummary,
  shouldSkipJob,
  failuresFor,
  openFailures,
  answersFingerprint,
  isTransient,
  describeCode,
  loadLog,
  normalizeQuestion,
  FAILURE_CODES,
  MAX_FAILED_ATTEMPTS,
};
