const config = require('./config');

function getLocationSearchPairs() {
  const pairs = [];

  const { preferredCities, preferredCityModes, otherCities, otherCityModes } = config.locations;

  for (const city of preferredCities || []) {
    pairs.push({ location: city, workModes: preferredCityModes || ['onsite', 'hybrid', 'remote'] });
  }

  for (const city of otherCities || []) {
    pairs.push({ location: city, workModes: otherCityModes || ['remote'] });
  }

  return pairs;
}

function printLocationSummary() {
  const { preferredCities, preferredCityModes, otherCities, otherCityModes } = config.locations;
  console.log(`📍 Mumbai Area   : ${preferredCities.join(', ')}`);
  console.log(`   └─ Modes      : ${preferredCityModes.join(', ')}`);
  console.log(`🌐 Other Cities  : ${otherCities.join(', ')}`);
  console.log(`   └─ Modes      : ${otherCityModes.join(', ')} (remote only)`);
}

module.exports = { getLocationSearchPairs, printLocationSummary };
