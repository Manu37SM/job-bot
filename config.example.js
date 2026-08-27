require('dotenv').config({ quiet: true });

const config = {
  name: 'John Doe',
  email: 'john.doe@example.com',
  phone: '9876543210',
  phoneCountryCode: '+91', // used for LinkedIn's separate phone-country-code dropdown
  location: 'Mumbai',
  country: 'India',
  linkedinUrl: 'https://www.linkedin.com/in/johndoe',
  githubUrl: 'https://github.com/johndoe',

  currentCTC: {
    fixed: 5,
    variable: 1,
  },

  expectedCTC: {
    fixed: 8,
    variable: 0,
  },

  noticePeriod: '30 days',
  lastWorkingDay: '2026-07-01',
  positions: ['Software Engineer', 'Backend Developer', 'Node.js Developer'],

  locations: {
    preferredCities: ['Mumbai', 'Navi Mumbai', 'Thane'],
    preferredCityModes: ['onsite', 'hybrid', 'remote'],
    otherCities: ['Bangalore', 'Pune', 'Hyderabad'],
    otherCityModes: ['remote'],
  },

  experienceYears: 3.5,
  skillExperienceYears: {
    Java: 3,
    React: 2,
    'Node.js': 3,
  },
  jobTypes: ['permanent'],
  dayShiftOnly: true,
  maxApplications: {
    linkedin: { perRun: 8, perDay: 15, lifetime: 500 },
    naukri: { perRun: 20, lifetime: 500 },
    indeed: { perRun: 10, lifetime: 200 },
  },
  resumePath: './Resume.pdf',

  speed: 'fast', // or 'medium', 'slow'
  // Fallback answer for "Are you willing to relocate?" when no city is named.
  // Left unset, the bot declines to answer rather than committing you either way,
  // and the question shows up in needs-review.md. Set true or false to decide once.
  // willingToRelocate: false,

  // What the free-text cover letter mentions. Salary is off by default: naming a
  // number in prose, unprompted, anchors the negotiation before anyone has spoken
  // to you. The structured salary fields on the form are filled either way.
  coverLetter: {
    includeSalary: false,
    includeNotice: true,
  },

  // Most applications to any one company in a single run. Five applications from
  // one person to one company inside an hour reads as spray-and-pray, and the
  // later ones add little. 0 disables the cap.
  maxApplicationsPerCompanyPerRun: 2,

  // Years to claim for a technology that IS on your CV but has no entry in
  // skillExperienceYears above. Left unset, the bot declines to answer and the
  // question appears in needs-review.md — because only you know the number.
  // Setting it makes the claim yours, not the bot's. Capped at experienceYears.
  // skillExperienceFallbackYears: 2,

  // A run's budget counts successful applications, so without these a run could
  // grind for hours on failures and apply to nothing. A streak of failures usually
  // means something systemic rather than bad luck. 0 disables either limit.
  maxFailuresPerRun: 10,
  maxConsecutiveFailures: 5,

  // How long to refuse to run after LinkedIn rate-limits the account. The bot
  // stops the moment it sees the notice; this stops the NEXT run too, which is the
  // one that turns a temporary pause into a lasting restriction.
  cooldownHoursAfterThrottle: 24,

  // Skip postings that state a minimum experience well above yours — they are a
  // rejection at the first human filter, and the daily application budget is small.
  // Raise the tolerance to be less picky; set skipOverqualifiedPostings:false to
  // apply to everything regardless.
  fit: {
    skipOverqualifiedPostings: true,
    experienceToleranceYears: 2,
  },

  // How to fill a salary field whose label gives no unit ("Expected CTC" with no
  // "LPA" or "INR"). 'auto' tries rupees then the LPA figure; 'lpa' tries the LPA
  // figure first; 'rupees' only ever writes rupees. Getting this wrong is a
  // factor-of-100,000 error in a number recruiters read as fact.
  salaryUnit: 'auto',

  // Countries you can work in WITHOUT sponsorship. "Are you authorized to work in
  // the United States?" is answered No when the US isn't listed here, and the
  // matching sponsorship question is answered Yes — the honest pair. Add a country
  // here only if you genuinely hold the right to work there.
  authorization: {
    authorizedCountries: ['India'],
    // When a question names no country at all, assume it means the country you are
    // searching in. Set false if you apply across borders and want those flagged.
    assumeAuthorizedWhenCountryUnstated: true,
  },

  // Answers for questions the bot refuses to guess at — protected-characteristic,
  // eligibility, and skill-claim questions. `match` is a substring (case-insensitive)
  // or a RegExp; the first entry that matches wins, ahead of every other rule.
  // needs-review.md tells you exactly which entries to add here.
  customAnswers: [
    // { match: 'willing to work night shifts', answer: 'No' },
    // { match: /years.*experience.*python/i, answer: '2' },
  ],

  // Cadence between applications, in seconds. A real applicant reads the
  // posting, hesitates, and stops for a while every so often — a fixed 1-2s gap
  // is the clearest automation signal there is, and what LinkedIn's "applying at
  // a fast pace" safeguard reacts to. Raise these if you get paused again.
  pacing: {
    minSecondsBetweenApps: 45,
    maxSecondsBetweenApps: 150,
    longBreakEvery: 6,
    longBreakMinSeconds: 240,
    longBreakMaxSeconds: 600,
  },
};

module.exports = config;
