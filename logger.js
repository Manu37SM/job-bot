const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { companyKey } = require('./text-utils');

const config = () => require('./config');

const LOG_FILE = process.env.JOB_BOT_LOG
  ? path.resolve(process.env.JOB_BOT_LOG)
  : path.join(__dirname, 'applications.json');

const MAX_FAILED_ATTEMPTS = 3;

const RETIRE_COOLDOWN_DAYS = 14;

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
  if (!code) return 'Logged before diagnostics existed';
  return FAILURE_CODES[code]?.label || code;
}

let fingerprintCache = null;
function answersFingerprint() {
  if (fingerprintCache) return fingerprintCache;
  const sources = [
    'config.js',
    'resume-profile.js',
    'resume-answers.js',
    'answer-utils.js',
    'question-policy.js',
  ];
  const hash = crypto.createHash('sha1');
  for (const file of sources) {
    const full = path.join(__dirname, file);
    try {
      hash.update(fs.readFileSync(full));
    } catch {
      hash.update(`missing:${file}`);
    }
  }
  try {
    const config = require('./config');
    const cvText = String(config.resumePath || '').replace(/\.pdf$/i, '.txt');
    if (cvText) hash.update(fs.readFileSync(path.resolve(__dirname, cvText)));
  } catch {
    hash.update('no-cv-text');
  }
  fingerprintCache = hash.digest('hex').slice(0, 12);
  return fingerprintCache;
}

function normalizeQuestion(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[*:?.\s]+$/g, '')
    .trim();
}

let lastGoodLog = null;

function loadLog() {
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
    lastGoodLog = Array.isArray(parsed) ? parsed : [];
    return lastGoodLog;
  } catch {
    console.warn('⚠️  applications.json could not be parsed; using the last known good copy.');
    return lastGoodLog || [];
  }
}

