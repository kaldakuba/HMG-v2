/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  // Vynutí ukončení Jest po skončení testů — zabraňuje "visení" kvůli
  // otevřeným handles (DB pool, server listener spuštěný při require('../server'))
  forceExit: true,
  verbose: true,
  testMatch: ['**/__tests__/**/*.test.js'],
};
