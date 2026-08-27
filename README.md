# LinkedIn Job Application Bot

Automates LinkedIn Easy Apply forms with Playwright. Candidate facts come from `config.js` and
the candidate's CV — there is no external AI provider, no API key, and no network call involved
in answering questions.

## Answer Flow

Every answer is resolved locally, in this order. The first strategy that produces an
answer wins.

1. **`config.customAnswers`** — anything you have answered by hand. Always wins.
2. **Answer-integrity guardrails** (`question-policy.js`) — see below.
3. **Deterministic facts** from `config.js`: salary, expected hike, notice period,
   availability, contact details, location, relocation, shift preference.
4. **Facts from the CV** via `resume-profile.js` — skills, certifications, degree level,
   employers.
5. **Open-ended prompts** (cover letter, "tell us about yourself") built from the resume
   summary.
6. **A conservative heuristic** for generic yes/no and consent phrasing — and only for
   those, never for a claim about you.

Numeric answers are validated before typing. HTML number fields without a `step`
attribute are treated as integer-only, because browsers default them to `step=1`.
Options phrased in words are understood too — "Immediate" is matched as zero for a
notice-period question, and "More than 4 years" as an open range rather than the
point 4.

`config.salaryUnit` controls what goes into a salary field whose label gives no unit:
`'auto'` (rupees, then the LPA figure), `'lpa'`, or `'rupees'`. An explicit "LPA" or
"INR" in the label always wins over the setting.

Where a decimal has to become a whole number, the direction is chosen rather than
left to `Math.round`: **claims about you round down** (1.7 years of tenure is entered
as 1, not 2), **current salary rounds down** (a figure companies verify against
payslips), and **expected salary rounds up** (an ask, not a claim). Where the exact
rupee figure fits, no rounding happens at all.

## Answer Integrity

These applications go out under your name, so the bot will not trade a true answer for
a completed form. `question-policy.js` classifies every question and decides what may
be guessed:

| Question type | Behaviour |
| --- | --- |
| Protected characteristics (gender, race, disability, veteran status, religion, age) | Picks the form's own "prefer not to say" option. If there isn't one, answers nothing. |
| Work authorization | Answered per country. `Authorized to work in the US?` → **No**, because `authorization.authorizedCountries` lists only India. |
| Visa sponsorship | The mirror image. `Require sponsorship in the US?` → **Yes**. |
| Criminal / legal history | Answered from fact only. Never guessed. |
| Skill and experience claims | Answered from the CV. A technology you don't list gets an honest **No**; a vague one ("experience in fast-paced environments") is left for you. |
| Certifications | A credential your CV doesn't contain is never claimed. |
| Degree level | Compared against `education.degreeLevel`. A bachelor's answers **No** to "do you have a Master's?". |
| Relocation | Answered from `locations` in `config.js`. A city you only accept remotely gets **No**; an unnamed city is left for you rather than answered "Yes". |
| Night / rotational shifts | Follows `dayShiftOnly`. Previously answered "Yes" regardless. |
| Years of experience in a named technology | Uses `skillExperienceYears`. A technology absent from your CV honestly answers **0**; one that's on the CV without a year count is left for you (or set `skillExperienceFallbackYears` to make the claim yourself). It never borrows your total-experience figure, and never answers a "how many years" question with "Yes". |
| Tenure at your current employer | Computed from the `period` on your latest entry in `resume-profile.js`. "How long have you been at your current company?" used to answer with your whole career. |
| Consent / acknowledgement boilerplate | Ticked, as before. |

Anything the bot refuses to guess becomes an `unanswerable` failure naming the exact
question — which is what `needs-review.md` is for. Answer it once in `customAnswers`
and every future posting asking the same thing is handled:

```js
customAnswers: [
  { match: 'willing to work night shifts', answer: 'No' },
  { match: /years.*experience.*python/i, answer: '2' },
],
```

