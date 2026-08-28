require('dotenv').config({ quiet: true });

const config = {
  name: 'John Doe',
  email: 'john.doe@example.com',
  phone: '9876543210',
  phoneCountryCode: '+91',
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
  positions: [
    'FullStack Developer',
    'Full Stack Engineer',
    'Backend Developer',
    'Backend Engineer',
    'Software Engineer',
  ],

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

  speed: 'fast',

  coverLetter: {
    includeSalary: false,
    includeNotice: true,
  },

  maxApplicationsPerCompanyTotal: 5,

  maxApplicationsPerCompanyPerRun: 2,

  search: {
    postedWithinDays: 7,
    sortByDate: true,
  },

  maxFailuresPerRun: 10,
  maxRetriedFailuresPerRun: 5,
  maxConsecutiveFailures: 5,

  cooldownHoursAfterThrottle: 24,

  titleFilters: {
    enabled: true,
    excludeJuniorRoles: true,
    extraExcludes: [],
    allow: [],
  },

  fit: {
    skipOverqualifiedPostings: true,
    experienceToleranceYears: 2,
  },

  salaryUnit: 'auto',

  authorization: {
    authorizedCountries: ['India'],
    assumeAuthorizedWhenCountryUnstated: true,
  },

  customAnswers: [],

  pacing: {
    minSecondsBetweenApps: 45,
    maxSecondsBetweenApps: 150,
    longBreakEvery: 6,
    longBreakMinSeconds: 240,
    longBreakMaxSeconds: 600,
  },
};

module.exports = config;
