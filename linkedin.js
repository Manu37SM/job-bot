const { chromium } = require('playwright');
const config = require('./config');
const { answerQuestion, generateCoverLetter } = require('./resume-answers');
const {
  alreadyApplied,
  recordApplication,
  totalAppliedCount,
  appliedTodayCount,
  shouldSkipJob,
  failuresFor,
  companyLifetimeCapReached,
  isTransient,
  describeCode,
} = require('./logger');
const { deterministicAnswer, isNumericQuestion } = require('./answer-utils');
const { buildNumericCandidates } = require('./field-value');
const { isStopRequested, requestStop } = require('./shutdown');
const policy = require('./question-policy');
const { assessFit } = require('./job-fit');
const { assessTitle } = require('./title-fit');
const { planSearches, advanceSearchOffset, buildCombinations } = require('./search-plan');
const { buildSearchUrl, describeFilters } = require('./search-filters');
const { options } = require('./cli');
const { recordThrottle, activeHold } = require('./cooldown');
const { cleanText, cleanCompany, companyKey } = require('./text-utils');

const dryRunTally = { eligible: 0, skipped: 0, jobs: [], screened: [] };

function noteDryRunSkip(job, reason) {
  dryRunTally.skipped++;
  dryRunTally.screened.push({ ...job, reason });
}

const seenThisRun = new Set();
const companyApplicationsThisRun = new Map();

const failureTally = { total: 0, consecutive: 0, retries: 0 };

function retryBudgetSpent() {
  const cap = Number(config.maxRetriedFailuresPerRun);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return failureTally.retries >= cap;
}

function failureBudget() {
  return {
    total: Number.isFinite(Number(config.maxFailuresPerRun))
      ? Number(config.maxFailuresPerRun)
      : 10,
    streak: Number.isFinite(Number(config.maxConsecutiveFailures))
      ? Number(config.maxConsecutiveFailures)
      : 5,
  };
}

function failureBudgetExhausted() {
  const { total, streak } = failureBudget();
  if (total > 0 && failureTally.total >= total) {
    return `${failureTally.total} failures this run — stopping before it grinds on`;
  }
  if (streak > 0 && failureTally.consecutive >= streak) {
    return `${failureTally.consecutive} failures in a row — something looks systematically wrong`;
  }
  return null;
}

function resetRunState() {
  seenThisRun.clear();
  companyApplicationsThisRun.clear();
  dryRunTally.eligible = 0;
  dryRunTally.skipped = 0;
  dryRunTally.jobs = [];
  dryRunTally.screened = [];
  failureTally.total = 0;
  failureTally.consecutive = 0;
  failureTally.retries = 0;
  cardsSeenThisRun = 0;
  workingCardSelector = null;
  appsSinceBreak = 0;
}

function companyCapReached(company) {
  const cap = Number(config.maxApplicationsPerCompanyPerRun);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  const key = companyKey(company);
  if (!key) return false;
  return (companyApplicationsThisRun.get(key) || 0) >= cap;
}

function noteCompanyApplication(company) {
  const key = companyKey(company);
  if (!key) return;
  companyApplicationsThisRun.set(key, (companyApplicationsThisRun.get(key) || 0) + 1);
}

const DELAYS = { slow: 3000, medium: 1500, fast: 500, instant: 0 };

const delay = (ms) => new Promise((r) => setTimeout(r, config.speed === 'instant' ? 0 : ms));
const wait = () => delay(DELAYS[config.speed] ?? 2000);

const PER_JOB_TIMEOUT_MS = 120000;