`match` is a case-insensitive substring or a RegExp. These are checked before every
other rule, so they override the guardrails too — including the protected-characteristic
ones, if you want those filled in.

## Cover Letter

Built from `resume-profile.js`'s summary — no model involved. `config.coverLetter`
controls what it volunteers:

```js
coverLetter: {
  includeSalary: false,   // default: don't name a number in prose
  includeNotice: true,
},
```

Salary is off by default. Naming a figure unprompted, in free text, to every company
anchors the negotiation before anyone has spoken to you — and the form's own salary
fields are filled either way, so nothing is lost by leaving it out of the letter.

## Preflight and Audit

Three commands that need no browser and spend no applications.

```powershell
npm run preflight        # validate config.js before anything opens
npm run audit            # what would the bot answer, given your current config?
npm run audit -- --log   # what has it actually said under your name?
node answers-audit.js "Are you willing to work weekends?" "Yes,No"
```

`npm run preflight` also runs automatically at the start of every run, and a hard
error stops it before a single application is spent. It catches a missing resume
(upload fields would be skipped in silence), a `customAnswers` entry that can never
match, a skill claiming more years than your total career, an `expectedCTC` below
your current one, and pacing settings fast enough to look automated.

Two commands that need no browser and spend no applications.

```powershell
npm run audit            # what would the bot answer, given your current config?
npm run audit -- --log   # what has it actually said under your name?
node answers-audit.js "Are you willing to work weekends?" "Yes,No"
```

`npm run audit` replays a corpus of ~50 real Easy Apply questions and prints the
answer for each, including the unit conversion that happens at fill time (`4.7` →
`470000` for an unlabelled salary field). Anything it refuses to answer is listed
with the exact config key that would fix it. Run it after editing `config.js` or
`resume-profile.js` — it catches a wrong answer in a second, where a live run costs
an application to discover the same thing.

`--log` reads back every answer submitted on a successful application, grouped by
question, and flags any question you have answered inconsistently across companies —
for example the same "Expected CTC" answered `700000` at one company and `7` at
another, which is the `salaryUnit` ambiguity showing up in real data. The trail is
recorded from this version onward; earlier applications have none.

## Easy Apply Edge Cases Handled

- **Lazy-loaded results list**: LinkedIn only renders ~8-10 job cards in the DOM until the list
  is scrolled. The bot scrolls the results pane to load every card on the page before counting,
  and paginates to the next results page (`Page 2`, `Page 3`, …) once a page is exhausted, instead
  of silently stopping after the first screenful.
- **Resume upload fields**: some Easy Apply steps ask for a resume via a plain file input rather
  than LinkedIn's own resume picker. The bot uploads `config.resumePath` to any matching file
  input whose `accept` list isn't obviously incompatible.
- **Phone country-code dropdown**: filled from `config.phoneCountryCode` when the form asks for it
  as a separate field from the phone number.
- **Typeahead/combobox fields** (city, school, skill autocomplete): after typing, the bot waits for
  the suggestion listbox and clicks the best-matching option — required, because many of these
  fields reject the typed text unless a suggestion is explicitly selected.
- **Multi-select checkbox groups** (e.g. "which of these do you have experience with"): each option
  is evaluated independently against config/resume facts and checked when it matches, instead of
  only handling a single required consent checkbox.
- **External "Apply" buttons**: a button that isn't genuinely labeled "Easy Apply" (the listing
  redirects off LinkedIn) is skipped rather than automated blindly.
- **"Already applied" dialogs**: LinkedIn's own already-applied confirmation is recognized and
  logged as skipped instead of being treated as a form failure.
- **Session expiry mid-run**: if LinkedIn drops to a login/authwall/checkpoint page during a run
  (expired cookie, security check), the bot aborts the run cleanly with a clear message instead of
  failing every remaining job with a confusing error.
