const { runLinkedIn, dryRunTally } = require('./linkedin');
const { options, printHelp } = require('./cli');
const { runNaukri } = require('./naukri');
const { runIndeed } = require('./indeed');
const { printSummary, printRunSummary, totalAppliedCount } = require('./logger');
const { runPreflight } = require('./preflight');
const { writeReviewReport, writeDryRunReport } = require('./failure-report');
const { installSignalHandlers, isStopRequested } = require('./shutdown');
const { printLocationSummary } = require('./location-helper');
const { printSalarySummary } = require('./salary-helper');
const config = require('./config');

const PLATFORMS = {
  linkedin: true,
  naukri: false,
  indeed: false,
};

async function main() {
  if (options.help) return printHelp();

  installSignalHandlers();

  if (!runPreflight()) return;

  console.log('╔══════════════════════════════════════╗');
  console.log('║        JOB APPLICATION BOT           ║');
  console.log('╚══════════════════════════════════════╝');

  console.log(`\n👤 Applicant     : ${config.name}`);
  printSalarySummary();
  console.log(`📅 Notice Period : ${config.noticePeriod}`);
  console.log(`📆 LWD           : ${config.lastWorkingDay}`);
  console.log(`🎯 Positions     : ${config.positions.join(', ')}`);
  console.log(`💼 Job Type      : ${config.jobTypes.join(', ')}`);
  console.log(`🌅 Day Shift Only: ${config.dayShiftOnly ? 'Yes' : 'No'}`);
  printLocationSummary();

  console.log('\n📊 Progress so far (all previous runs combined):');
  for (const platform of ['linkedin', 'naukri', 'indeed']) {
    const done = totalAppliedCount(platform);
    const platformLimit = config.maxApplications?.[platform];
    if (!platformLimit) {
      console.log(`   ${platform.padEnd(10)}: [Not Configured in config.js]`);
      continue;
    }
    const { lifetime, perRun } = platformLimit;
    const remaining = Math.max(0, lifetime - done);
    console.log(
      `   ${platform.padEnd(10)}: ${done}/${lifetime} lifetime | ${remaining} remaining | ${perRun}/run`
    );
  }

  console.log('\n⚠️  Bot opens real browser windows — do not click anything!');
  console.log('    Press Ctrl+C anytime to stop.\n');

  if (PLATFORMS.linkedin) {
    const done = totalAppliedCount('linkedin');
    const max = config.maxApplications.linkedin?.lifetime || 0;
    if (done >= max) {
      console.log(`⛔ LinkedIn lifetime limit reached (${done}/${max}). Skipping.`);
    } else {
      await runLinkedIn().catch((err) => console.error('LinkedIn failed:', err.message));
    }
  }

  if (PLATFORMS.naukri && !isStopRequested()) {
    const done = totalAppliedCount('naukri');
    const max = config.maxApplications.naukri?.lifetime || 0;
    if (done >= max) {
      console.log(`⛔ Naukri lifetime limit reached (${done}/${max}). Skipping.`);
    } else {
      await runNaukri().catch((err) => console.error('Naukri failed:', err.message));
    }
  }

  if (PLATFORMS.indeed && !isStopRequested()) {
    const done = totalAppliedCount('indeed');
    const max = config.maxApplications.indeed?.lifetime || 0;
    if (done >= max) {
      console.log(`⛔ Indeed lifetime limit reached (${done}/${max}). Skipping.`);
    } else {
      await runIndeed().catch((err) => console.error('Indeed failed:', err.message));
    }
  }

  if (isStopRequested())
    console.log('\n🛑 Run stopped early — everything below still reflects real progress.');

  if (options.dryRun) {
    console.log('\n┌─ DRY RUN ' + '─'.repeat(28));
    console.log(`│ 🧪 Would have applied to : ${dryRunTally.eligible}`);
    console.log(`│ ⏭️  Screened out          : ${dryRunTally.skipped}`);
    console.log('│ Nothing was applied to and nothing was logged.');
    console.log('└' + '─'.repeat(38));

    const file = writeDryRunReport(dryRunTally);
    if (file) console.log(`📝 The jobs it would have applied to → dry-run.md\n`);
    return;
  }

  printRunSummary();
  printSummary();

  writeReviewReport();
}

main();