async function withJobTimeout(promise, jobLabel) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Job timed out after ${PER_JOB_TIMEOUT_MS}ms: ${jobLabel}`)),
      PER_JOB_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitEval(page, selector, fn, fallback, timeoutMs = 8000) {
  try {
    await page.waitForSelector(selector, { state: 'attached', timeout: timeoutMs });
  } catch {
    return fallback;
  }
  return page.$eval(selector, fn).catch(() => fallback);
}

async function firstText(page, selectors, fallback, clean = cleanText) {
  for (let i = 0; i < selectors.length; i++) {
    const text = await waitEval(
      page,
      selectors[i],
      (el) => el.innerText,
      '',
      i === 0 ? 8000 : 1200
    );
    const cleaned = clean(text);
    if (cleaned) return cleaned;
  }
  return fallback;
}

const TITLE_SELECTORS = [
  '.job-details-jobs-unified-top-card__job-title',
  '.jobs-unified-top-card__job-title',
  '.job-details-jobs-unified-top-card__job-title h1',
  'h1.t-24',
];

const COMPANY_SELECTORS = [
  '.job-details-jobs-unified-top-card__company-name',
  '.jobs-unified-top-card__company-name',
  '.job-details-jobs-unified-top-card__primary-description-container a',
];

async function readCardIdentity(card) {
  return card
    .evaluate((el) => {
      const id =
        el.getAttribute('data-job-id') ||
        el.getAttribute('data-occludable-job-id') ||
        el.querySelector('[data-job-id]')?.getAttribute('data-job-id') ||
        (el.querySelector('a[href*="/jobs/view/"]')?.getAttribute('href') || '').match(
          /\/jobs\/view\/(\d+)/
        )?.[1] ||
        '';
      const titleNode = el.querySelector(
        '.job-card-list__title, .job-card-container__link, a[href*="/jobs/view/"]'
      );
      const companyNode = el.querySelector(
        '.job-card-container__primary-description, .artdeco-entity-lockup__subtitle, .job-card-container__company-name'
      );
      return {
        jobId: String(id || '').trim(),
        title: (titleNode?.innerText || '').trim(),
        company: (companyNode?.innerText || '').trim(),
      };
    })
    .catch(() => ({ jobId: '', title: '', company: '' }));
}

function cardDecision({ jobId, title } = {}) {
  if (!jobId) return { action: 'open' };
  if (seenThisRun.has(jobId))
    return { action: 'skip', reason: 'seen earlier this run', log: false };
  if (alreadyApplied(jobId)) return { action: 'skip', reason: 'already applied', log: true };

  const backoff = shouldSkipJob(jobId);
  if (backoff) return { action: 'skip', reason: backoff, log: true };

  const fit = assessTitle(title || '');
  if (fit.skip) return { action: 'skip', reason: fit.reason, log: true };

  return { action: 'open' };
}

function getLinkedInJobId(url) {
  const value = String(url || '');
  if (!value) return '';

  const pathMatch = value.match(/\/jobs\/view\/(\d+)/);
  if (pathMatch?.[1]) return pathMatch[1];

  try {
    const parsed = new URL(value);
    return parsed.searchParams.get('currentJobId') || '';
  } catch {
    return '';
  }
}

function effectiveRunBudget({ perRun, perDay, lifetime, doneToday, alreadyDone, limit }) {
  const requested = limit != null ? Math.max(0, Number(limit) || 0) : perRun;
  const capped = Math.min(perRun, requested);
  return Math.max(0, Math.min(capped, perDay - doneToday, lifetime - alreadyDone));
}

async function runLinkedIn() {
  console.log('\n🔵 STARTING LINKEDIN BOT...\n');
  if (options.dryRun) {
    console.log('🧪 DRY RUN — LinkedIn will be browsed and screened, but nothing will be');
    console.log('   applied to and nothing will be written to applications.json.');
    console.log('   Browsing is paced too: this is still a logged-in session.\n');
  }

  const hold = activeHold('linkedin');
  if (hold && !options.dryRun && !options.ignoreCooldown) {
    const since = hold.at.slice(0, 16).replace('T', ' ');
    const until = hold.until.slice(0, 16).replace('T', ' ');
    console.log(`🛑 LinkedIn rate-limited this account on ${since}.`);
    if (hold.message) console.log(`   "${hold.message}"`);
    console.log(`   Holding off for another ${hold.hoursLeft}h (until ${until}).`);
    console.log(
      '   Running straight back into a safeguard is what turns a pause into a restriction.'
    );
    console.log('   To look without applying:  node index.js --dry-run');
    console.log('   To override deliberately:  node index.js --ignore-cooldown\n');
    return;
  }
  if (hold && options.dryRun) {
    console.log(
      `⚠️  A rate-limit hold is active for another ${hold.hoursLeft}h — but a dry run applies to nothing.\n`
    );
  }

  const perRun = config.maxApplications.linkedin.perRun;
  const lifetime = config.maxApplications.linkedin.lifetime;
  const perDay = config.maxApplications.linkedin.perDay ?? 15;
  const alreadyDone = totalAppliedCount('linkedin');
  const doneToday = appliedTodayCount('linkedin');

  const canApply = effectiveRunBudget({
    perRun,
    perDay,
    lifetime,
    doneToday,
    alreadyDone,
    limit: options.limit,
  });

  const capNote = options.limit != null ? ` (--limit ${options.limit})` : '';
  console.log(
    `📊 LinkedIn: ${alreadyDone}/${lifetime} lifetime | ${doneToday}/${perDay} today | applying up to ${Math.max(0, canApply)} this run${capNote}`
  );
  if (!options.dryRun) {
    if (lifetime - alreadyDone <= 0) {
      console.log('⛔ LinkedIn lifetime limit already reached. Skipping.');
      return;
    }
    if (canApply <= 0) {
      console.log(`⛔ Daily limit reached (${doneToday}/${perDay}). Come back tomorrow.`);
      return;
    }
  }

  const { min, max } = pacingConfig();
  console.log(`🐢 Pacing: ${min}-${max}s between applications, with periodic longer breaks.`);

  const sessionFile = './session-linkedin.json';
  if (!require('fs').existsSync(sessionFile)) {
    console.log('⚠️  No saved session found!');
    console.log('   Run:  node save-session.js linkedin');
    console.log('   Then log in with Google in the browser window.');
    return;
  }

  const browser = await chromium.launch({ headless: false, slowMo: 100 });

  try {
    const context = await browser.newContext({ storageState: sessionFile });
    const page = await context.newPage();

    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(60000);

    await loginToLinkedIn(page);

    const runBudget = options.dryRun ? (options.limit ?? Math.max(perRun, 5)) : canApply;
    resetRunState();
    let appliedThisRun = 0;

    const plan = planSearches('linkedin');
    let searchesPerformed = 0;

    for (const { position, location, workModes } of plan) {
      if (appliedThisRun >= runBudget || isStopRequested()) break;

      console.log(`\n🔍 Searching: "${position}" in "${location}" [${workModes.join(',')}]`);
      searchesPerformed++;
      const count = await searchAndApply(
        page,
        position,
        location,
        workModes,
        runBudget - appliedThisRun
      );
      appliedThisRun += count;
    }

    advanceSearchOffset('linkedin', searchesPerformed);
    console.log(
      `\n🔁 Covered ${searchesPerformed}/${buildCombinations().length} search combinations; the next run starts after them.`
    );

    if (cardsSeenThisRun === 0) {
      console.warn('\n⚠️  No job cards were found in ANY search this run.');
      console.warn('   That usually means one of:');
      console.warn('     • the session is stale — run: node save-session.js linkedin');
      console.warn('     • LinkedIn renamed its job-card markup again');
      console.warn(
        '     • the filters in config.js exclude everything (positions, locations, jobTypes)'
      );
      console.warn('   Try:  node index.js --dry-run --limit 1   and watch the browser.');
    }

    console.log(
      `\n✅ LinkedIn Done! Applied ${appliedThisRun} this run. Total: ${alreadyDone + appliedThisRun}/${lifetime}`
    );
  } catch (err) {
    if (err instanceof ThrottleError) {
      const recorded = recordThrottle('linkedin', err.message);
      console.error('\n🛑 LinkedIn has rate-limited this account.');
      console.error(`   "${err.message}"`);
      console.error('   Stopping the run now rather than pushing through it —');
      console.error('   continuing is what turns a temporary pause into a restriction.');
      console.error(
        `   Further runs are held until ${recorded.until.slice(0, 16).replace('T', ' ')} — lower perDay and raise the pacing values in config.js before then.`
      );
    } else if (err instanceof SessionExpiredError) {
      console.error(`❌ ${err.message}`);
    } else {
      console.error('❌ LinkedIn bot error:', err.message);
    }
  } finally {
    await browser.close();
  }
}

async function loginToLinkedIn(page) {
  console.log('🔐 Loading LinkedIn session...');

  await page.goto('https://www.linkedin.com/feed', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await new Promise((r) => setTimeout(r, 3000));

  if (page.url().includes('login') || page.url().includes('authwall')) {
    throw new Error('Session expired. Run: node save-session.js linkedin');
  }

  console.log('✅ LinkedIn session loaded!');
}

class SessionExpiredError extends Error {}

class ThrottleError extends Error {}

const THROTTLE_STRONG = [
  /paused easy apply/i,
  /applying at a (?:fast|rapid) pace/i,
  /we'?ve briefly paused/i,
  /automated inauthentic/i,
  /safeguard against automated/i,
  /reached the (?:daily|weekly|monthly) (?:application|apply)\w* limit/i,
  /reached the (?:maximum|limit) (?:number )?of applications/i,
];

const THROTTLE_WEAK = [
  /try again (?:later|tomorrow|in a )/i,
  /unusual activity/i,
  /temporarily (?:restricted|blocked|unavailable)/i,
  /too many requests/i,
  /slow down/i,
];

function firstMatchingLine(text, pattern) {
  return (
    String(text)
      .split('\n')
      .map((l) => l.trim())
      .find((l) => pattern.test(l)) || ''
  );
}

function throttleMessageIn(pageText, alertText = '') {
  const body = String(pageText || '');
  const alerts = String(alertText || '');

  const strong = THROTTLE_STRONG.find((pattern) => pattern.test(body) || pattern.test(alerts));
  if (strong) {
    return (
      firstMatchingLine(alerts, strong) ||
      firstMatchingLine(body, strong) ||
      'LinkedIn has temporarily paused Easy Apply for this account'
    );
  }

  if (!alerts) return '';
  const weak = THROTTLE_WEAK.find((pattern) => pattern.test(alerts));
  if (!weak) return '';
  return firstMatchingLine(alerts, weak) || 'LinkedIn showed a rate-limit notice';
}

async function detectThrottle(page) {
  const texts = await page
    .evaluate(() => {
      const ALERT_SELECTORS = [
        '[role="alert"]',
        '[role="alertdialog"]',
        '[role="dialog"]',
        '.artdeco-modal',
        '.artdeco-inline-feedback',
        '.artdeco-toast-item',
        '.msg-overlay-bubble-header',
      ].join(',');
      const alerts = Array.from(document.querySelectorAll(ALERT_SELECTORS))
        .filter((el) => el.offsetParent !== null)
        .map((el) => el.innerText || '')
        .join('\n');
      return {
        body: (document.body?.innerText || '').slice(0, 20000),
        alerts: alerts.slice(0, 8000),
      };
    })
    .catch(() => ({ body: '', alerts: '' }));
  return throttleMessageIn(texts.body, texts.alerts);
}

async function assertNotThrottled(page) {
  const message = await detectThrottle(page);
  if (message) throw new ThrottleError(message);
}

let appsSinceBreak = 0;

function pacingConfig() {
  const pacing = config.pacing || {};
  const legacy = Number(config.pauseBetweenApps) || 0;
  return {
    min: Number(pacing.minSecondsBetweenApps) || Math.max(legacy, 45),
    max: Number(pacing.maxSecondsBetweenApps) || Math.max(legacy * 3, 150),
    breakEvery: Number(pacing.longBreakEvery) || 6,
    breakMin: Number(pacing.longBreakMinSeconds) || 240,
    breakMax: Number(pacing.longBreakMaxSeconds) || 600,
  };
}

async function browsePause() {
  const seconds = 2 + Math.random() * 4;
  await delay(Math.round(seconds * 1000));
}

async function humanPause() {
  const { min, max, breakEvery, breakMin, breakMax } = pacingConfig();
  appsSinceBreak++;

  if (breakEvery > 0 && appsSinceBreak % breakEvery === 0) {
    const seconds = Math.round(breakMin + Math.random() * Math.max(0, breakMax - breakMin));
    console.log(
      `  ☕ Taking a ${Math.round(seconds / 60)} min break after ${breakEvery} applications...`
    );
    await delay(seconds * 1000);
    return;
  }

  const spread = Math.max(0, max - min);
  const seconds = Math.round(min + spread * Math.pow(Math.random(), 1.7));
  console.log(`  ⏳ Waiting ${seconds}s before the next application...`);
  await delay(seconds * 1000);
}

function isAuthWallUrl(url) {
  const u = String(url || '');
  return (
    u.includes('/authwall') ||
    u.includes('/login') ||
    u.includes('/checkpoint/') ||
    u.includes('/uas/login')
  );
}

async function assertSessionAlive(page) {
  if (isAuthWallUrl(page.url())) {
    throw new SessionExpiredError('Session expired mid-run. Run: node save-session.js linkedin');
  }
  await assertNotThrottled(page);
}

const MODAL_SELECTOR = [
  '[data-test-modal-id="easy-apply-modal"]',
  '.jobs-easy-apply-modal',
  'div[aria-labelledby="jobs-apply-header"]',
].join(', ');

const JOB_CARD_SELECTORS = [
  '.job-card-container',
  '[data-job-id]',
  'li.scaffold-layout__list-item',
  '.jobs-search-results__list-item',
];

let cardsSeenThisRun = 0;

let workingCardSelector = null;
async function jobCardLocator(page) {
  if (workingCardSelector) return page.locator(workingCardSelector);
  for (const selector of JOB_CARD_SELECTORS) {
    const count = await page
      .locator(selector)
      .count()
      .catch(() => 0);
    if (count > 0) {
      workingCardSelector = selector;
      if (selector !== JOB_CARD_SELECTORS[0]) {
        console.log(`  ℹ️  Job cards matched "${selector}" (LinkedIn's markup has moved on).`);
      }
      return page.locator(selector);
    }
  }
  return page.locator(JOB_CARD_SELECTORS[0]);
}

