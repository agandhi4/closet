// Build entry for the outfit form's sortablejs (`npm run generate:vendor`,
// part of `npm run build`): esbuild bundles and minifies it to
// public/vendor/sortable.min.js, which the importmap in
// src/web/layout/layout.tsx maps `sortablejs` to. The package ships its ESM
// build unminified (modular/sortable.esm.js, 119 KB) and its minified build
// only as UMD, which an ES module cannot import.
//
// Re-exporting only the default leaves out the MultiDrag and Swap plugins
// (public/js/outfit-builder.js uses neither); the default export still mounts
// AutoScroll and OnSpill, as the package's own default does.
export { default } from 'sortablejs';
