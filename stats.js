#!/usr/bin/env node
// What your application history actually says.
//
// Every finding this tool reports was found by hand first, in a log that looked
// fine from the outside: 27 applications to one job aggregator, four companies
// taking 18% of everything sent, search keywords that matched a quarter of the
// titles they landed on, and a busiest day of 33 applications — which is what got
// the account rate-limited, not the speed anyone assumed.
//
//   npm run stats
const { loadLog, MAX_FAILED_ATTEMPTS } = require('./logger');
const { companyKey, cleanText, cleanCompany } = require('./text-utils');
const { assessTitle } = require('./title-fit');
const { buildCombinations } = require('./search-plan');
const config = require('./config');

const bar = (n, max, width = 24) => '█'.repeat(Math.max(1, Math.round((n / max) * width)));
const pct = (n, total) => (total ? Math.round((100 * n) / total) : 0);

function section(title) {
  console.log(`\n${title}`);
  console.log('─'.repeat(Math.max(title.length, 40)));
}

function main() {
  const log = loadLog();
  const applied = log.filter((e) => e.status === 'applied');
  const failed = log.filter((e) => e.status === 'failed');
  const skipped = log.filter((e) => e.status === 'skipped');

  if (!applied.length) {
    console.log('No applications logged yet — nothing to analyse.');
    return;
  }

  section('Totals');
  console.log(`  applied  ${applied.length}`);
  console.log(`  failed   ${failed.length}`);
  console.log(`  skipped  ${skipped.length}`);

  // --- volume per day: the thing that actually triggers a rate limit -------
  const perDay = {};
  for (const e of applied) {
    const day = String(e.appliedAt).slice(0, 10);
    if (day) perDay[day] = (perDay[day] || 0) + 1;
  }
  const days = Object.entries(perDay).sort((a, b) => b[1] - a[1]);
  const cap = config.maxApplications?.linkedin?.perDay ?? 15;

  section(`Busiest days (your cap is now ${cap}/day)`);
  const worst = days[0]?.[1] || 1;
  for (const [day, count] of days.slice(0, 8)) {
    const over = count > cap ? `  ← ${count - cap} over today's cap` : '';
    console.log(`  ${day}  ${String(count).padStart(3)} ${bar(count, worst)}${over}`);
  }
  const overCap = days.filter(([, n]) => n > cap).length;
  if (overCap) {
    console.log(`\n  ${overCap} day(s) would exceed the current cap. Volume, not speed, is what`);
    console.log('  LinkedIn rate-limits on.');
  }

  // --- pacing --------------------------------------------------------------
  const ordered = [...applied].sort((a, b) => String(a.appliedAt).localeCompare(String(b.appliedAt)));
  const gaps = [];
  for (let i = 1; i < ordered.length; i++) {
    const seconds = (Date.parse(ordered[i].appliedAt) - Date.parse(ordered[i - 1].appliedAt)) / 1000;
    if (seconds > 0 && seconds < 3600) gaps.push(seconds);
  }
  if (gaps.length) {
    gaps.sort((a, b) => a - b);
    const at = (p) => Math.round(gaps[Math.floor(gaps.length * p)]);
    section('Gaps between applications (within a session)');
    console.log(`  fastest ${Math.round(gaps[0])}s   p25 ${at(0.25)}s   median ${at(0.5)}s   p90 ${at(0.9)}s`);
    console.log(`  under 10s apart: ${gaps.filter((g) => g < 10).length}`);
  }

  // --- company concentration ----------------------------------------------
  const byCompany = new Map();
  for (const e of applied) {
    const key = companyKey(e.company) || '(unknown)';
    if (!byCompany.has(key)) byCompany.set(key, { name: cleanCompany(e.company), count: 0 });
    byCompany.get(key).count++;
  }
  const companies = [...byCompany.values()].sort((a, b) => b.count - a.count);
  const lifetimeCap = Number(config.maxApplicationsPerCompanyTotal) || 0;

  section(`Concentration — ${companies.length} companies`);
  const heaviest = companies[0]?.count || 1;
  for (const { name, count } of companies.slice(0, 8)) {
    const flag = lifetimeCap && count >= lifetimeCap ? '  ← at the lifetime cap' : '';
    console.log(`  ${String(count).padStart(3)} ${bar(count, heaviest, 18)} ${name.slice(0, 34)}${flag}`);
  }
  const top4 = companies.slice(0, 4).reduce((sum, c) => sum + c.count, 0);
  console.log(`\n  top 4 companies = ${top4} applications (${pct(top4, applied.length)}% of everything sent)`);

  // --- repeated failures ---------------------------------------------------
  // Before the backoff existed, a job that failed was retried on every subsequent
  // run forever. One posting in this log was attempted 24 times.
  if (failed.length) {
    const byJob = new Map();
    for (const e of failed) {
      const key = e.jobId || `${e.title}|${e.company}`;
      byJob.set(key, (byJob.get(key) || 0) + 1);
    }
    const attempts = [...byJob.entries()].sort((a, b) => b[1] - a[1]);
    const cap = MAX_FAILED_ATTEMPTS;
    const wasted = attempts.reduce((sum, [, n]) => sum + Math.max(0, n - cap), 0);

    section('Repeated failures');
    console.log(`  ${byJob.size} distinct jobs produced ${failed.length} failure records`);
    if (wasted > 0) {
      console.log(`  ${wasted} of those (${pct(wasted, failed.length)}%) were attempts beyond the ${cap}-try cap —`);
      console.log('  pure repetition, which the backoff now prevents.');
    }
    const repeated = attempts.filter(([, n]) => n > cap).slice(0, 5);
    if (repeated.length) {
      console.log('\n  Most-retried jobs:');
      for (const [key, n] of repeated) {
        const row = failed.find((e) => (e.jobId || `${e.title}|${e.company}`) === key);
        console.log(`    ${String(n).padStart(3)}x  ${cleanText(row?.title).slice(0, 44)}`);
      }
    }
  }

  // --- trend ---------------------------------------------------------------
  // A step change in the success rate is the earliest sign that something broke —
  // LinkedIn's markup moved, a config edit backfired, or the account is being
  // throttled. In the log this was written against, the rate fell from ~81% to
  // ~54% between 21 and 25 August, and the cause is unknowable because every
  // failure predates the diagnostics. It will not be unknowable next time.
  const runDays = new Map();
  for (const e of [...applied, ...failed]) {
    const day = String(e.appliedAt).slice(0, 10);
    if (!day) continue;
    if (!runDays.has(day)) runDays.set(day, { applied: 0, failing: new Set(), companies: new Set() });
    const entry = runDays.get(day);
    if (e.status === 'applied') entry.applied++;
    else {
      entry.failing.add(e.jobId);
      const key = companyKey(e.company);
      if (key) entry.companies.add(key);
    }
  }

  const trend = [...runDays.entries()]
    .map(([day, v]) => ({ day, applied: v.applied, failing: v.failing.size, companies: v.companies.size }))
    .filter((r) => r.applied + r.failing >= 5)
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((r) => ({ ...r, rate: Math.round((100 * r.applied) / (r.applied + r.failing)) }));

  if (trend.length >= 2) {
    section('Success rate per run');
    // The number of distinct COMPANIES failing separates the two kinds of trouble.
    // A few jobs stuck in a retry loop concentrate on a handful of employers; a
    // markup change or a degraded account fails broadly across many. In the log
    // this was written against, that number went from 14 to 42 across the same
    // step change — with only one company in common.
    console.log('  date          rate                       applied/failing   employers');
    for (const r of trend.slice(-10)) {
      console.log(
        `  ${r.day}  ${String(r.rate).padStart(3)}% ${bar(r.rate, 100, 18).padEnd(18)}` +
          `  ${String(`${r.applied}/${r.failing}`).padStart(9)}  ${String(r.companies).padStart(9)}`
      );
    }

    // Compare the most recent runs with the ones before them.
    const recent = trend.slice(-3);
    const earlier = trend.slice(-8, -3);
    if (recent.length && earlier.length) {
      const mean = (rows) => Math.round(rows.reduce((sum, r) => sum + r.rate, 0) / rows.length);
      const drop = mean(earlier) - mean(recent);
      if (drop >= 15) {
        console.log(`\n  ⚠️  Recent runs average ${mean(recent)}%, against ${mean(earlier)}% before — a ${drop} point drop.`);
        // Which kind of trouble is it?
        const recentSpread = recent.reduce((sum, r) => sum + r.companies, 0) / recent.length;
        const earlierSpread = earlier.reduce((sum, r) => sum + r.companies, 0) / earlier.length;
        if (recentSpread > earlierSpread * 1.5) {
          console.log(`  Failures are spread across ~${Math.round(recentSpread)} employers per run, up from ~${Math.round(earlierSpread)}.`);
          console.log('  Broad failure across many employers points at something systemic —');
          console.log('  changed markup, or the account being degraded — not a few stuck jobs.');
        } else if (recentSpread * 1.5 < earlierSpread) {
          console.log('  Failures are concentrated on few employers — more likely a handful of');
          console.log('  jobs stuck in a retry loop than anything systemic.');
        }

        const coded = failed.filter((e) => e.code).length;
        if (coded === 0) {
          console.log('  No failure in this log records a reason, so the cause cannot be read');
          console.log('  from it. Runs from this version onward do record one — check');
          console.log('  needs-review.md after the next run.');
        } else {
          console.log('  Check the failure codes in needs-review.md for what changed.');
        }
      }
    }
  }

  // --- what the failure codes say ------------------------------------------
  // Different codes mean different problems with different owners. Grouping them
  // turns "308 failures" into "your forms changed" or "you need to answer three
  // questions" — which is the difference between a bug report and a to-do list.
  const coded = failed.filter((e) => e.code);
  if (coded.length) {
    const FAMILIES = [
      {
        name: 'LinkedIn markup changed',
        codes: ['modal_missing', 'no_action'],
        advice: 'The form was not where the bot expected. Selectors need updating — run --dry-run and watch the browser.',
      },
      {
        name: 'LinkedIn rejecting submissions',
        codes: ['unconfirmed_submit'],
        advice: 'Submits are going through but not confirming. Often a sign the account is being throttled — slow down before it becomes a pause.',
      },
      {
        name: 'Your answers are incomplete',
        codes: ['unanswerable', 'invalid_field'],
        advice: 'The bot had no answer, or one the form refused. needs-review.md names each question and the config key that fixes it.',
      },
      {
        name: 'Form or timing trouble',
        codes: ['stuck_form', 'timeout', 'error'],
        advice: 'A step would not advance. Usually transient; persistent means the form shape changed.',
      },
    ];

    section('What the failures say');
    const counts = {};
    for (const e of coded) counts[e.code] = (counts[e.code] || 0) + 1;

    const scored = FAMILIES.map((family) => ({
      ...family,
      count: family.codes.reduce((sum, code) => sum + (counts[code] || 0), 0),
    }))
      .filter((family) => family.count > 0)
      .sort((a, b) => b.count - a.count);

    for (const family of scored) {
      console.log(`  ${String(family.count).padStart(4)}  ${family.name}  (${pct(family.count, coded.length)}%)`);
    }
    if (scored.length) {
      console.log(`\n  Mostly: ${scored[0].name}.`);
      console.log(`  ${scored[0].advice}`);
    }
    if (coded.length < failed.length) {
      console.log(`\n  (${failed.length - coded.length} older failures carry no code and are not counted here.)`);
    }
  }

  // --- seniority bands -----------------------------------------------------
  // Which levels actually convert, so the decision to filter a band is yours and
  // based on your own history rather than a guess about what suits 4 years.
  const BANDS = [
    ['architect', /\barchitect\b/i],
    ['principal / staff', /\b(principal|staff)\b/i],
    ['lead', /\b(lead|leader)\b/i],
    ['senior', /\b(senior|sr\.?)\b/i],
    ['manager / head', /\b(manager|head of|director)\b/i],
    ['junior / trainee', /\b(junior|jr\.?|trainee|intern|fresher)\b/i],
  ];
  section('Seniority bands');
  console.log('  band                 applied   failing jobs');
  for (const [name, pattern] of BANDS) {
    const a = applied.filter((e) => pattern.test(String(e.title))).length;
    const f = new Set(failed.filter((e) => pattern.test(String(e.title))).map((e) => e.jobId)).size;
    const note = a === 0 && f > 0 ? '   ← never converts' : '';
    console.log(`  ${name.padEnd(20)} ${String(a).padStart(5)}   ${String(f).padStart(10)}${note}`);
  }

  // --- role fit ------------------------------------------------------------
  const offTarget = applied.filter((e) => assessTitle(e.title).skip);
  section('Role fit, applied retrospectively');
  console.log(`  ${offTarget.length} of ${applied.length} (${pct(offTarget.length, applied.length)}%) would now be screened out`);
  const reasons = {};
  for (const e of offTarget) {
    const { reason } = assessTitle(e.title);
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  for (const [reason, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`    ${String(count).padStart(3)}  ${reason}`);
  }

  // --- keywords ------------------------------------------------------------
  const STOP = new Set(
    'senior sr jr junior lead the a an and or for with of in at to remote hybrid onsite india years exp yrs full time contract new'.split(' ')
  );
  const words = {};
  for (const e of applied.filter((x) => !assessTitle(x.title).skip)) {
    for (const word of cleanText(e.title).toLowerCase().replace(/[^a-z0-9.+#/ -]/g, ' ').split(/[\s/-]+/)) {
      if (word.length >= 3 && !STOP.has(word)) words[word] = (words[word] || 0) + 1;
    }
  }
  const top = Object.entries(words).sort((a, b) => b[1] - a[1]).slice(0, 12);
  section('Words in the titles you land on');
  const searched = (config.positions || []).join(' ').toLowerCase();
  for (const [word, count] of top) {
    const inSearch = searched.includes(word) ? '' : '   ← not in config.positions';
    console.log(`  ${String(count).padStart(3)}  ${word}${inSearch}`);
  }

  section('Search coverage');
  const combos = buildCombinations().length;
  const perRun = config.maxApplications?.linkedin?.perRun ?? 0;
  console.log(`  ${combos} search combinations, ${perRun} applications per run`);
  console.log('  Searches rotate between runs, so the whole space is covered over several runs.');
  console.log('');
}

if (require.main === module) main();
module.exports = { main };