async function countJobCards(page) {
  return (await jobCardLocator(page)).count().catch(() => 0);
}

async function loadAllJobCards(page) {
  const listSelector = '.jobs-search-results-list, .scaffold-layout__list';
  let stableRounds = 0;
  let lastCount = -1;

  for (let round = 0; round < 40; round++) {
    const count = await countJobCards(page);
    if (count === lastCount) stableRounds++;
    else stableRounds = 0;
    lastCount = count;
    if (stableRounds >= 3) break;

    const scrolled = await page
      .locator(listSelector)
      .first()
      .evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return true;
      })
      .catch(() => false);
    if (!scrolled) {
      await page.mouse.wheel(0, 2000).catch(() => {});
    }
    await delay(400);
  }

  const total = await countJobCards(page);
  cardsSeenThisRun += total;
  return total;
}

async function goToResultsPage(page, pageNumber) {
  const candidates = [
    `button[aria-label="Page ${pageNumber}"]`,
    `li[data-test-pagination-page-btn="${pageNumber}"] button`,
    `button[aria-label="Page ${pageNumber} of "]`,
  ];

  for (const selector of candidates) {
    const button = page.locator(selector).first();
    if (!(await button.isVisible().catch(() => false))) continue;
    await button.click({ timeout: 10000 }).catch(() => {});
    await page
      .waitForSelector(workingCardSelector || JOB_CARD_SELECTORS[0], { timeout: 10000 })
      .catch(() => {});
    await wait();
    return true;
  }
  return false;
}

