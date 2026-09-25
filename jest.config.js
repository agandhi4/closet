// Both Jest tiers in one run (`npm run test:all`, the pre-commit hook):
// one process, one worker pool, one coverage report. `npm test` and
// `npm run test:int` select a single project.
module.exports = {
  projects: [
    '<rootDir>/jest.unit.config.js',
    '<rootDir>/jest.integration.config.js',
  ],
  // Global options: per-project values are ignored in a projects run.
  maxWorkers: '50%',
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
