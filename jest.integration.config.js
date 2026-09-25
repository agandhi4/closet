// In-process integration tier: the real app on a fresh Postgres database per
// spec file and a temp DATA_PATH, driven through Fastify's inject().
// Needs pgvault-dev on localhost:5432 or TEST_DATABASE_URL (see
// test/support/scratch-database.ts). `npm run test:int`. Part of
// jest.config.js.

// ESM-only packages that CommonJS dependencies require(). Node 22.12+ loads
// them natively (require(esm)); Jest's module runtime cannot on Node 22 (its
// require(esm) needs Node 24.9+), so they are transpiled to CommonJS here.
// content-disposition 3 comes in through @fastify/static 10.1.4, which every
// spec loads when it boots the app.
// The package may sit nested (node_modules/@fastify/static/node_modules/...),
// hence the negative lookahead over the whole path rather than the usual
// `/node_modules/(?!pkg)`, which the outer node_modules segment would match.
const ESM_ONLY_DEPS = ['content-disposition'];
const ESM_ONLY_DEP_DIR = `/node_modules/(${ESM_ONLY_DEPS.join('|')})/`;

module.exports = {
  displayName: 'integration',
  rootDir: '.',
  testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    // Must precede the catch-all: the first matching pattern wins.
    [`${ESM_ONLY_DEP_DIR}.+\\.js$`]: [
      'ts-jest',
      { tsconfig: { allowJs: true, module: 'commonjs' } },
    ],
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  transformIgnorePatterns: [`^(?!.*${ESM_ONLY_DEP_DIR}).*/node_modules/`],
  // The codebase imports a few modules by their tsconfig baseUrl path.
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
  },
};
