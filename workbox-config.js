module.exports = {
  globDirectory: 'public/',
  globPatterns: ['**/*.{png,webp,css,ico,js,json,txt}'],
  // Store listing screenshots (~900 KB, never rendered in-app), the LLM
  // corpus files and the build stamp have no business in the app shell.
  globIgnores: [
    'assets/screenshots/**',
    'llms*.txt',
    'robots.txt',
    'build.json',
  ],
  swDest: 'public/sw.js',
  swSrc: 'views/assets/src-sw.js',
};