function saveLog(log) {
  const tmp = `${LOG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(log, null, 2));
  fs.renameSync(tmp, LOG_FILE);
  lastGoodLog = log;
}

function syntheticId(title, company) {
  const slug = (text) =>
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'unknown';
  return `x:${slug(title)}:${slug(company)}`;
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

function daysSinceLastAttempt(entry) {
  const when = Date.parse(entry?.appliedAt || '');
  if (!Number.isFinite(when)) return null;
  return (Date.now() - when) / 86400000;
}

function failuresFor(jobId, log = loadLog()) {
  const id = normalizeId(jobId);
  if (!id) return [];
  return log.filter((e) => e && e.jobId === id && e.status === 'failed');
}

function shouldSkipJob(jobId) {
  const id = normalizeId(jobId);
  if (!id) return null;

  const failures = failuresFor(id);
  if (failures.length === 0) return null;

  const last = failures[failures.length - 1];

  if (failures.length >= MAX_FAILED_ATTEMPTS) {
    const daysSince = daysSinceLastAttempt(last);
    if (daysSince == null || daysSince < RETIRE_COOLDOWN_DAYS) {
      return `failed ${failures.length}× already — set aside for ${RETIRE_COOLDOWN_DAYS} days`;
    }
    return null;
  }
  if (last.code && !isTransient(last.code) && last.answersHash === answersFingerprint()) {
    const detail = last.reason ? ` (${last.reason.slice(0, 80)})` : '';
    return `${describeCode(last.code).toLowerCase()}; answers unchanged since${detail}`;
  }

  return null;
}

function companyApplicationCount(company, platform) {
  const key = companyKey(company);
  if (!key) return 0;
  return loadLog().filter(
    (e) =>
      e &&
      e.status === 'applied' &&
      (!platform || e.platform?.toLowerCase() === platform.toLowerCase()) &&
      companyKey(e.company) === key
  ).length;
}

function companyLifetimeCapReached(company, platform) {
  const cap = Number(config().maxApplicationsPerCompanyTotal);
  if (!Number.isFinite(cap) || cap <= 0) return null;
  const count = companyApplicationCount(company, platform);
  if (count < cap) return null;
  return `already applied to this company ${count}× in total`;
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
  answered,
  blockers,
  attempts,
}) {
  const log = loadLog();
  const realId = normalizeId(jobId);
  const id = realId || syntheticId(title, company);
  const now = new Date().toISOString();

  if (status === 'skipped') {
    const existing = log.find(
      (e) => e && e.jobId === id && e.platform === platform && e.status === 'skipped'
    );
    if (existing) {
      existing.seenCount = (existing.seenCount || 1) + 1;
      existing.lastSeenAt = now;
      if (reason) existing.reason = reason;
      saveLog(log);
      runStats.skipped++;
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

  if (answered?.length) entry.answers = answered.slice(0, 40);

  if (!realId) entry.idSynthesised = true;

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
  noteRunStat(entry);

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

function compactLog() {
  const log = loadLog();
  const out = [];
  const skippedIndex = new Map();
  let collapsed = 0;

  for (const entry of log) {
    if (!entry) continue;
    if (entry.status !== 'skipped') {
      out.push(entry);
      continue;
    }
    const key = `${entry.jobId}|${entry.platform}`;
    const existing = skippedIndex.get(key);
    if (!existing) {
      skippedIndex.set(key, entry);
      out.push(entry);
      continue;
    }
    existing.seenCount = (existing.seenCount || 1) + (entry.seenCount || 1);
    if (String(entry.appliedAt) > String(existing.lastSeenAt || existing.appliedAt)) {
      existing.lastSeenAt = entry.appliedAt;
      if (entry.reason) existing.reason = entry.reason;
    }
    collapsed++;
  }

  return { log: out, before: log.length, after: out.length, collapsed };
}

const runStats = { applied: 0, failed: 0, skipped: 0, byCode: {}, blockingQuestions: new Map() };

function noteRunStat(entry) {
  if (entry.status === 'applied') runStats.applied++;
  else if (entry.status === 'skipped') runStats.skipped++;
  else if (entry.status === 'failed') {
    runStats.failed++;
    const code = entry.code || '';
    runStats.byCode[code] = (runStats.byCode[code] || 0) + 1;
    for (const item of entry.unanswered || []) {
      const key = normalizeQuestion(item.question);
      if (!key) continue;
      const seen = runStats.blockingQuestions.get(key) || { question: item.question, count: 0 };
      seen.count++;
      runStats.blockingQuestions.set(key, seen);
    }
  }
}

function printRunSummary() {
  const total = runStats.applied + runStats.failed + runStats.skipped;
  if (total === 0) return;

  console.log('\n┌─ THIS RUN ' + '─'.repeat(27));
  console.log(`│ ✅ Applied : ${runStats.applied}`);
  console.log(`│ ❌ Failed  : ${runStats.failed}`);
  console.log(`│ ⏭️  Skipped : ${runStats.skipped}`);

  const codes = Object.entries(runStats.byCode).sort((a, b) => b[1] - a[1]);
  for (const [code, count] of codes) {
    console.log(`│    └─ ${describeCode(code).padEnd(32)} ${String(count).padStart(3)}`);
  }

  const blocking = [...runStats.blockingQuestions.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  if (blocking.length) {
    console.log('│');
    console.log('│ Answer these and the next run gets further:');
    for (const { question, count } of blocking) {
      console.log(`│   ${String(count).padStart(3)}× ${question.slice(0, 60)}`);
    }
  }
  console.log('└' + '─'.repeat(38));
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
    for (const f of failures) {
      const key = f.code || '';
      byCode[key] = (byCode[key] || 0) + 1;
    }
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
  companyApplicationCount,
  companyLifetimeCapReached,
  recordApplication,
  printSummary,
  printRunSummary,
  runStats,
  shouldSkipJob,
  failuresFor,
  openFailures,
  answersFingerprint,
  isTransient,
  describeCode,
  daysSinceLastAttempt,
  RETIRE_COOLDOWN_DAYS,
  loadLog,
  saveLog,
  syntheticId,
  compactLog,
  normalizeQuestion,
  LOG_FILE,
  FAILURE_CODES,
  MAX_FAILED_ATTEMPTS,
};
