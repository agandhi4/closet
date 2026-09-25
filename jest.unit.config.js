// Unit tier: src/**/*.spec.ts, everything mocked; verifies wiring and pure
// logic. Part of jest.config.js (`npm test` selects it).
module.exports = {
  displayName: 'unit',
  rootDir: 'src',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  testEnvironment: 'node',
};
