---
agent: agent
---

1. Please do not modify or add any documentation files without approval.
2. This project is plain Fastify with server-rendered, typed JSX views (hono/jsx, in src/web/). The default expectation is traditional server-side rendering. Avoid client-side logic that duplicates what the server can render.
3. ALL user-facing strings, in views and validation messages alike, come from src/i18n/en/lang.json through `t('KEY')` (src/web/i18n.ts, typed to the catalog's keys).
4. The "locality of behavior" principal is very important to me. Try to keep the code definition in or close to its use. Only extract it out to a variable referenced definition if it's used in multiple places.
5. Progressive enhancements may be added via htmx or \_hyperscript where they provide clear value (e.g. partial page updates, swipe gestures, drag-and-drop). In the views htmx, \_hyperscript, tailwind, and daisyui are available. Please use standard daisyui components from their documentation and prefer \_hyperscript for any necessary frontend logic instead of vanillajs in script tags. If front end code is likely to be reused it may be extracted out to a js file to be called on, located in public/js/ but this requires explicit approval.
6. Do not use runtime CDN imports (e.g. `<script src="https://cdn.example.com/...">` or dynamic `import('https://...')`). All client-side dependencies must be installed via npm (registry or tarball URL are both fine) and served locally by the `@fastify/static` registrations in `src/app.ts`, so no external network call is required at runtime.
7. Config values come from `loadConfig()` (src/config.ts), never `process.env` elsewhere.
8. Declare any new config value in the schema in src/config.ts with a reasonable default and update the root readme configuration section table for any new values.
9. Any documentation that doesn't fit the structure of the README.md should go into the docs/ folder
10. Assess work against docs/DESIGN.md if it's present
11. There is a npm run precommit script that should be run at the end to check your work and validate that everything passes Warnings are acceptable, failures are not.
12. After you've read this please confirm that you understand and await a go ahead for any actions you would like to proceed with.
