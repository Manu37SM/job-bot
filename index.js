const { runLinkedIn } = require('./linkedin');
const { runNaukri } = require('./naukri');
const { runIndeed } = require('./indeed');
const { printSummary, totalAppliedCount } = require('./logger');
const { printLocationSummary } = require('./location-helper');
const { printSalarySummary } = require('./salary-helper');
const config = require('./config');

const PLATFORMS = {
  linkedin: true,
  naukri: false,
  indeed: false,
};

async function main() {
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

  if (PLATFORMS.naukri) {
    const done = totalAppliedCount('naukri');
    const max = config.maxApplications.naukri?.lifetime || 0;
    if (done >= max) {
      console.log(`⛔ Naukri lifetime limit reached (${done}/${max}). Skipping.`);
    } else {
      await runNaukri().catch((err) => console.error('Naukri failed:', err.message));
    }
  }

  if (PLATFORMS.indeed) {
    const done = totalAppliedCount('indeed');
    const max = config.maxApplications.indeed?.lifetime || 0;
    if (done >= max) {
      console.log(`⛔ Indeed lifetime limit reached (${done}/${max}). Skipping.`);
    } else {
      await runIndeed().catch((err) => console.error('Indeed failed:', err.message));
    }
  }

  printSummary();
}

main();
