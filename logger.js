const fs = require('fs');
const LOG_FILE = './applications.json';

function loadLog() {
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveLog(log) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function alreadyApplied(jobId) {
  const log = loadLog();
  return log.some((e) => e.jobId === String(jobId) && e.status === 'applied');
}

function appliedTodayCount(platform) {
  const log = loadLog();
  const today = new Date().toISOString().slice(0, 10);
  return log.filter(
    (e) => e.platform.toLowerCase() === platform.toLowerCase() && e.status === 'applied' && e.appliedAt.startsWith(today)
  ).length;
}

function totalAppliedCount(platform) {
  const log = loadLog();
  return log.filter((e) => e.platform.toLowerCase() === platform.toLowerCase() && e.status === 'applied').length;
}

function recordApplication({ jobId, title, company, platform, status, link }) {
  const log = loadLog();
  log.push({
    jobId: String(jobId),
    title,
    company,
    platform,
    status,
    link,
    appliedAt: new Date().toISOString(),
  });
  saveLog(log);

  const icon = status === 'applied' ? '✅' : status === 'skipped' ? '⏭️ ' : '❌';
  console.log(`${icon} [${status.toUpperCase()}] ${title} @ ${company}`);
}

function printSummary() {
  const log = loadLog();
  const applied = log.filter((j) => j.status === 'applied');
  const skipped = log.filter((j) => j.status === 'skipped').length;
  const failed = log.filter((j) => j.status === 'failed').length;

  const byPlatform = {};
  for (const entry of applied) {
    byPlatform[entry.platform] = (byPlatform[entry.platform] || 0) + 1;
  }

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║       APPLICATION SUMMARY (ALL TIME) ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`✅ Total Applied : ${applied.length}`);
  for (const [platform, count] of Object.entries(byPlatform)) {
    console.log(`   └─ ${platform.padEnd(10)}: ${count}`);
  }
  console.log(`⏭️  Skipped      : ${skipped}`);
  console.log(`❌ Failed       : ${failed}`);
  console.log(`📁 Full log     : applications.json`);
  console.log('════════════════════════════════════════\n');
}

module.exports = {
  alreadyApplied,
  appliedTodayCount,
  totalAppliedCount,
  recordApplication,
  printSummary,
};
