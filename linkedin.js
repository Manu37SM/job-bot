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
  isTransient,
  describeCode,
} = require('./logger');
const { getLocationSearchPairs } = require('./location-helper');
const { deterministicAnswer, isNumericQuestion } = require('./answer-utils');
const { buildNumericCandidates } = require('./field-value');
const { isStopRequested, requestStop } = require('./shutdown');
const policy = require('./question-policy');
const { assessFit } = require('./job-fit');
const { assessTitle } = require('./title-fit');
const { buildSearchUrl, describeFilters } = require('./search-filters');
const { options } = require('./cli');
const { recordThrottle, activeHold } = require('./cooldown');
const { cleanText, cleanCompany } = require('./text-utils');

// Counters for a dry run, where nothing is recorded to the log.
const dryRunTally = { eligible: 0, skipped: 0, jobs: [], screened: [] };

// A dry run's report is only useful if it accounts for every job the bot looked
// at. Previously only the two job-description screens reported themselves, so a
// run that saw 60 postings and skipped 55 as already-applied would show 5 and say
// nothing about the rest — which reads as "the search found almost nothing".
function noteDryRunSkip(job, reason) {
  dryRunTally.skipped++;
  dryRunTally.screened.push({ ...job, reason });
}

// Run-scoped state. The searches overlap heavily — "FullStack Developer" and
// "Backend Developer" in Mumbai return many of the same postings — so without this
// the same job is opened, its description fetched, and its rules re-evaluated once
// per search term. Reset at the start of each run.
const seenThisRun = new Set();
const companyApplicationsThisRun = new Map();

// A run's budget counts successes, so nothing bounded the failures — and each one
// costs a form fill plus a retry. With a backlog of old failures to re-attempt,
// a run could grind for hours and apply to nothing. Two limits: a total, and a
// consecutive streak, because a streak usually means something systemic (LinkedIn
// markup changed, the session is half-dead) rather than bad luck on one posting.
const failureTally = { total: 0, consecutive: 0, retries: 0 };

// Re-attempts of jobs that have failed before, capped per run. Without this a
// backlog of old failures crowds out fresh postings entirely: they appear in the
// same search results, they are attempted first because that is the order LinkedIn
// returns them, and a run whose whole budget went to known-bad jobs applies to
// nothing new. They are not lost — they come round again next run.
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

// Returns a reason string when the run should stop, or null to continue.
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

