module.exports = {
  globDirectory: 'public/',
  // woff2: the two webfonts (views/assets/fonts.css), about 84 KB together,
  // precached so an installed app never draws a page in the fallback font.
  globPatterns: ['**/*.{png,webp,css,ico,js,json,txt,woff2}'],
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
    // The fonts' @font-face rules, already inlined into bundle.css.
    'vendor/fonts/fonts.css',
    // The error beacon: loaded only with SENTRY_DSN (the layout), so
    // without one no device fetches it; with one, the worker's assets-v1
    // cache keeps it after the first page that loads it.
    'js/errors.js',
    // js/vitals.js is also opt-in (METRICS_ENABLED) yet still precached: an
    // inconsistency left as is (#117 review), not a pattern to follow.
    // The client libraries (/modules/, copied from node_modules): cached by
    // the worker when a page loads them (assets-v1), never precached; the
    // install dialog's bundle alone is 160 KB.
    'modules/**',
  ],
  swDest: 'public/sw.js',
  swSrc: 'views/assets/src-sw.js',
};
