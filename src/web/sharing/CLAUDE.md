# Sharing (`/wardrobe-share/*`, the access resolver)

- **One resolver:** `resolveWardrobeAccess` / `authorizeWardrobe` (`access.ts`) decide whose wardrobe a request addresses (`?ownerId=`, `''` or absent for your own) and what the caller may do there (view, manage, own). Share-aware pages and MCP tools go through it (MCP via `wardrobeFor`, `mcp/tool.ts`); never re-derive access from `sessionUserId` plus a share lookup.
- **Which surfaces are share-aware** (take `?ownerId=` and serve a grantee): the wardrobe grid and garment pages (link import included), the wishlist, capsules, Styling, plans and the shopping list, wears (owner only, but resolved through it), and the MCP tools that address a wardrobe.
- **Owner-only by design** (session user only, no `?ownerId=`): the calendar (week and month), Ideas/gallery, insights, trips, Today, the weekly auto-plan, selfies, sizes, and Profile. They are one person's planning and history, and a grantee must never see them.
- **A new feature decides which list it joins, and says so here.** Don't copy a sibling's route shape without checking: a share-aware sibling routes through the resolver, and an owner-only one reads `sessionUserId` alone.
- Sharing's own pages live in Profile › Sharing (`/auth/profile#sharing`); `GET /wardrobe-share/manage` 301s there (R2 #82). The public share-link page is `share/`, not this directory.