function companyKey(company) {
  return String(company || '')
    .toLowerCase()
    .replace(
      /\b(pvt|private|ltd|limited|llp|inc|corp|corporation|technologies|technology|solutions|services|india)\b/g,
      ''
    )
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

// A recruiter seeing five applications from one person inside an hour reads it as
// spray-and-pray, and each extra one adds little. Capped per run, not per day, so a
// genuine second look tomorrow is unaffected.
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

// `instant` exists for the test suite: the form-filling tests drive a fake page and
// must not spend real seconds waiting for a browser that isn't there.
const DELAYS = { slow: 3000, medium: 1500, fast: 500, instant: 0 };

// Note `??` rather than `||`: a configured delay of 0 is a valid value, and `||`
// would silently turn it back into the 2000ms default.
const delay = (ms) => new Promise((r) => setTimeout(r, config.speed === 'instant' ? 0 : ms));
const wait = () => delay(DELAYS[config.speed] ?? 2000);

// Per-job wall-clock guard. A single job form that hangs (modal won't advance,
// AI call stalls, LinkedIn overlay stuck) must not block the whole run.
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

// Like page.$eval but waits for the selector to appear (up to `timeoutMs`) so we
// don't read "Unknown Role" just because the card detail hadn't rendered yet.
// Falls back to `fallback` if the selector never shows up.
async function waitEval(page, selector, fn, fallback, timeoutMs = 8000) {
  try {
    await page.waitForSelector(selector, { state: 'attached', timeout: timeoutMs });
  } catch {
    return fallback;
  }
  return page.$eval(selector, fn).catch(() => fallback);
}

// Titles and company names come out of the DOM with newlines, padding, and a
// trailing " · Mumbai, India" on the company. Left raw they end up in
// applications.json and needs-review.md exactly as scraped.
// Tries each selector in turn, so one renamed class doesn't turn every logged job
// into "Unknown Role @ Unknown Company". Only the first gets a generous wait; the
// rest are checked quickly, because they only matter when the first has already
// failed and a per-job budget is not worth spending three times over.
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

// How many applications this run may make. Extracted so the arithmetic can be
// tested: `--limit` must only ever TIGHTEN the configured caps. A flag that could
// raise them would let `--limit 100` blow straight past a deliberately small daily
// ceiling, which is the one number standing between this bot and a restriction.
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

  // A hold left over from a previous run's rate limit. Dry runs are allowed
  // through: they apply to nothing, and checking whether the pause has lifted is a
  // reasonable thing to want to do.
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
  // A daily ceiling on top of the per-run one. Without it, several runs in an
  // afternoon add up to a volume no human produces — which is what LinkedIn's
  // "applying at a fast pace" safeguard is measuring.
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
  // A dry run applies to nothing, so the quotas it would consume are irrelevant —
  // it still needs to walk the pipeline even when the day's budget is spent.
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

  // Launched before the try so a mid-setup failure (bad storageState, etc.) still
  // reaches the finally below and the browser process is never left running.
  const browser = await chromium.launch({ headless: false, slowMo: 100 });

  try {
    const context = await browser.newContext({ storageState: sessionFile });
    const page = await context.newPage();

    // Fail fast instead of hanging for the default 30s+ per action when LinkedIn
    // is slow or a selector is stale. Each action retries at the call site.
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(60000);

    await loginToLinkedIn(page);

    // In a dry run nothing increments `applied`, so give the walk a finite budget
    // of its own rather than letting it page through every result forever.
    const runBudget = options.dryRun ? (options.limit ?? Math.max(perRun, 5)) : canApply;
    resetRunState();
    let appliedThisRun = 0;
    const locationPairs = getLocationSearchPairs();

    for (const position of config.positions) {
      if (appliedThisRun >= runBudget || isStopRequested()) break;

      for (const { location, workModes } of locationPairs) {
        if (appliedThisRun >= runBudget || isStopRequested()) break;

        console.log(`\n🔍 Searching: "${position}" in "${location}" [${workModes.join(',')}]`);
        const count = await searchAndApply(
          page,
          position,
          location,
          workModes,
          runBudget - appliedThisRun
        );
        appliedThisRun += count;
      }
    }

    if (cardsSeenThisRun === 0) {
      // Every search returned nothing. That is almost never "no jobs" — it is the
      // page not rendering as expected, which otherwise looks identical to a quiet
      // job market and can go unnoticed for weeks.
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
      // Persisted, so the NEXT run is held too — the run after a pause is the
      // dangerous one, and by then this process is long gone.
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

  // Throw instead of process.exit(1): exiting the whole process here would skip
  // browser.close() (leaked Chromium process) and skip index.js's summary/other
  // platforms. The caller's try/finally handles cleanup and a clean error message.
  if (page.url().includes('login') || page.url().includes('authwall')) {
    throw new Error('Session expired. Run: node save-session.js linkedin');
  }

  console.log('✅ LinkedIn session loaded!');
}

// Thrown when we detect mid-run that LinkedIn has logged us out / thrown up an
// authwall (session cookie expired, security checkpoint, etc). Distinct from a
// per-job error so callers can abort the whole run instead of burning through
// every remaining job with the same doomed "Session expired" failure.
class SessionExpiredError extends Error {}

// LinkedIn shows an interstitial when it decides an account is applying too
// fast ("we've briefly paused Easy Apply ..."). That is a rate limit, not a
// broken form: every remaining job in the run would hit the same wall, and
// hammering through it is exactly what escalates to an account restriction.
// Treated like session expiry — abort the run cleanly and let the cooldown pass.
class ThrottleError extends Error {}

// Two tiers, because the page text this is matched against includes the job
// description — and a posting that says "apply now, we'll get back to you, or try
// again later" would otherwise abort a perfectly healthy run.
//
// STRONG phrases are unmistakably LinkedIn's own rate-limit notice and count
// wherever they appear. WEAK ones are ordinary English that only means throttling
// inside an alert or dialog, so they are matched against those regions alone.
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

// `alertText` is the text of alert/dialog regions only. Callers that have just the
// page body can omit it — the weak tier is then simply not consulted.
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

// Human-ish cadence between applications. A fixed `pauseBetweenApps` with a
// sub-second jitter produces a near-perfectly regular request rhythm, which is
// the single easiest automation signal to spot — and the one that triggered the
// "applying at a fast pace" safeguard. Real applicants read the posting, pause
// unevenly, and stop for a while every so often.
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

// A dry run submits nothing, so it does not need the full between-applications
// pause — but it is still a logged-in session clicking through job after job, and
// doing that every 400ms is a louder automation signal than applying slowly. This
// matters most in exactly the situation a dry run is for: testing during a cooldown.
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

  // Skewed toward the low end but with a long tail, rather than a flat band —
  // a uniform random delay is itself a recognisable pattern.
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

// LinkedIn's results list is virtualized/lazy-loaded — only ~8-10 cards exist in
// the DOM until the list is scrolled. Without this, `totalJobs` undercounts and
// the bot silently stops after the first screenful even though more jobs exist
// on the same results page.
// LinkedIn renames these classes from time to time. When the one selector the bot
// knew stopped matching, every search returned zero cards and the run reported
// "found 0 job cards" — indistinguishable from "there are no jobs", which is how a
// broken bot looks like a quiet job market for weeks.
// The Easy Apply modal, named three ways. A single hard-coded attribute here is
// the highest-consequence selector in the file: if LinkedIn renames it, every job
// fails as `modal_missing` AND closeModal concludes it has nothing to close.
// Comma-separated so Playwright tries them all in one query.
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

// Cards seen across the whole run, so a run that saw none anywhere can say so
// plainly instead of shrugging.
let cardsSeenThisRun = 0;

// Returns the first selector that actually matches something, remembering it for
// the rest of the run so the fallbacks aren't re-tried on every scroll.
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

// Loads EVERY card on the results page — deliberately not stopping once the run's
// application budget is reached. The budget counts applications, and most cards are
// skipped (already applied, parked, screened out), so stopping at eight cards on a
// page of twenty-five means paginating away from seventeen jobs that were never
// looked at. Scrolling a full page costs a few seconds; skipping past live postings
// costs applications that never happen.
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
      // Fallback: some layouts scroll the whole page instead of an inner pane.
      await page.mouse.wheel(0, 2000).catch(() => {});
    }
    await delay(400);
  }

  const total = await countJobCards(page);
  cardsSeenThisRun += total;
  return total;
}

