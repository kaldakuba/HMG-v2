/** @type {import('jest').Config} */
module.exports = {
  // Vynutí ukončení Jest po skončení testů — zabraňuje "visení" kvůli
  // otevřeným handles (DB pool, server listener spuštěný při require('../server'))
  forceExit: true,
  verbose: true,

  projects: [
    // ── Tier 1: unit + integrační testy s mocky (nevyžadují reálnou DB) ──────
    {
      displayName: 'tier1',
      testEnvironment: 'node',
      testMatch: [
        '<rootDir>/__tests__/utils.test.js',
        '<rootDir>/__tests__/backup-integration.test.js',
        '<rootDir>/__tests__/restore-integration.test.js',
        '<rootDir>/__tests__/week-save-scheduler.test.js',
        '<rootDir>/__tests__/month-export.test.js',
        '<rootDir>/__tests__/obalovny.test.js',
        '<rootDir>/__tests__/obalovna-id.test.js',
        '<rootDir>/__tests__/superadmin.test.js',
        '<rootDir>/__tests__/audit.test.js',
        '<rootDir>/__tests__/create-demo.test.js',
        '<rootDir>/__tests__/id-validation.test.js',
        '<rootDir>/__tests__/authz-export-obalovna.test.js',
        '<rootDir>/__tests__/propagate-order.test.js',
      ],
    },

    // ── Tier 2: HTTP endpoint testy se skutečnou testovací DB ─────────────────
    // Vyžaduje .env.test s DATABASE_URL → TESTOVACÍ DB (nikdy produkční!).
    // Spuštění: npm run test:tier2
    {
      displayName: 'tier2',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/__tests__/endpoints.test.js'],
      // setupFiles: načítá .env.test a kontroluje bezpečnost DB URL
      setupFiles: ['<rootDir>/__tests__/setup-tier2.js'],
    },
  ],
};
