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
