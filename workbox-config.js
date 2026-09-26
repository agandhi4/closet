module.exports = {
  globDirectory: 'public/',
  globPatterns: ['**/*.{png,webp,css,ico,js,json,txt}'],
  // No page renders anything under assets/: the app icon (45 KB) is read by
  // the OS when the app is installed, by link previews and by the install
  // dialog, all online, so precaching it cost every fresh install for
  // nothing (issue #4). Neither the LLM corpus files nor the build stamp
  // belong in the app shell.
  globIgnores: [
    'assets/**',
    'llms*.txt',
    'robots.txt',
    'build.json',
  ],
  swDest: 'public/sw.js',
  swSrc: 'views/assets/src-sw.js',
};
