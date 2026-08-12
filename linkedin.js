const { chromium } = require('playwright');
const config = require('./config');
const { answerQuestion, generateCoverLetter } = require('./resume-answers');
const { alreadyApplied, recordApplication, totalAppliedCount } = require('./logger');
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
  const alreadyDone = totalAppliedCount('linkedin');
  const canApply = Math.min(perRun, lifetime - alreadyDone);

  console.log(
    `📊 LinkedIn: ${alreadyDone}/${lifetime} lifetime | applying up to ${canApply} this run`
  );
  if (canApply <= 0) {
    console.log('⛔ LinkedIn lifetime limit already reached. Skipping.');
    return;
  }

  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const context = await browser.newContext({
    storageState: './session-linkedin.json',
  });
  const page = await context.newPage();

  // Fail fast instead of hanging for the default 30s+ per action when LinkedIn
  // is slow or a selector is stale. Each action retries at the call site.
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(60000);

  try {
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
    console.error('❌ LinkedIn bot error:', err.message);
  } finally {
    await browser.close();
  }
}

async function loginToLinkedIn(page) {
  console.log('🔐 Loading LinkedIn session...');

  const sessionFile = './session-linkedin.json';
  if (!require('fs').existsSync(sessionFile)) {
    console.log('⚠️  No saved session found!');
    console.log('   Run:  node save-session.js linkedin');
    console.log('   Then log in with Google in the browser window.');
    process.exit(1);
  }

  await page.goto('https://www.linkedin.com/feed', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await new Promise((r) => setTimeout(r, 3000));

  if (page.url().includes('login') || page.url().includes('authwall')) {
    console.log('⚠️  Session expired. Please run: node save-session.js linkedin');
    process.exit(1);
  }

  console.log('✅ LinkedIn session loaded!');
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

  let applied = 0;

  const totalJobs = await page.locator('.job-card-container').count();
  console.log(`📋 Found ${totalJobs} Easy Apply jobs`);

  for (let i = 0; i < totalJobs; i++) {
    if (applied >= maxJobs) break;

    try {
      const card = page.locator('.job-card-container').nth(i);

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

      await easyApplyBtn.click();
      await wait();

      let success = false;
      try {
        // Guard the whole form fill so one stuck application can't freeze the run.
        success = await withJobTimeout(
          fillLinkedInForm(page, jobTitle, company),
          `${jobTitle} @ ${company}`
        );
      } catch (formErr) {
        console.error(`  ⚠️  Unexpected error: ${formErr.message}`);
        console.log('  🔄 Closing modal and moving to next job...');
        success = false;
      } finally {
        await closeModal(page);
      }

      if (success) {
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
        await saveJob(page);
        recordApplication({
          jobId,
          title: jobTitle,
          company,
          platform: 'LinkedIn',
          status: 'failed',
          link: jobLink,
        });
        console.log('  💾 Job saved to LinkedIn → apply manually later');
        console.log('  ➡️  Moving to next job...');
      }

      await delay(config.pauseBetweenApps * 1000);
    } catch (err) {
      console.error(`  ⚠️  Error on this job: ${err.message}`);
      console.log('  🔄 Closing modal, saving job, moving to next...');
      await closeModal(page);
      await saveJob(page);
      await delay(2000);
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

async function saveJob(page) {
  try {
    const btnInfo = await page.evaluate(() => {
      const btn =
        document.querySelector('button[aria-label^="Save"]') ||
        document.querySelector('button.jobs-save-button') ||
        document.querySelector('button:has-text("Save")');
      if (!btn) return null;
      return { alreadySaved: btn.getAttribute('aria-label')?.toLowerCase().includes('unsave') };
    });

    if (!btnInfo || btnInfo.alreadySaved) return;

    await page
      .click('button[aria-label^="Save"], button.jobs-save-button', { force: true })
      .catch(() => {});
    await delay(500);
  } catch (e) {}
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

async function fillLinkedInForm(page, jobTitle, company) {
  try {
    let step = 0;
    const maxSteps = 12;
    let lastSignature = '';
    let stuckCount = 0;

    while (step < maxSteps) {
      step++;
      await wait();

      const modal = await page.$('[data-test-modal-id="easy-apply-modal"]');
      if (!modal) break;

      const phoneField = await modal.$('input[id*="phoneNumber"]');
      if (phoneField) {
        const val = await phoneField.inputValue();
        if (!val) await phoneField.fill(config.phone);
      }

      const textInputs = await modal.$$('input[type="text"], input[type="number"]');
      for (const input of textInputs) {
        const isVisible = await input.isVisible().catch(() => false);
        if (!isVisible) continue;
        const value = await input.inputValue();
        if (value) continue;

        const { label, inputType } = await input.evaluate((el) => ({
          label: (
            document.querySelector(`label[for="${el.id}"]`)?.innerText ||
            el.placeholder ||
            el.name ||
            ''
          ).trim(),
          inputType: el.type || 'text',
        }));

        const answer = await mapFieldToAnswer(label, jobTitle, company, inputType, []);
        if (!answer) continue;

        const filled = await smartFill(input, answer, label);
        if (filled) {
          console.log(`  Filled [${inputType}] "${label}" → "${filled}"`);
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

        const optionLabels = await container.$$eval(
          '[data-test-text-selectable-option__label], label',
          (els) => els.map((el) => el.innerText.trim()).filter((t) => t.length > 0)
        );

        const answer = await mapFieldToAnswer(
          questionLabel,
          jobTitle,
          company,
          'radio',
          optionLabels
        );
        if (!answer) {
          console.warn(`  No reliable radio answer for "${questionLabel}"`);
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
          return false;
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
            console.warn('  🔁 Form not advancing after repeated Next clicks — abandoning job.');
            return false;
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
          return false;
        }
        await submitBtn.click({ force: true });
        await wait();
        console.log('  🚀 Submitted!');

        await delay(2000);
        const confirmed = await confirmSubmission(page);
        if (!confirmed) {
          console.warn('  Submit was clicked, but LinkedIn did not confirm the application.');
          return false;
        }
        const dismissedPopup = await dismissPostSubmitPopup(page);
        if (dismissedPopup) {
          console.log('  ✅ Dismissed follow popup');
        }
        return true;
      }

      // No Next/Submit and no Dismiss → nothing to click. If we've already filled
      // everything and the form didn't advance twice, stop spinning and bail out.
      stuckCount++;
      if (stuckCount >= 2) {
        console.warn('  🔁 No actionable button and form is not advancing — abandoning job.');
        return false;
      }

      const dismissBtn = await modal.$('button[aria-label="Dismiss"]');
      if (dismissBtn) {
        await dismissBtn.click({ force: true });
        break;
      }

      break;
    }

    return false;
  } catch (err) {
    console.error('  Form fill error:', err.message);
    await closeModal(page);
    return false;
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
  return modal.$$eval('input:invalid, select:invalid, textarea:invalid', (elements) =>
    elements
      .filter((element) => element.offsetParent !== null)
      .map((element) => {
        const label =
          document.querySelector(`label[for="${element.id}"]`)?.innerText ||
          element.getAttribute('placeholder') ||
          element.getAttribute('name') ||
          'Unknown field';
        return `${label.trim()}: ${element.validationMessage || 'invalid value'}`;
      })
  );
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
  const l = label.toLowerCase();

  // LinkedIn profile URL fields are auto-filled by LinkedIn itself; don't guess a value.
  if (l.includes('linkedin') || l.includes('profile url')) return '';

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

module.exports = { getLinkedInJobId, runLinkedIn };