- **Custom (non-native) invalid fields**: in addition to HTML5 `:invalid`, fields flagged with
  `aria-invalid="true"` (typeahead/combobox widgets that don't use native validation) block
  "Next"/"Submit" until resolved.
- **Failure budgets**: a run's budget counts *successful* applications, so without a
  bound a run could grind for hours on failures and apply to nothing.
  `maxFailuresPerRun` (10) and `maxConsecutiveFailures` (5) stop it — a streak in
  particular usually means something systemic, like a markup change or a half-dead
  session, rather than bad luck on five separate postings.
- **Overlapping searches**: "FullStack Developer" and "Backend Developer" in Mumbai
  return many of the same postings. Each job is opened and screened once per run, not
  once per search term.
- **Per-company cap**: `maxApplicationsPerCompanyPerRun` (default 2). Five
  applications from one person to one company inside an hour reads as spray-and-pray.
  Company names are normalised first, so "Acme Pvt Ltd" and "Acme Private Limited"
  share a counter.
- **Experience-fit screen**: a posting that states a minimum well above your
  experience ("10+ years") is skipped before the form opens, because it's a rejection
  at the first human filter and the daily budget is small. It reads the *lowest*
  stated minimum, requires the figure to sit near the word "experience" (so "10+
  million users" is ignored), and applies `fit.experienceToleranceYears` on top. Set
  `fit.skipOverqualifiedPostings: false` to apply to everything.
- **Human-ish pacing**: the delay between applications is drawn from a skewed random range
  (`config.pacing`, 45-150s by default) with a longer break every few applications, instead of a
  fixed one-second gap. A perfectly regular cadence is the easiest automation signal there is.
- **Rate-limit interstitial**: if LinkedIn puts up its "we've briefly paused Easy Apply" notice,
  the run stops immediately instead of grinding through it — pushing past that notice is what
  escalates a temporary pause into an account restriction.

## Setup

```powershell
npm install
npx playwright install chromium
Copy-Item config.example.js config.js
Copy-Item resume-profile.example.js resume-profile.js
npm run preflight
```

Both `.example` files are **data only** — the logic they drive lives in
`resume-logic.js` and is shared, so a template can never fall behind the
implementation. (It once did: the template still claimed a Master's degree off the
back of a bachelor's, and still claimed certifications the CV did not contain, long
after both were fixed in the file people actually ran.)

Edit `config.js` with your candidate details. Fill `skillExperienceYears` when LinkedIn asks for
exact experience in Java, Node.js, React, or another technology — unknown skill-specific
experience is left unresolved instead of guessing from total experience. Set
`phoneCountryCode` (e.g. `'+91'`) and `country` for forms that ask for those as separate fields
from the phone number / city.

Put your resume PDF at the path in `config.resumePath`. For the best answers to open-ended and
skill questions, also save the extracted text next to it with a `.txt` extension (e.g.
`ManishCV_Backend.pdf` → `ManishCV_Backend.txt`) — `resume-profile.js` reads that file if present.
Update the `skills`, `certifications`, `education`, and `employers` lists in `resume-profile.js`
to match your CV.

`config.js`, `resume-profile.js`, your resume PDF/TXT, and session/application logs are all
gitignored because they contain personal information — only the `.example.js` templates and
generic source code are meant to be committed.

## Save LinkedIn Login

```powershell
node save-session.js
```

Log in in the browser, return to the terminal, and press Enter.

## Run

```powershell
npm test
node index.js                 # a normal run
node index.js --dry-run       # walk the whole pipeline, apply to nothing
node index.js --limit 3       # cap this run at 3 applications
node index.js --help
```

**`--dry-run` is the safe way to test.** It logs in, runs every search, pages through
results, reads each description, applies the shift and experience screens, and prints
which jobs it *would* have applied to — without opening a single application form or
writing anything to `applications.json`. Use it after changing `config.js`, and use it
to verify the pipeline while your account is in a cooldown, when a real run isn't an
option anyway. It ignores the daily and lifetime caps, since it spends neither.

It is still a logged-in session clicking through jobs, so browsing is paced too
(2–6s per job) and the walk stops after a handful of matches unless you pass
`--limit`. Clicking through a hundred postings in a minute would be a louder
automation signal than applying to five slowly.

`--limit` only ever tightens the configured caps — it cannot raise them. It's the
right way to make a cautious first run after a pause.

Press **Ctrl+C** to stop: the bot finishes the job in flight, closes the browser, and
still prints the summary and rewrites `needs-review.md`. A second Ctrl+C quits at once.

Each run ends with a **THIS RUN** box — applied, failed, skipped, the failure codes
that came up, and the three questions that blocked the most applications — followed
by the all-time summary.

Other commands:

```powershell
npm run review        # rebuild needs-review.md without running the bot
npm run compact-log   # collapse duplicate skip rows in applications.json (keeps a backup)
```

The bot opens a real browser. Do not interact with it while an application is being processed.
Application history is stored in `applications.json`.

## When an Application Fails

A failed Easy Apply is **not** bookmarked on LinkedIn. Instead the bot records *why* it failed and
what it would need to succeed, and hands you a prioritized to-do list.

### Failure codes

| Code | Meaning | Retried? |
| --- | --- | --- |
| `unanswerable` | A question had no answer in `config.js` / `resume-profile.js` | No — re-running changes nothing |
| `invalid_field` | The bot had an answer, but the field refused every variant of it | No — the value needs fixing |
| `stuck_form` | The form stopped advancing past a step | Yes |
| `no_action` | No "Next"/"Submit" ever appeared | Yes |
| `modal_missing` | The application modal vanished mid-fill | Yes |
| `unconfirmed_submit` | Submit was clicked, no confirmation followed | Yes |
| `timeout` | The job exceeded the per-job wall-clock guard | Yes |
| `error` | An unexpected exception | Yes |

### What happens on failure

1. **One automatic retry**, but only for transient codes. A deterministic failure reproduces
   exactly, so retrying it just wastes time and adds automation signal.
2. **A diagnostic log entry** in `applications.json` — the code, a one-line reason, the exact text
   of every question that went unanswered (with the options the form offered), and any validation
   messages the form produced.
3. **Smart backoff on later runs.** A job whose last failure was deterministic is parked until
   `config.js` or `resume-profile.js` actually changes — tracked with a fingerprint of those files,
   so simply re-running the bot does not re-open a form that cannot succeed. After 3 failures a
   job is set aside, and gets one more chance after 14 days: LinkedIn changes its markup and this
   bot gets fixed, so a job written off during a bad week should not be lost forever.
4. **An answer trail** on every successful application: the question and the value
   submitted, stored in `applications.json` and readable with `npm run audit -- --log`.
5. **`needs-review.md`**, regenerated at the end of every run: the questions that blocked the most
   applications, ranked, each with a pointer to the config key that would answer it — plus the
   values the form rejected and the full list of open jobs with links.

Answering the top one or two rows in `needs-review.md` typically unblocks the whole backlog on the
next run, since the same questions repeat across postings.

## Staying Under LinkedIn's Radar

LinkedIn actively detects and pauses fast, regular application activity, and the terms of service
prohibit automated tools — an account that keeps tripping the safeguard can be restricted. This
project can only reduce the volume signal; it makes no attempt to disguise itself as a human, and
you use it at your own risk.

The levers, in order of how much they matter:

- `config.maxApplications.linkedin.perDay` (default 15) and `perRun` (default 8) — the total volume.
- `config.pacing` — the gaps between applications and the periodic longer breaks.
- `config.speed` — `'slow'` or `'medium'` slows the interaction inside each form as well.

If you see the "applying at a fast pace" notice, the bot halts on its own — and then
**holds off the next run too**, for `cooldownHoursAfterThrottle` (24h by default). The
run *after* a pause is the dangerous one: going straight back into a safeguard is what
turns a temporary pause into a lasting restriction, and by then the process that saw
the notice is long gone. The hold is recorded in `.bot-state.json` so it survives.

During a hold:

```powershell
node index.js --dry-run          # allowed — applies to nothing
node index.js --ignore-cooldown  # override, deliberately
```

Lower `perDay` and raise the `pacing` values before you resume.

## How It Fits Together

| File | Responsibility |
| --- | --- |
| `index.js` | Entry point: preflight, platform dispatch, summaries |
| `cli.js` | `--dry-run`, `--limit`, `--help` |
| `preflight.js` | Config validation before a browser opens |
| `linkedin.js` | Browser driving: search, pagination, screening, form filling |
| `job-fit.js` | Reads the stated minimum experience out of a job description |
| `question-policy.js` | **Answer integrity** — what may and may not be guessed |
| `answer-utils.js` | Deterministic answers from `config.js`; option matching |
| `resume-profile.js` | Your CV as data — 50 lines, no logic |
| `resume-profile.example.js` | The same shape, as a template |
| `resume-logic.js` | The answering logic both profiles share |
| `resume-answers.js` | Orders the answer strategies; builds the cover letter |
| `salary-helper.js` | CTC parsing and formatting |
| `location-helper.js` | Expands `locations` into search pairs |
| `field-value.js` | Numeric candidates: unit conversion, integer coercion, bounds |
| `logger.js` | `applications.json`, backoff, run and all-time summaries |
| `failure-report.js` | Builds `needs-review.md` |
| `answers-audit.js` | Offline answer preview and submitted-answer audit |
| `shutdown.js` | Cooperative Ctrl+C |
| `cooldown.js` | Post-rate-limit hold that survives the process |
| `test/helpers/fake-page.js` | Fake Playwright surface, so the form filler is testable |
| `compact-log.js` | One-off maintenance for `applications.json` |

The dependency direction is one-way: `question-policy.js` depends only on `config.js`,
and everything that answers a question depends on it. That is deliberate — there is
exactly one place that decides whether a claim may be made on your behalf.

**`applications.json` is deliberately read fresh every time, with no cache.** A
stat-based cache (mtime + size) was tried and removed: two writes in the same
millisecond that produce the same file length are indistinguishable by `stat`, so
reads came back stale — and a stale read here means re-applying to a job you already
applied to. A read-and-parse costs about 12ms on a 310KB log, perhaps a second across
a whole run, inside a run that waits 45-150 seconds between applications. There is a
test that hammers the exact failure mode; please don't reintroduce the cache.

## Tests

```powershell
npm test
```

No browser required. The suite covers the answer-integrity rules (including the
specific false claims this bot used to make and must never make again), numeric and
worded option matching, the failure and backoff logic, config validation, job-fit
parsing, per-company capping, and CLI parsing.

`test/helpers/fake-page.js` is a small stand-in for the slice of Playwright that
`fillLinkedInForm` actually touches, so the form filler itself is tested: a form is
described as a list of steps and fields, and the tests assert what gets submitted,
what gets refused, and which failure code comes out. That is what makes the review
report trustworthy — "this form produces an `unanswerable` failure naming this exact
question" is verified, not asserted in a comment.

Most of these tests exist because the behaviour they pin down was once wrong. When
you change an answering rule, the test that breaks will tell you which real mistake
you just reintroduced.

`test/invariants.test.js` is different: it generates hundreds of phrasings from
templates and asserts the rules that must hold across all of them, because the next
false claim will arrive in wording nobody wrote a case for.

- No technology absent from the CV is ever claimed — and none that IS on it is denied
- No protected-characteristic question is ever answered with anything but a decline
- Authorization is never claimed abroad; sponsorship is never denied abroad
- No quantity question ever receives a yes/no
- No claimed year count exceeds total experience
- No credential or degree above the one held is ever claimed
- Consent boilerplate still gets answered, or forms would never submit
