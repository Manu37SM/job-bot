const { chromium } = require('playwright');
const config = require('./config');
const { answerQuestion, generateCoverLetter } = require('./resume-answers');
const {
  alreadyApplied,
  recordApplication,
  totalAppliedCount,
  appliedTodayCount,
  shouldSkipJob,
  isTransient,
  describeCode,
} = require('./logger');
const { getLocationSearchPairs } = require('./location-helper');
const { deterministicAnswer, isNumericQuestion } = require('./answer-utils');
const { buildNumericCandidates } = require('./field-value');

const DELAYS = { slow: 3000, medium: 1500, fast: 500 };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = () => delay(DELAYS[config.speed] || 2000);

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

async function runLinkedIn() {
  console.log('\n🔵 STARTING LINKEDIN BOT...\n');

  const perRun = config.maxApplications.linkedin.perRun;
  const lifetime = config.maxApplications.linkedin.lifetime;
  // A daily ceiling on top of the per-run one. Without it, several runs in an
  // afternoon add up to a volume no human produces — which is what LinkedIn's
  // "applying at a fast pace" safeguard is measuring.
  const perDay = config.maxApplications.linkedin.perDay ?? 15;
  const alreadyDone = totalAppliedCount('linkedin');
  const doneToday = appliedTodayCount('linkedin');
  const canApply = Math.min(perRun, perDay - doneToday, lifetime - alreadyDone);

  console.log(
    `📊 LinkedIn: ${alreadyDone}/${lifetime} lifetime | ${doneToday}/${perDay} today | applying up to ${Math.max(0, canApply)} this run`
  );
  if (lifetime - alreadyDone <= 0) {
    console.log('⛔ LinkedIn lifetime limit already reached. Skipping.');
    return;
  }
  if (canApply <= 0) {
    console.log(`⛔ Daily limit reached (${doneToday}/${perDay}). Come back tomorrow.`);
    return;
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

    let appliedThisRun = 0;
    const locationPairs = getLocationSearchPairs();

    for (const position of config.positions) {
      if (appliedThisRun >= canApply) break;

      for (const { location, workModes } of locationPairs) {
        if (appliedThisRun >= canApply) break;

        console.log(`\n🔍 Searching: "${position}" in "${location}" [${workModes.join(',')}]`);
        const count = await searchAndApply(
          page,
          position,
          location,
          workModes,
          canApply - appliedThisRun
        );
        appliedThisRun += count;
      }
    }

    console.log(
      `\n✅ LinkedIn Done! Applied ${appliedThisRun} this run. Total: ${alreadyDone + appliedThisRun}/${lifetime}`
    );
  } catch (err) {
    if (err instanceof ThrottleError) {
      console.error('\n🛑 LinkedIn has rate-limited this account.');
      console.error(`   "${err.message}"`);
      console.error('   Stopping the run now rather than pushing through it —');
      console.error('   continuing is what turns a temporary pause into a restriction.');
      console.error(
        '   Wait at least 24h, then lower perRun / raise the pacing values in config.js.'
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

const THROTTLE_PATTERNS = [
  /paused easy apply/i,
  /applying at a (?:fast|rapid) pace/i,
  /we've briefly paused/i,
  /automated inauthentic/i,
  /you've reached the (?:daily|weekly|monthly) (?:application|apply) limit/i,
  /try again (?:later|tomorrow|in a )/i,
  /unusual activity/i,
];

// Checked against the visible page rather than the whole DOM, so a hidden
// template or an unrelated help-centre link can't produce a false positive that
// aborts a healthy run.
function throttleMessageIn(text) {
  const body = String(text || '');
  if (!body) return '';
  const hit = THROTTLE_PATTERNS.find((pattern) => pattern.test(body));
  if (!hit) return '';
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => hit.test(l));
  return line || 'LinkedIn has temporarily paused Easy Apply for this account';
}

async function detectThrottle(page) {
  const text = await page
    .evaluate(() => (document.body?.innerText || '').slice(0, 20000))
    .catch(() => '');
  return throttleMessageIn(text);
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
async function loadAllJobCards(page, maxJobs) {
  const listSelector = '.jobs-search-results-list, .scaffold-layout__list';
  let stableRounds = 0;
  let lastCount = -1;

  for (let round = 0; round < 40; round++) {
    const count = await page.locator('.job-card-container').count();
    if (count >= maxJobs || count === lastCount) {
      stableRounds++;
    } else {
      stableRounds = 0;
    }
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

  return page.locator('.job-card-container').count();
}

// Clicks LinkedIn's results pagination to the given page number. Returns false
// once there's no such page (end of results) so the caller can move on to the
// next search instead of looping forever.
async function goToResultsPage(page, pageNumber) {
  const nextBtn = page.locator(`button[aria-label="Page ${pageNumber}"]`).first();
  const visible = await nextBtn.isVisible().catch(() => false);
  if (!visible) return false;

  await nextBtn.click({ timeout: 10000 }).catch(() => {});
  await page.waitForSelector('.job-card-container', { timeout: 10000 }).catch(() => {});
  await wait();
  return true;
}

async function searchAndApply(page, position, location, workModes, maxJobs) {
  const workModeMap = { onsite: '1', remote: '2', hybrid: '3' };
  const workModeParam = (workModes || [])
    .map((m) => workModeMap[m.toLowerCase()])
    .filter(Boolean)
    .join(',');

  const jobTypeMap = { permanent: 'F', contract: 'C', internship: 'I' };
  const jobTypeParam = (config.jobTypes || [])
    .map((t) => jobTypeMap[t.toLowerCase()])
    .filter(Boolean)
    .join(',');

  let searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(position)}&location=${encodeURIComponent(location)}&f_LF=f_AL&f_E=2,3,4`;
  if (workModeParam) searchUrl += `&f_WT=${workModeParam}`;
  if (jobTypeParam) searchUrl += `&f_JT=${jobTypeParam}`;

  console.log(
    `  🔗 Mode: [${workModes.join(',')}] | Type: [${config.jobTypes}] | Day Shift: ${config.dayShiftOnly} (JD scan)`
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

    const totalJobs = await loadAllJobCards(page, maxJobs - applied);
    console.log(`📋 Page ${resultsPage}: found ${totalJobs} job cards`);

    for (let i = 0; i < totalJobs; i++) {
      if (applied >= maxJobs) break;

      try {
        await assertSessionAlive(page);

        const card = page.locator('.job-card-container').nth(i);

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

        const jobTitle = await waitEval(
          page,
          '.job-details-jobs-unified-top-card__job-title',
          (el) => el.innerText,
          'Unknown Role'
        );
        const company = await waitEval(
          page,
          '.job-details-jobs-unified-top-card__company-name',
          (el) => el.innerText,
          'Unknown Company'
        );
        const jobLink = page.url();
        const jobId = getLinkedInJobId(jobLink);

        console.log(`\n👀 Checking: ${jobTitle} @ ${company}`);

        if (config.dayShiftOnly) {
          const jdText = await waitEval(
            page,
            '.jobs-description__content, .job-view-layout',
            (el) => el.innerText.toLowerCase(),
            ''
          );

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
        }

        if (alreadyApplied(jobId)) {
          console.log('⏭️  Already applied, skipping...');
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
        const backoffReason = shouldSkipJob(jobId);
        if (backoffReason) {
          console.log(`⏭️  Skipping — ${backoffReason}`);
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

        const easyApplyBtn =
          (await page.$('[data-control-name="jobdetails_topcard_inapply"]')) ||
          (await page.$('.jobs-apply-button'));

        if (!easyApplyBtn) {
          console.log('⏭️  No Easy Apply button, skipping...');
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

        if (result.ok) {
          recordApplication({
            jobId,
            title: jobTitle,
            company,
            platform: 'LinkedIn',
            status: 'applied',
            link: jobLink,
          });
          applied++;
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
            blockers: result.blockers,
            attempts: result.attempts,
          });
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

    if (applied >= maxJobs) break;
    const wentToNextPage = await goToResultsPage(page, resultsPage + 1);
    if (!wentToNextPage) {
      console.log('  📄 No further result pages for this search.');
      break;
    }
  }

  return applied;
}

async function closeModal(page) {
  try {
    await page.click('button[aria-label="Dismiss"]', { force: true }).catch(() => {});
    await delay(500);

    await page
      .click('button[data-control-name="discard_application_confirm_btn"]', { force: true })
      .catch(() => {});
    await delay(500);
    await page.click('button:has-text("Discard")', { force: true }).catch(() => {});
    return;
  } catch (e) {
    try {
      await page.keyboard.press('Escape');
      await delay(500);
    } catch (e2) {}

    try {
      await page.evaluate(() => {
        document.querySelector('[data-test-modal-id="easy-apply-modal"]')?.remove();
      });
    } catch (e3) {}
  }
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

async function openEasyApplyModal(page) {
  const btn =
    (await page.$('[data-control-name="jobdetails_topcard_inapply"]')) ||
    (await page.$('.jobs-apply-button'));
  if (!btn) return false;
  await btn.click().catch(() => {});
  await wait();
  return Boolean(await page.$('[data-test-modal-id="easy-apply-modal"]'));
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
      if (!(await openEasyApplyModal(page))) {
        result = {
          ok: false,
          code: 'modal_missing',
          reason: 'Easy Apply form would not reopen for a retry',
          unanswered: result?.unanswered || [],
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
  const fail = (code, reason, blockers = []) => ({ ok: false, code, reason, unanswered, blockers });
  // When the form stalls and there are unanswered questions, the stall is almost
  // always caused by them — report the actionable cause, not the symptom.
  const stall = (code, reason) =>
    unanswered.length
      ? fail(
          'unanswerable',
          `No answer for: ${unanswered
            .map((u) => u.question)
            .slice(0, 3)
            .join(' | ')}`
        )
      : fail(code, reason);

  try {
    let step = 0;
    const maxSteps = 12;
    let stuckCount = 0;

    while (step < maxSteps) {
      step++;
      await wait();

      const modal = await page.$('[data-test-modal-id="easy-apply-modal"]');
      if (!modal) {
        return stall('modal_missing', 'Application form closed before it could be submitted');
      }

      await handleResumeUpload(modal);

      const phoneField = await modal.$('input[id*="phoneNumber"]');
      if (phoneField) {
        const val = await phoneField.inputValue();
        if (!val) await phoneField.fill(config.phone);
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
          if (hasCombobox) await resolveTypeahead(modal, input, filled);
        } else if (required) {
          // An answer existed but no variant of it survived the field's own
          // validation (integer-only box, rejected format, ...).
          note(`${inputType} (value "${answer}" rejected)`, label);
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
        } else {
          const answer = await answerQuestion(label, jobTitle, company, 'textarea', []);
          if (answer) {
            await ta.fill(answer);
            console.log(`  Filled [textarea] "${label}" → "${answer.slice(0, 60)}..."`);
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
        const matchedOption =
          options.find((o) => o.toLowerCase().includes(answer.toLowerCase())) || options[0];
        await select.selectOption({ label: matchedOption });
        console.log(`  Selected [dropdown] "${label}" → "${matchedOption}"`);
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
            clicked = true;
            break;
          }
        }

        if (!clicked && allOptionEls.length > 0) {
          const firstText = await allOptionEls[0].innerText().catch(() => '');
          await allOptionEls[0].click({ force: true }).catch(() => {});
          console.log(`  Selected [radio] "${questionLabel}" → "${firstText}" (fallback)`);
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
            }
          }
        }

        // A required checkbox group can't be left fully empty. If nothing matched,
        // fall back to the first option rather than stalling the form.
        if (!anySelected) {
          const isRequired = await container
            .$eval(
              'input[type="checkbox"]',
              (el) => el.required || el.closest('[required]') != null
            )
            .catch(() => false);
          if (isRequired && optionEls[0]) {
            await optionEls[0].click({ force: true }).catch(() => {});
            console.log(
              `  Checked [checkbox] "${questionLabel}" → "${optionLabels[0]}" (fallback)`
            );
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
          return fail(
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
          return fail(
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
        return { ok: true, unanswered, blockers: [] };
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
  const modalStillOpen = await page
    .locator('[data-test-modal-id="easy-apply-modal"]')
    .isVisible()
    .catch(() => false);
  return successText || !modalStillOpen;
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
  const count = await listbox.count().catch(() => 0);
  if (count === 0) return;

  const needle = String(typedValue || '')
    .trim()
    .toLowerCase();
  let target = listbox.first();
  if (needle) {
    for (let i = 0; i < count; i++) {
      const text = await listbox
        .nth(i)
        .innerText()
        .catch(() => '');
      if (text.trim().toLowerCase().includes(needle)) {
        target = listbox.nth(i);
        break;
      }
    }
  }

  await target.click({ force: true, timeout: 3000 }).catch(() => {});
  await delay(300);
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

  const numeric = isNumericQuestion(label, metadata.inputType);
  const candidates = numeric
    ? buildNumericCandidates(answer, label, metadata)
    : [String(answer || '').trim()].filter(Boolean);

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

module.exports = { getLinkedInJobId, runLinkedIn, throttleMessageIn, pacingConfig };