async function searchAndApply(page, position, location, workModes, maxJobs) {
  const searchUrl = buildSearchUrl({ position, location, workModes });
  const { levels, postedWithinDays } = describeFilters();

  console.log(
    `  🔗 Mode: [${workModes.join(',')}] | Type: [${config.jobTypes}] | Level: [${levels.join(',')}]` +
      `${postedWithinDays ? ` | Posted: last ${postedWithinDays}d` : ''} | Day Shift: ${config.dayShiftOnly} (JD scan)`
  );

  await page.goto(searchUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await wait();
  await assertSessionAlive(page);

  let applied = 0;
  const MAX_RESULT_PAGES = 20;

  for (let resultsPage = 1; resultsPage <= MAX_RESULT_PAGES; resultsPage++) {
    if (applied >= maxJobs) break;

    const totalJobs = await loadAllJobCards(page);
    console.log(`📋 Page ${resultsPage}: found ${totalJobs} job cards`);

    for (let i = 0; i < totalJobs; i++) {
      if (applied >= maxJobs) break;
      if (isStopRequested()) {
        console.log('  🛑 Stop requested — finishing up.');
        break;
      }

      try {
        await assertSessionAlive(page);

        const card = (await jobCardLocator(page)).nth(i);

        const alreadyMarkedApplied = await card
          .locator('text=/^applied\\b/i')
          .first()
          .isVisible()
          .catch(() => false);
        if (alreadyMarkedApplied) continue;

        const fromCard = await readCardIdentity(card);
        const decision = cardDecision(fromCard);
        if (decision.action === 'skip') {
          seenThisRun.add(fromCard.jobId);
          const cardTitle = cleanText(fromCard.title) || 'Unknown Role';
          const cardCompany = cleanCompany(fromCard.company) || 'Unknown Company';
          const cardLink = `https://www.linkedin.com/jobs/view/${fromCard.jobId}`;

          if (decision.log) {
            console.log(`⏭️  Skipping without opening — ${decision.reason}`);
            if (options.dryRun) {
              noteDryRunSkip(
                { title: cardTitle, company: cardCompany, link: cardLink },
                decision.reason
              );
            } else {
              recordApplication({
                jobId: fromCard.jobId,
                title: cardTitle,
                company: cardCompany,
                platform: 'LinkedIn',
                status: 'skipped',
                link: cardLink,
                reason: decision.reason,
              });
            }
          }
          continue;
        }

        await card.scrollIntoViewIfNeeded().catch(() => {});
        await card.click({ timeout: 10000 });
        await Promise.all([
          page
            .waitForSelector('.job-details-jobs-unified-top-card__job-title', {
              timeout: 10000,
            })
            .catch(() => {}),
          page
            .waitForSelector('.job-details-jobs-unified-top-card__company-name', {
              timeout: 10000,
            })
            .catch(() => {}),
        ]);

        const jobTitle = await firstText(page, TITLE_SELECTORS, 'Unknown Role');
        const company = await firstText(page, COMPANY_SELECTORS, 'Unknown Company', cleanCompany);
        const rawUrl = page.url();
        const jobId = getLinkedInJobId(rawUrl);
        const jobLink = jobId ? `https://www.linkedin.com/jobs/view/${jobId}` : rawUrl;

        console.log(`\n👀 Checking: ${jobTitle} @ ${company}`);

        if (jobId && seenThisRun.has(jobId)) continue;
        if (jobId) seenThisRun.add(jobId);

        if (alreadyApplied(jobId)) {
          console.log('⏭️  Already applied, skipping...');
          if (options.dryRun) {
            noteDryRunSkip({ title: jobTitle, company, link: jobLink }, 'already applied');
            continue;
          }
          recordApplication({
            jobId,
            title: jobTitle,
            company,
            platform: 'LinkedIn',
            status: 'skipped',
            link: jobLink,
            reason: 'already applied',
          });
          continue;
        }

        const priorFailures = failuresFor(jobId).length;
        if (priorFailures > 0 && retryBudgetSpent()) {
          console.log('⏭️  Retry budget for this run is spent — leaving this one for next time');
          continue;
        }

        const backoffReason = shouldSkipJob(jobId);
        if (backoffReason) {
          console.log(`⏭️  Skipping — ${backoffReason}`);
          if (options.dryRun) {
            noteDryRunSkip({ title: jobTitle, company, link: jobLink }, backoffReason);
            continue;
          }
          recordApplication({
            jobId,
            title: jobTitle,
            company,
            platform: 'LinkedIn',
            status: 'skipped',
            link: jobLink,
            reason: backoffReason,
          });
          continue;
        }

        const titleFit = assessTitle(jobTitle);
        if (titleFit.skip) {
          console.log(`⏭️  Not your role — ${titleFit.reason}`);
          if (options.dryRun) {
            noteDryRunSkip({ title: jobTitle, company, link: jobLink }, titleFit.reason);
            continue;
          }
          recordApplication({
            jobId,
            title: jobTitle,
            company,
            platform: 'LinkedIn',
            status: 'skipped',
            link: jobLink,
            reason: titleFit.reason,
          });
          continue;
        }

        const jdText = await waitEval(
          page,
          '.jobs-description__content, .job-view-layout',
          (el) => el.innerText.toLowerCase(),
          ''
        );

        if (config.dayShiftOnly) {
          const nightShiftKeywords = [
            'night shift',
            'night-shift',
            'rotational shift',
            'rotating shift',
            'evening shift',
            'graveyard shift',
            'us shift',
            'uk shift',
            'night hours',
            'nocturnal',
            'overnight',
          ];

          const isNightShift = nightShiftKeywords.some((kw) => jdText.includes(kw));
          if (isNightShift) {
            console.log('⏭️  Night/Rotational shift detected in JD — skipping');
            if (options.dryRun) {
              noteDryRunSkip(
                { title: jobTitle, company, link: jobLink },
                'night/rotational shift in JD'
              );
              await browsePause();
              continue;
            }
            recordApplication({
              jobId,
              title: jobTitle,
              company,
              platform: 'LinkedIn',
              status: 'skipped',
              link: jobLink,
              reason: 'night/rotational shift in JD',
            });
            continue;
          }
        }

        const fit = assessFit(jdText);
        if (fit.skip) {
          console.log(`⏭️  Experience mismatch — ${fit.reason}`);
          if (options.dryRun) {
            noteDryRunSkip({ title: jobTitle, company, link: jobLink }, fit.reason);
            await browsePause();
            continue;
          }
          recordApplication({
            jobId,
            title: jobTitle,
            company,
            platform: 'LinkedIn',
            status: 'skipped',
            link: jobLink,
            reason: fit.reason,
          });
          continue;
        }

        const lifetimeCap = companyLifetimeCapReached(company, 'LinkedIn');
        if (lifetimeCap) {
          console.log(`⏭️  Skipping — ${lifetimeCap}`);
          if (options.dryRun) {
            noteDryRunSkip({ title: jobTitle, company, link: jobLink }, lifetimeCap);
          }
          continue;
        }

        if (companyCapReached(company)) {
          console.log(
            `⏭️  Already applied to ${company} ${config.maxApplicationsPerCompanyPerRun}× this run — skipping`
          );
          if (options.dryRun) {
            noteDryRunSkip(
              { title: jobTitle, company, link: jobLink },
              'per-company cap for this run'
            );
          }
          continue;
        }

        const easyApplyBtn =
          (await page.$('[data-control-name="jobdetails_topcard_inapply"]')) ||
          (await page.$('.jobs-apply-button'));

        if (options.dryRun && easyApplyBtn) {
          const btnText = await easyApplyBtn
            .evaluate((el) => (el.getAttribute('aria-label') || el.innerText || '').toLowerCase())
            .catch(() => '');
          if (btnText.includes('easy apply')) {
            dryRunTally.eligible++;
            dryRunTally.jobs.push({ title: jobTitle, company, link: jobLink });
            applied++;
            console.log(`  🧪 DRY RUN — would apply to this job (${dryRunTally.eligible} so far)`);
            console.log(`     ${jobTitle} @ ${company}`);
            console.log(`     ${jobLink}`);
            await browsePause();
            continue;
          }
        }

        if (!easyApplyBtn) {
          console.log('⏭️  No Easy Apply button, skipping...');
          if (options.dryRun) {
            noteDryRunSkip({ title: jobTitle, company, link: jobLink }, 'no Easy Apply button');
            continue;
          }
          recordApplication({
            jobId,
            title: jobTitle,
            company,
            platform: 'LinkedIn',
            status: 'skipped',
            link: jobLink,
          });
          continue;
        }

        const btnLabel = await easyApplyBtn
          .evaluate((el) => (el.getAttribute('aria-label') || el.innerText || '').toLowerCase())
          .catch(() => '');
        if (!btnLabel.includes('easy apply')) {
          console.log('⏭️  "Apply" redirects off LinkedIn, skipping...');
          if (options.dryRun) {
            noteDryRunSkip(
              { title: jobTitle, company, link: jobLink },
              'apply redirects off LinkedIn'
            );
            continue;
          }
          recordApplication({
            jobId,
            title: jobTitle,
            company,
            platform: 'LinkedIn',
            status: 'skipped',
            link: jobLink,
          });
          continue;
        }

        await easyApplyBtn.click();
        await wait();

        await assertNotThrottled(page);

        const alreadyAppliedDialog = await page
          .locator('text=/already applied|application already submitted/i')
          .first()
          .isVisible()
          .catch(() => false);
        if (alreadyAppliedDialog) {
          console.log('⏭️  LinkedIn reports this was already applied to, skipping...');
          await closeModal(page);
          recordApplication({
            jobId,
            title: jobTitle,
            company,
            platform: 'LinkedIn',
            status: 'skipped',
            link: jobLink,
          });
          continue;
        }

        const result = await applyWithRetry(page, jobTitle, company);

        if (await modalPresent(page)) {
          console.warn('  🔄 Application modal is still open — reloading to recover.');
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await wait();
        }

        if (result.ok) {
          recordApplication({
            jobId,
            title: jobTitle,
            company,
            platform: 'LinkedIn',
            status: 'applied',
            link: jobLink,
            answered: result.answered,
          });
          applied++;
          failureTally.consecutive = 0;
          noteCompanyApplication(company);
          console.log(`✅ Applied! (${applied}/${maxJobs})`);
        } else {
          recordApplication({
            jobId,
            title: jobTitle,
            company,
            platform: 'LinkedIn',
            status: 'failed',
            link: jobLink,
            code: result.code,
            reason: result.reason,
            unanswered: result.unanswered,
            answered: result.answered,
            blockers: result.blockers,
            attempts: result.attempts,
          });
          failureTally.total++;
          if (priorFailures > 0) failureTally.retries++;
          if (priorFailures === 0) failureTally.consecutive++;

          const exhausted = failureBudgetExhausted();
          if (exhausted) {
            console.log(`\n🛑 ${exhausted}.`);
            console.log('   Everything so far is logged; see needs-review.md for what to fix.');
            requestStop('failure budget exhausted');
            break;
          }
          console.log('  ➡️  Moving to next job...');
        }

        await humanPause();
      } catch (err) {
        if (err instanceof SessionExpiredError || err instanceof ThrottleError) throw err;
        console.error(`  ⚠️  Error on this job: ${err.message}`);
        console.log('  🔄 Closing modal, moving to next...');
        await closeModal(page);
        await delay(2000);
      }
    }

    if (applied >= maxJobs || isStopRequested()) break;
    const wentToNextPage = await goToResultsPage(page, resultsPage + 1);
    if (!wentToNextPage) {
      console.log('  📄 No further result pages for this search.');
      break;
    }
  }

  return applied;
}

async function modalPresent(page) {
  return Boolean(await page.$(MODAL_SELECTOR).catch(() => null));
}

async function closeModal(page) {
  const clickIfPresent = async (selector) => {
    await page.click(selector, { force: true, timeout: 3000 }).catch(() => {});
  };

  await clickIfPresent('button[aria-label="Dismiss"]');
  await delay(400);
  await clickIfPresent('button[data-control-name="discard_application_confirm_btn"]');
  await delay(400);
  await clickIfPresent('button:has-text("Discard")');
  await delay(300);
  if (!(await modalPresent(page))) return true;

  await page.keyboard.press('Escape').catch(() => {});
  await delay(400);
  await clickIfPresent('button:has-text("Discard")');
  await delay(300);
  if (!(await modalPresent(page))) return true;

  await page
    .evaluate((selector) => {
      document.querySelector(selector)?.remove();
      document.querySelector('.artdeco-modal-overlay')?.remove();
      document.body?.classList?.remove('overflow-hidden');
    }, MODAL_SELECTOR)
    .catch(() => {});
  await delay(300);

  const stillOpen = await modalPresent(page);
  if (stillOpen) console.warn('  ⚠️  Could not close the application modal.');
  return !stillOpen;
}

async function formSignature(modal) {
  try {
    return await modal.evaluate((root) => {
      const inputs = Array.from(root.querySelectorAll('input, textarea, select'));
      const values = inputs
        .filter((el) => el.offsetParent !== null)
        .map((el) => `${el.type}|${el.id || el.name || ''}=${el.value || ''}`)
        .join(';');
      const buttons = Array.from(root.querySelectorAll('button'))
        .filter((b) => b.offsetParent !== null)
        .map((b) => b.getAttribute('aria-label') || b.innerText.trim())
        .join('|');
      return `${values}::${buttons}`;
    });
  } catch {
    return '';
  }
}

const TRANSIENT_RETRY_LIMIT = 1;

async function openEasyApplyModal(page) {
  const btn =
    (await page.$('[data-control-name="jobdetails_topcard_inapply"]')) ||
    (await page.$('.jobs-apply-button'));
  if (!btn) return 'unavailable';

  const label = await btn
    .evaluate((el) => (el.getAttribute('aria-label') || el.innerText || '').toLowerCase())
    .catch(() => '');
  if (/applied/.test(label) && !/easy apply/.test(label)) return 'already_applied';

  await btn.click().catch(() => {});
  await wait();

  const appliedDialog = await page
    .locator('text=/already applied|application already submitted/i')
    .first()
    .isVisible()
    .catch(() => false);
  if (appliedDialog) return 'already_applied';

  return (await page.$(MODAL_SELECTOR)) ? 'opened' : 'unavailable';
}

async function applyWithRetry(page, jobTitle, company) {
  let result = null;
  let attempt = 0;

  while (attempt <= TRANSIENT_RETRY_LIMIT) {
    attempt++;

    if (attempt > 1) {
      console.log(
        `  🔁 Transient failure — retrying on a fresh form (${attempt}/${TRANSIENT_RETRY_LIMIT + 1})`
      );
      await delay(1500);
      const reopened = await openEasyApplyModal(page);

      if (reopened === 'already_applied') {
        console.log('  ✅ LinkedIn now reports this as applied — the first attempt landed.');
        result = { ok: true, unanswered: [], answered: result?.answered || [], blockers: [] };
        break;
      }

      if (reopened !== 'opened') {
        result = {
          ok: false,
          code: 'modal_missing',
          reason: 'Easy Apply form would not reopen for a retry',
          unanswered: result?.unanswered || [],
          answered: result?.answered || [],
          blockers: result?.blockers || [],
        };
        break;
      }
    }

    try {
      result = await withJobTimeout(
        fillLinkedInForm(page, jobTitle, company),
        `${jobTitle} @ ${company}`
      );
    } catch (formErr) {
      if (formErr instanceof SessionExpiredError || formErr instanceof ThrottleError) throw formErr;
      result = {
        ok: false,
        code: /timed out/i.test(formErr.message) ? 'timeout' : 'error',
        reason: formErr.message,
        unanswered: [],
        answered: [],
        blockers: [],
      };
    } finally {
      await closeModal(page);
    }

    if (result.ok) break;
    console.log(`  ⚠️  ${describeCode(result.code)}: ${result.reason}`);
    if (!isTransient(result.code)) break;
  }

  return { ...result, attempts: attempt };
}

async function fillLinkedInForm(page, jobTitle, company) {
  const unanswered = [];
  const note = (kind, question, options) => {
    const text = String(question || '').trim();
    if (!text) return;
    if (unanswered.some((u) => u.question === text)) return;
    unanswered.push({ kind, question: text, ...(options?.length ? { options } : {}) });
  };
  const answered = [];
  const record = (kind, question, answer) => {
    const text = String(question || '').trim();
    const value = String(answer ?? '').trim();
    if (!text || !value) return;
    if (answered.some((a) => a.question === text)) return;
    answered.push({ kind, question: text.slice(0, 200), answer: value.slice(0, 200) });
  };
  const rejections = [];
  const reject = (label, answer) => {
    const text = String(label || '').trim();
    if (!text) return;
    const entry = `${text}: the field refused "${String(answer).slice(0, 40)}"`;
    if (!rejections.includes(entry)) rejections.push(entry);
  };

  const fail = (code, reason, blockers = []) => ({
    ok: false,
    code,
    reason,
    unanswered,
    answered,
    blockers: [...blockers, ...rejections],
  });
  const stall = (code, reason, blockers = []) =>
    unanswered.length
      ? fail(
          'unanswerable',
          `No answer for: ${unanswered
            .map((u) => u.question)
            .slice(0, 3)
            .join(' | ')}`,
          blockers
        )
      : fail(code, reason, blockers);

  try {
    let step = 0;
    const maxSteps = 12;
    let stuckCount = 0;

    while (step < maxSteps) {
      step++;
      await wait();

      const modal = await page.$(MODAL_SELECTOR);
      if (!modal) {
        return stall('modal_missing', 'Application form closed before it could be submitted');
      }

      await handleResumeUpload(modal);

      const phoneField = await modal.$('input[id*="phoneNumber"]');
      if (phoneField) {
        const val = await phoneField.inputValue();
        if (!val) {
          await phoneField.fill(config.phone);
          record('phone', 'Phone number', config.phone);
        }
      }

      const countryCodeSelect = await modal.$(
        'select[id*="phoneNumber-country"], select[name*="phoneNumberCountryCode"]'
      );
      if (countryCodeSelect && config.phoneCountryCode) {
        const currentVal = await countryCodeSelect.evaluate((el) => el.value).catch(() => '');
        if (!currentVal || !String(currentVal).includes(config.phoneCountryCode)) {
          const matched = await countryCodeSelect
            .evaluate((el, code) => {
              const opt = Array.from(el.options).find((o) => o.text.includes(code));
              return opt ? opt.text : '';
            }, config.phoneCountryCode)
            .catch(() => '');
          if (matched) {
            await countryCodeSelect.selectOption({ label: matched }).catch(() => {});
            console.log(`  Selected [phone country code] → "${matched}"`);
            record('dropdown', 'Phone country code', matched);
          }
        }
      }

      const textInputs = await modal.$$('input[type="text"], input[type="number"]');
      for (const input of textInputs) {
        const isVisible = await input.isVisible().catch(() => false);
        if (!isVisible) continue;
        const value = await input.inputValue();
        if (value) continue;

        const { label, inputType, hasCombobox, required } = await input.evaluate((el) => ({
          label: (
            document.querySelector(`label[for="${el.id}"]`)?.innerText ||
            el.placeholder ||
            el.name ||
            ''
          ).trim(),
          inputType: el.type || 'text',
          hasCombobox:
            el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete'),
          required: el.required || el.getAttribute('aria-required') === 'true',
        }));

        const answer = await mapFieldToAnswer(label, jobTitle, company, inputType, []);
        if (!answer) {
          if (required) note(inputType === 'number' ? 'number' : 'text', label);
          continue;
        }

        const filled = await smartFill(input, answer, label);
        if (filled) {
          console.log(`  Filled [${inputType}] "${label}" → "${filled}"`);
          const resolved = hasCombobox ? await resolveTypeahead(modal, input, filled) : '';
          record(inputType, label, resolved || filled);
        } else if (required) {
          reject(label, answer);
        }
      }

      const textareas = await modal.$$('textarea');
      for (const ta of textareas) {
        const isVisible = await ta.isVisible().catch(() => false);
        if (!isVisible) continue;
        const value = await ta.inputValue();
        if (value) continue;

        const label = await ta.evaluate((el) =>
          (
            document.querySelector(`label[for="${el.id}"]`)?.innerText ||
            el.placeholder ||
            ''
          ).trim()
        );

        const isCoverLetter = /cover|letter|summary|introduce|about yourself/i.test(label);
        if (isCoverLetter) {
          const letter = await generateCoverLetter(jobTitle, company);
          await ta.fill(letter);
          console.log(`  Filled [textarea] "${label}" → cover letter`);
          record('cover letter', label, `${letter.slice(0, 120)}…`);
        } else {
          const answer = await answerQuestion(label, jobTitle, company, 'textarea', []);
          if (answer) {
            await ta.fill(answer);
            console.log(`  Filled [textarea] "${label}" → "${answer.slice(0, 60)}..."`);
            record('textarea', label, answer);
          } else {
            note('textarea', label);
          }
        }
      }

      const selects = await modal.$$('select');
      for (const select of selects) {
        const isVisible = await select.isVisible().catch(() => false);
        if (!isVisible) continue;

        const { label, options } = await select.evaluate((el) => ({
          label: (document.querySelector(`label[for="${el.id}"]`)?.innerText || '').trim(),
          options: Array.from(el.options)
            .slice(1)
            .map((o) => o.text.trim()),
        }));

        if (options.length === 0) continue;

        const answer = await mapFieldToAnswer(label, jobTitle, company, 'select', options);
        if (!answer) {
          console.warn(`  No reliable dropdown answer for "${label}"`);
          note('dropdown', label, options);
          continue;
        }
        const matchedOption = options.find((o) =>
          o.toLowerCase().includes(String(answer).toLowerCase())
        );
        if (!matchedOption && !policy.mayGuess(label)) {
          console.warn(`  Answer "${answer}" matches no option for "${label}" — not guessing`);
          note('dropdown', label, options);
          continue;
        }
        const chosen = matchedOption || options[0];
        await select.selectOption({ label: chosen });
        console.log(`  Selected [dropdown] "${label}" → "${chosen}"`);
        record('dropdown', label, chosen);
      }

      const radioContainers = await modal.$$('[data-test-form-element]');
      for (const container of radioContainers) {
        const radios = await container.$$('input[type="radio"]');
        if (radios.length === 0) continue;

        const anyChecked = await container.$$('input[type="radio"]:checked');
        if (anyChecked.length > 0) continue;

        const questionLabel = await container
          .$eval('label, legend, [data-test-form-element-label]', (el) => el.innerText.trim())
          .catch(() => '');

        let optionLabels = await container.$$eval(
          '[data-test-text-selectable-option__label]',
          (els) => els.map((el) => el.innerText.trim()).filter((t) => t.length > 0)
        );
        if (optionLabels.length === 0) {
          optionLabels = await container.$$eval(
            'label',
            (els, q) => els.map((el) => el.innerText.trim()).filter((t) => t.length > 0 && t !== q),
            questionLabel
          );
        }

        const answer = await mapFieldToAnswer(
          questionLabel,
          jobTitle,
          company,
          'radio',
          optionLabels
        );
        if (!answer) {
          console.warn(`  No reliable radio answer for "${questionLabel}"`);
          note('radio', questionLabel, optionLabels);
          continue;
        }

        const allOptionEls = await container.$$('[data-test-text-selectable-option__label]');
        let clicked = false;
        for (const optEl of allOptionEls) {
          const text = await optEl.innerText().catch(() => '');
          if (text.toLowerCase().includes(answer.toLowerCase())) {
            await optEl.click({ force: true }).catch(() => {});
            console.log(`  Selected [radio] "${questionLabel}" → "${text}"`);
            record('radio', questionLabel, text);
            clicked = true;
            break;
          }
        }

        if (!clicked && allOptionEls.length > 0) {
          if (!policy.mayGuess(questionLabel)) {
            console.warn(`  No matching option for "${questionLabel}" — not guessing`);
            note('radio', questionLabel, optionLabels);
          } else {
            const firstText = await allOptionEls[0].innerText().catch(() => '');
            await allOptionEls[0].click({ force: true }).catch(() => {});
            console.log(`  Selected [radio] "${questionLabel}" → "${firstText}" (fallback)`);
            record('radio (fallback)', questionLabel, firstText);
          }
        }
      }

      const checkboxContainers = await modal.$$('[data-test-form-element]');
      for (const container of checkboxContainers) {
        const boxes = await container.$$('input[type="checkbox"]');
        if (boxes.length < 2) continue;

        const anyChecked = await container.$$('input[type="checkbox"]:checked');
        if (anyChecked.length > 0) continue;

        const questionLabel = await container
          .$eval('legend, [data-test-form-element-label]', (el) => el.innerText.trim())
          .catch(() => '');

        let optionLabels = await container.$$eval(
          '[data-test-text-selectable-option__label]',
          (els) => els.map((el) => el.innerText.trim()).filter((t) => t.length > 0)
        );
        if (optionLabels.length === 0) {
          optionLabels = await container.$$eval(
            'label',
            (els, q) => els.map((el) => el.innerText.trim()).filter((t) => t.length > 0 && t !== q),
            questionLabel
          );
        }
        if (optionLabels.length === 0) continue;

        const optionEls = await container.$$('[data-test-text-selectable-option__label]');
        let anySelected = false;
        for (let idx = 0; idx < optionLabels.length; idx++) {
          const optionText = optionLabels[idx];
          const combinedQuestion = questionLabel ? `${questionLabel} ${optionText}` : optionText;
          const shouldCheck = await mapFieldToAnswer(
            combinedQuestion,
            jobTitle,
            company,
            'checkbox',
            ['Yes', 'No']
          );
          if (String(shouldCheck).toLowerCase() === 'yes') {
            const target = optionEls[idx] || (await container.$$('label'))[idx];
            if (target) {
              await target.click({ force: true }).catch(() => {});
              anySelected = true;
              console.log(`  Checked [checkbox] "${questionLabel}" → "${optionText}"`);
              record('checkbox', `${questionLabel} → ${optionText}`, 'checked');
            }
          }
        }

        if (!anySelected) {
          const isRequired = await container
            .$eval(
              'input[type="checkbox"]',
              (el) => el.required || el.closest('[required]') != null
            )
            .catch(() => false);
          if (isRequired && !policy.mayGuess(questionLabel)) {
            console.warn(`  Nothing matched for "${questionLabel}" — not ticking a box at random`);
            note('checkbox group', questionLabel, optionLabels);
          } else if (isRequired && optionEls[0]) {
            await optionEls[0].click({ force: true }).catch(() => {});
            console.log(
              `  Checked [checkbox] "${questionLabel}" → "${optionLabels[0]}" (fallback)`
            );
            record('checkbox (fallback)', `${questionLabel} → ${optionLabels[0]}`, 'checked');
          }
        }
      }

      const checkboxes = await modal.$$('input[type="checkbox"]');
      for (const cb of checkboxes) {
        const required = await cb.evaluate(
          (el) => el.required || el.getAttribute('aria-required') === 'true'
        );
        if (!required) continue;
        const checked = await cb.isChecked().catch(() => false);
        if (!checked) await cb.click({ force: true }).catch(() => {});
      }

      const nextBtn =
        (await modal.$('button[aria-label="Continue to next step"]')) ||
        (await modal.$('button[aria-label="Review your application"]')) ||
        (await modal.$('button:has-text("Next")')) ||
        (await modal.$('button:has-text("Review")'));
      if (nextBtn) {
        const invalidFields = await getInvalidFields(modal);
        if (invalidFields.length > 0) {
          console.warn(`  Cannot continue; invalid fields: ${invalidFields.join(' | ')}`);
          return stall(
            'invalid_field',
            `Form rejected ${invalidFields.length} field(s) before "Next"`,
            invalidFields
          );
        }
        const before = await formSignature(modal);
        const freshBtn = (await modal.$('button[aria-label="Continue to next step"]')) || nextBtn;
        await freshBtn.click({ force: true });
        await wait();
        const after = await formSignature(modal);
        if (before && after && before === after) {
          stuckCount++;
          if (stuckCount >= 3) {
            return stall('stuck_form', 'Form would not advance after 3 "Next" clicks');
          }
        } else {
          stuckCount = 0;
        }
        continue;
      }

      const submitBtn =
        (await modal.$('button[aria-label="Submit application"]')) ||
        (await modal.$('button:has-text("Submit application")'));
      if (submitBtn) {
        const invalidFields = await getInvalidFields(modal);
        if (invalidFields.length > 0) {
          console.warn(`  Cannot submit; invalid fields: ${invalidFields.join(' | ')}`);
          return stall(
            'invalid_field',
            `Form rejected ${invalidFields.length} field(s) on the final step`,
            invalidFields
          );
        }
        await submitBtn.click({ force: true });
        await wait();
        console.log('  🚀 Submitted!');

        await delay(2000);
        const confirmed = await confirmSubmission(page);
        if (!confirmed) {
          return fail(
            'unconfirmed_submit',
            'Submit was clicked but LinkedIn never showed a confirmation'
          );
        }
        const dismissedPopup = await dismissPostSubmitPopup(page);
        if (dismissedPopup) {
          console.log('  ✅ Dismissed follow popup');
        }
        return { ok: true, unanswered, answered, blockers: [] };
      }

      stuckCount++;
      if (stuckCount >= 2) {
        return stall('no_action', 'No "Next" or "Submit" appeared and the form stopped changing');
      }

      const dismissBtn = await modal.$('button[aria-label="Dismiss"]');
      if (dismissBtn) {
        await dismissBtn.click({ force: true });
        break;
      }

      break;
    }

    return stall(
      'no_action',
      `Form never reached "Submit" (gave up after ${step}/${maxSteps} steps)`
    );
  } catch (err) {
    await closeModal(page);
    return fail('error', err.message);
  }
}

async function confirmSubmission(page) {
  const successText = await page
    .locator('text=/application (was )?sent|application submitted|your application was sent/i')
    .first()
    .isVisible()
    .catch(() => false);
  if (successText) return true;

  const modalStillOpen = await page
    .locator(MODAL_SELECTOR)
    .isVisible()
    .catch(() => false);
  if (modalStillOpen) return false;

  await delay(800);
  const buttonSaysApplied = await page
    .evaluate(() => {
      const btn =
        document.querySelector('.jobs-apply-button') ||
        document.querySelector('[data-control-name="jobdetails_topcard_inapply"]');
      if (!btn) return false;
      const text = `${btn.getAttribute('aria-label') || ''} ${btn.innerText || ''}`.toLowerCase();
      return /\bapplied\b/.test(text) && !/easy apply/.test(text);
    })
    .catch(() => false);
  if (buttonSaysApplied) return true;

  return false;
}

async function dismissPostSubmitPopup(page) {
  const selectors = [
    'button[aria-label="Not now"]',
    'button[aria-label="Done"]',
    'button[aria-label="Dismiss"]',
    'button:has-text("Not now")',
    'button:has-text("Done")',
    'button:has-text("Dismiss")',
  ];

  for (let attempt = 0; attempt < 6; attempt++) {
    for (const selector of selectors) {
      const button = page.locator(selector).first();
      const visible = await button.isVisible().catch(() => false);
      if (!visible) continue;

      await button.click({ force: true }).catch(() => {});
      await delay(500);
      const stillVisible = await button.isVisible().catch(() => false);
      if (!stillVisible) return true;
    }

    await delay(750);
  }

  return false;
}

async function getInvalidFields(modal) {
  return modal.$$eval(
    'input:invalid, select:invalid, textarea:invalid, [aria-invalid="true"]',
    (elements) =>
      elements
        .filter((element) => element.offsetParent !== null)
        .map((element) => {
          const label =
            document.querySelector(`label[for="${element.id}"]`)?.innerText ||
            element.getAttribute('placeholder') ||
            element.getAttribute('name') ||
            element.getAttribute('aria-label') ||
            'Unknown field';
          return `${label.trim()}: ${element.validationMessage || 'invalid value'}`;
        })
  );
}

async function handleResumeUpload(modal) {
  const path = require('path');
  const resumePath = path.resolve(config.resumePath || '');
  if (!resumePath || !require('fs').existsSync(resumePath)) return;

  const fileInputs = await modal.$$('input[type="file"]');
  for (const fileInput of fileInputs) {
    try {
      const alreadyHasFile = await fileInput.evaluate((el) => el.files && el.files.length > 0);
      if (alreadyHasFile) continue;

      const accept = await fileInput.evaluate((el) =>
        (el.getAttribute('accept') || '').toLowerCase()
      );
      const ext = path.extname(resumePath).toLowerCase().replace('.', '');
      if (accept && ext && !accept.includes(ext) && !accept.includes('*')) continue;

      await fileInput.setInputFiles(resumePath);
      console.log(`  📎 Uploaded resume: ${path.basename(resumePath)}`);
      await delay(800);
    } catch (e) {
      console.warn(`  Could not upload resume to file field: ${e.message}`);
    }
  }
}

async function resolveTypeahead(modal, input, typedValue) {
  const listbox = modal.locator(
    '[role="listbox"] [role="option"], .basic-typeahead__triggered-content li'
  );

  let count = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    count = await listbox.count().catch(() => 0);
    if (count > 0) break;
    await delay(300);
  }
  if (count === 0) return '';

  const needle = String(typedValue || '')
    .trim()
    .toLowerCase();

  let target = null;
  if (needle) {
    for (let i = 0; i < count; i++) {
      const text = (
        await listbox
          .nth(i)
          .innerText()
          .catch(() => '')
      )
        .trim()
        .toLowerCase();
      if (!text) continue;
      if (text.includes(needle) || needle.includes(text)) {
        target = listbox.nth(i);
        break;
      }
    }
  }

  if (!target) {
    console.warn(`  No suggestion matched "${typedValue}" — leaving the field for review`);
    return '';
  }

  const chosen = await target.innerText().catch(() => '');
  await target.click({ force: true, timeout: 3000 }).catch(() => {});
  await delay(300);
  return cleanText(chosen);
}

