// In-process integration tier: the real app on a fresh Postgres database per
// spec file and a temp DATA_PATH, driven through Fastify's inject().
// Needs pgvault-dev on localhost:5432 or TEST_DATABASE_URL (see
// test/support/scratch-database.ts). `npm run test:int`. The unit tier stays in
// package.json's "jest" block.
module.exports = {
  rootDir: '.',
  testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  // The codebase imports a few modules by their tsconfig baseUrl path.
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
  },
  // Every spec boots its own app in beforeAll; the budget covers a cold
  // ts-jest compile of src/ plus migrations.
  testTimeout: 30000,
  maxWorkers: '50%',
};
