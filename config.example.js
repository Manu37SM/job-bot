require('dotenv').config({ quiet: true });

const config = {
  name: 'John Doe',
  email: 'john.doe@example.com',
  phone: '9876543210',
  location: 'Mumbai',
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
    'Java': 3,
    'React': 2,
    'Node.js': 3
  },
  jobTypes: ['permanent'],
  dayShiftOnly: true,
  maxApplications: {
    linkedin: { perRun: 20, lifetime: 500 },
    naukri: { perRun: 20, lifetime: 500 },
    indeed: { perRun: 10, lifetime: 200 },
  },
  resumePath: './Resume.pdf',

  speed: 'fast', // or 'medium', 'slow'
  pauseBetweenApps: 2, // seconds
};

module.exports = config;