async function smartFill(input, answer, label) {
  const metadata = await input
    .evaluate((el) => ({
      inputType: el.type || 'text',
      step: el.getAttribute('step') || '',
      pattern: el.getAttribute('pattern') || '',
      min: el.getAttribute('min') || '',
      max: el.getAttribute('max') || '',
    }))
    .catch(() => ({ inputType: 'text', step: '', pattern: '', min: '', max: '' }));

  const answerText = String(answer ?? '').trim();
  const answerIsNumeric = /^-?\d+(?:\.\d+)?$/.test(answerText.replace(/[,\s]/g, ''));
  const numeric =
    metadata.inputType === 'number' ||
    (isNumericQuestion(label, metadata.inputType) && answerIsNumeric);

  const candidates = numeric
    ? buildNumericCandidates(answer, label, metadata)
    : [answerText].filter(Boolean);

  if (candidates.length === 0) {
    console.warn(`  Refusing non-numeric answer "${answer}" for numeric field "${label}"`);
    return '';
  }

  for (const candidate of candidates) {
    await input.fill('');
    await input.fill(candidate);
    await input.evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await delay(300);

    const { actual, valid } = await input.evaluate((el) => ({
      actual: el.value,
      valid: el.checkValidity(),
    }));

    if (valid && (actual === candidate || Number(actual) === Number(candidate))) {
      if (candidate !== String(answer)) {
        console.log(`    Field required "${candidate}" instead of "${answer}"`);
      }
      return candidate;
    }
  }

  console.warn(`  No valid value found for "${label}" from answer "${answer}"`);
  await input.fill('');
  return '';
}

async function mapFieldToAnswer(label, jobTitle, company, inputType = 'text', options = []) {
  const answerType = isNumericQuestion(label, inputType) ? 'number' : inputType;

  const known = deterministicAnswer(label, answerType, options);
  if (known) return known;

  if (label.trim().length > 2) {
    return await answerQuestion(label, jobTitle, company, answerType, options);
  }

  return options[0] || '';
}

module.exports = {
  getLinkedInJobId,
  runLinkedIn,
  fillLinkedInForm,
  closeModal,
  getInvalidFields,
  throttleMessageIn,
  pacingConfig,
  dryRunTally,
  noteDryRunSkip,
  failureTally,
  failureBudgetExhausted,
  effectiveRunBudget,
  retryBudgetSpent,
  companyKey,
  companyCapReached,
  JOB_CARD_SELECTORS,
  MODAL_SELECTOR,
  cleanText,
  cleanCompany,
  readCardIdentity,
  cardDecision,
  seenThisRun,
  noteCompanyApplication,
  resetRunState,
};
