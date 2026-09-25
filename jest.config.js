// Both Jest tiers in one run (`npm run test:all`, the pre-commit hook):
// one process, one worker pool, one coverage report. `npm test` and
// `npm run test:int` select a single project.
module.exports = {
  projects: [
    '<rootDir>/jest.unit.config.js',
    '<rootDir>/jest.integration.config.js',
  ],
  // Global options: per-project values are ignored in a projects run (a
  // project-level testTimeout resolves in --showConfig but the runner uses
  // the global one, 5 s by default; CI's 2-core runner boots an integration
  // app slower than that). The budget covers a cold ts-jest compile of src/
  // plus migrations in each integration spec's beforeAll.
  maxWorkers: '50%',
  testTimeout: 30000,
  collectCoverageFrom: [
    'src/**/*.(t|j)s',
    '!src/**/*.spec.ts',
    '!src/**/migrations/**/*',
    '!src/**/entity/**/*',
    '!src/**/*.dto.*',
    '!src/**/*.module.*',
    '!src/main.ts',
  ],
  coverageDirectory: 'coverage',
};
