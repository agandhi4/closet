/**
 * Tiles per grid page; the "load more" sentinel fetches the next one. A
 * module of its own so the service worker can bundle it (the warm's page
 * cap, src/web/shell/offline-warm.ts) without the queries.
 */
export const GRID_PAGE_SIZE = 48;