// Clicks LinkedIn's results pagination to the given page number. Returns false
// once there's no such page (end of results) so the caller can move on to the
// next search instead of looping forever.
async function goToResultsPage(page, pageNumber) {
  // Same reasoning as the card selectors: one hard-coded aria-label is a single
  // point of silent failure, and "no next page" is indistinguishable from "the
  // button is called something else now".
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
  const MAX_RESULT_PAGES = 20; // safety cap so a stuck pagination loop can't run forever

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

        // A card already marked "Applied" in LinkedIn's own UI (e.g. applied via
        // the site directly, or a previous run before this jobId was logged)
        // should never be re-opened.
        const alreadyMarkedApplied = await card
          .locator('text=/^applied\\b/i')
          .first()
          .isVisible()
          .catch(() => false);
        if (alreadyMarkedApplied) continue;

        await card.scrollIntoViewIfNeeded().catch(() => {});
        await card.click({ timeout: 10000 });
        // Wait for the job details panel (not a fixed sleep) so we read the right
        // title/company/JD instead of the previous card's content.
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
        // The results URL carries the job id in a query param, so the raw link
        // reopens the whole search rather than the posting. Store the permalink —
        // applications.json is something you click through months later.
        const rawUrl = page.url();
        const jobId = getLinkedInJobId(rawUrl);
        const jobLink = jobId ? `https://www.linkedin.com/jobs/view/${jobId}` : rawUrl;

        console.log(`\n👀 Checking: ${jobTitle} @ ${company}`);

        // Already handled under a different search term this run.
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

        // Smart backoff. A job that has already failed for a reason re-running
        // cannot fix (a question with no answer in config.js) is parked until
        // those answer files actually change, and any job is retired outright
        // after MAX_FAILED_ATTEMPTS. Without this, every run re-opens the same
        // doomed forms, burning the per-run budget on jobs that cannot succeed.
        // How many times this job has failed before — read BEFORE this attempt is
        // recorded, so it means "prior history", not "including this one".
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

        // The cheapest screen of all: the title is already in hand, and a posting
        // for a different stack, discipline, or level is not worth reading the
        // description of, let alone opening a form for.
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

        // Both checks below read the job description, which costs a page wait per
        // job. The two log-only checks above are free, so they run first — that
        // skips the JD read entirely for the hundreds of already-applied and parked
        // jobs a search re-surfaces on every run, and reports the true reason for
        // the skip instead of whichever JD rule happened to match.
        // Read the description once and reuse it — it drives both the shift check
        // and the experience-fit screen below.
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

        // The daily budget is small on purpose, so each application is worth
        // something. A posting that states a minimum well above the candidate's
        // experience is a rejection at the first human filter — the slot is better
        // spent on a job that can actually land.
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
            applied++; // counts toward the walk's budget so the dry run terminates
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

        // Some "Apply" buttons on Easy Apply-filtered searches still redirect off
        // LinkedIn (the listing is cross-posted). Filling a form we don't control
        // isn't safe to automate, so only proceed when the button is genuinely
        // Easy Apply.
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

        // The throttle interstitial replaces the application modal, so it must be
        // caught here too — otherwise every job in the run is logged as a bogus
        // "form never appeared" failure and burns its retry budget.
        await assertNotThrottled(page);

        // LinkedIn occasionally shows a "You've already applied" confirmation
        // dialog instead of the application modal (job applied to elsewhere /
        // before this log existed). Treat it as already-applied, not a failure.
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

        // closeModal now reports whether it succeeded, and a modal left open means
        // every remaining job in the run opens on top of a stale form. A reload
        // clears it; carrying on regardless is what turns one stuck application
        // into a run of them.
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
          // No LinkedIn bookmark. The failure is captured with the reason, the
          // exact questions that went unanswered, and the fields the form
          // rejected, so needs-review.md can tell you what to fix.
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
          // A streak is meant to catch something systemic — a markup change, a
          // half-dead session. Failures on jobs that already failed before are
          // expected and say nothing about the run's health, so only failures on
          // jobs never tried before count toward the streak.
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

// Closes the Easy Apply modal and CONFIRMS it actually went.
//
// The previous version could not fall back: every await inside its `try` ended in
// `.catch(() => {})`, so nothing could ever throw, so the catch block holding the
// Escape-key and DOM-removal fallbacks was unreachable. It also never checked the
// result — and a modal left open means the next job opens on top of a stale form,
// which is how one stuck application turns into a run of them.
async function modalPresent(page) {
  return Boolean(await page.$(MODAL_SELECTOR).catch(() => null));
}

async function closeModal(page) {
  const clickIfPresent = async (selector) => {
    await page.click(selector, { force: true, timeout: 3000 }).catch(() => {});
  };

  // 1. The ordinary path: dismiss, then confirm the discard prompt.
  await clickIfPresent('button[aria-label="Dismiss"]');
  await delay(400);
  await clickIfPresent('button[data-control-name="discard_application_confirm_btn"]');
  await delay(400);
  await clickIfPresent('button:has-text("Discard")');
  await delay(300);
  if (!(await modalPresent(page))) return true;

  // 2. Escape, which handles the overlay variants the buttons above miss.
  await page.keyboard.press('Escape').catch(() => {});
  await delay(400);
  await clickIfPresent('button:has-text("Discard")');
  await delay(300);
  if (!(await modalPresent(page))) return true;

  // 3. Last resort: take it out of the DOM. Crude, but a stale modal blocks every
  // remaining job in the run, and this is recoverable where that is not.
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
  // Build a compact fingerprint of the visible form state so we can detect when
  // a "Next"/"Submit" click failed to change anything (the loop is now stuck).
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

// A failure is either deterministic (the bot has no answer for a question, or
// LinkedIn rejected the value it typed) or transient (a stuck modal, a timeout,
// a DOM race). Deterministic failures reproduce exactly, so retrying them just
// wastes time and looks more like automation; transient ones very often clear on
// a second, freshly-opened form. Only the latter get a retry.
const TRANSIENT_RETRY_LIMIT = 1;

// Returns 'opened' | 'already_applied' | 'unavailable'.
// The already-applied case matters most on a retry after `unconfirmed_submit`:
// if that first submit actually landed, reopening the form would apply twice.
// LinkedIn tells us so here, and that is treated as success, not as a new attempt.
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
        // The first attempt did go through after all — LinkedIn just never showed
        // the confirmation. Count it as applied instead of submitting a duplicate.
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
  // Everything the bot could not answer on this form, collected as it goes.
  // A single unanswered optional question is harmless, so it is not an instant
  // failure — but if the form later refuses to advance, this list is exactly
  // what the user needs to see to fix it.
  const unanswered = [];
  const note = (kind, question, options) => {
    const text = String(question || '').trim();
    if (!text) return;
    if (unanswered.some((u) => u.question === text)) return;
    unanswered.push({ kind, question: text, ...(options?.length ? { options } : {}) });
  };
  // Every answer actually submitted, so the log can show what was claimed under
  // the candidate's name. This is the counterpart to `unanswered`: one records
  // what the bot would not say, the other exactly what it did.
  const answered = [];
  const record = (kind, question, answer) => {
    const text = String(question || '').trim();
    const value = String(answer ?? '').trim();
    if (!text || !value) return;
    if (answered.some((a) => a.question === text)) return;
    answered.push({ kind, question: text.slice(0, 200), answer: value.slice(0, 200) });
  };
  // "The bot had no answer" and "the bot had an answer the field refused" are
  // different problems with different fixes — the first needs a fact added to
  // config.js, the second needs a format corrected. Collapsing them into one list
  // made every rejected value report as `unanswerable`, which sends the reader
  // looking for a missing answer that is already there.
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
  // When the form stalls and there are unanswered questions, the stall is almost
  // always caused by them — report the actionable cause, not the symptom.
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
          // Recorded like any other answer: it is submitted under the candidate's
          // name, so it belongs in the trail. The generic text loop below skips
          // this field precisely because it now has a value.
          record('phone', 'Phone number', config.phone);
        }
      }

      // A phone country-code dropdown ships as its own <select>, separate from the
      // number field. Left unset it silently defaults to whatever LinkedIn guesses,
      // which can mismatch config.phone's country. Filled here (rather than in the
      // generic <select> loop below) because its label text is often just "Phone
      // country code" with no useful option list to match against otherwise.
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
          // Only a required field can actually block the form, so an unanswered
          // optional one is not worth putting in front of the user.
          if (required) note(inputType === 'number' ? 'number' : 'text', label);
          continue;
        }

        const filled = await smartFill(input, answer, label);
        if (filled) {
          console.log(`  Filled [${inputType}] "${label}" → "${filled}"`);
          // A typeahead replaces the typed text with the suggestion that was
          // clicked ("Mumbai" → "Mumbai, Maharashtra, India"), so the trail should
          // show what the form actually received.
          const resolved = hasCombobox ? await resolveTypeahead(modal, input, filled) : '';
          record(inputType, label, resolved || filled);
        } else if (required) {
          // An answer existed but no variant of it survived the field's own
          // validation (integer-only box, rejected format, ...). Deliberately NOT
          // recorded as unanswered — the fix is a format, not a missing fact.
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
          // The answer matches no option. Defaulting to the first is a coin flip
          // presented as a fact — acceptable for a harmless dropdown, not for an
          // eligibility or skill question.
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

        // Prefer the specific per-choice label class. Falling back to a generic
        // `label` selector (as before) could also match the question's own
        // label/legend if it happens to be a <label> element, injecting the
        // question text itself as a bogus radio "option".
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

      // Multi-select checkbox groups (e.g. "Which of these do you have experience
      // with?" with several checkboxes under one question) — distinct from a lone
      // required consent checkbox, which is handled separately below.
      const checkboxContainers = await modal.$$('[data-test-form-element]');
      for (const container of checkboxContainers) {
        const boxes = await container.$$('input[type="checkbox"]');
        if (boxes.length < 2) continue; // single required checkbox handled below

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

        // mapFieldToAnswer resolves through resume-profile skill matching etc. For
        // a checkbox group we want every option that resolves truthy checked, not
        // just one — so evaluate each option individually as its own yes/no item.
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

        // A required checkbox group can't be left fully empty — but "which of these
        // do you have experience with?" is the commonest shape of one, and ticking
        // the first box to satisfy it invents a skill. Report those instead.
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
        // Re-query the button fresh (DOM may have re-rendered during filling).
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

      // No Next/Submit and no Dismiss → nothing to click. If we've already filled
      // everything and the form didn't advance twice, stop spinning and bail out.
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

  // A closed modal used to count as success on its own. It isn't: LinkedIn also
  // closes the modal when a step is rejected, and a false "applied" record is
  // permanent — alreadyApplied() then blocks the job from ever being retried.
  // Require corroboration from the top-card button, which flips to "Applied".
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

  // Unconfirmed. That is not a lost application: the caller reports
  // `unconfirmed_submit`, and the retry detects LinkedIn's already-applied state
  // and records the success then — without submitting twice.
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
    // Native HTML5 validity covers plain inputs/selects, but LinkedIn's typeahead
    // comboboxes and custom widgets don't use real form validation — they flag
    // themselves with aria-invalid instead, so :invalid alone misses them and lets
    // "Next" get clicked on a field that will bounce the form silently.
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

// Some steps ask for a resume upload (and occasionally a separate cover-letter
// file) via a plain <input type="file">, distinct from LinkedIn's own "choose a
// previously uploaded resume" card picker. Left untouched this silently blocks
// "Next"/"Submit" with no validation message the :invalid selector can see.
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
      // A file input with an accept list that excludes our resume's extension
      // (e.g. an image-only upload) isn't the resume field — skip it rather than
      // uploading a file the widget will reject.
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

// After typing into a combobox/typeahead field (city, school, skill autocomplete),
// LinkedIn shows a suggestion listbox that must be clicked — the raw typed text
// often fails validation on its own even though it visually matches an option.
async function resolveTypeahead(modal, input, typedValue) {
  const listbox = modal.locator(
    '[role="listbox"] [role="option"], .basic-typeahead__triggered-content li'
  );

  // Poll for the suggestions rather than reading the count once. LinkedIn renders
  // them a moment after the keystrokes land, so a single immediate check usually
  // saw zero options and gave up — leaving the raw typed text in a field that
  // rejects anything not picked from the list. (The README claimed this waited;
  // it did not.)
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
      // Either direction: "Mumbai" appears inside "Mumbai, Maharashtra, India",
      // and "Mumbai" is itself inside a typed "Mumbai (All Areas)".
      if (text.includes(needle) || needle.includes(text)) {
        target = listbox.nth(i);
        break;
      }
    }
  }

  // No suggestion resembles what we typed. Clicking the first one anyway would
  // submit a value nobody chose — a different city, a different school. Leave the
  // field alone; it will be reported as invalid, with the label, rather than
  // quietly answered wrong.
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

  // isNumericQuestion matches on the LABEL, so a plain text box labelled "Notice
  // period" or "Availability" was treated as numeric — and a perfectly good word
  // answer ("Immediate") produced no digits, so the field was left blank. Only
  // force the numeric path when the element really is a number input, or when the
  // answer is itself a number that may need unit conversion.
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

  // Deterministic facts from config.js (salary, notice period, experience, contact
  // details, etc.) — single source of truth, shared with answer-utils.deterministicAnswer
  // so this never drifts from the logic used elsewhere (e.g. resume-answers.js).
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
  fillLinkedInForm, // exported for tests: the failure classification is the core
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
  noteCompanyApplication,
  resetRunState,
};
