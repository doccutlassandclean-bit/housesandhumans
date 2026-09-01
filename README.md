# Houses & Humans

A lightweight, character-focused AI Dungeon Master for D&D 5.5e — a short
adventure to help you get a feel for a character, not a full virtual tabletop.

**Phase 1 architecture:** the vanilla-JS frontend (`index.html`, `script.js`,
`style.css`) is served same-origin by a small Node/Express backend. The backend
holds the Open WebUI credentials server-side and proxies chat/models/images,
so the browser never sees the API key. Open WebUI can later be replaced by
direct model providers without changing the browser API.

## Requirements

- Node.js 22+ (24 LTS recommended)

## Setup

1. `npm install`
   - If npm reports blocked install scripts, allow the better-sqlite3 binary:
     `npm install-scripts approve better-sqlite3`, then
     `node node_modules/prebuild-install/bin.js` from inside `node_modules/better-sqlite3`.
2. Copy `.env.example` to `.env` and fill in `OWU_BASE_URL` / `OWU_API_KEY`.
3. `npm start` (uses `node --env-file-if-exists=.env server.js`)
4. Open http://localhost:3000

## Development identity (temporary)

In development mode the frontend sends a stable, locally generated id in the
`X-User-Id` header. This is a **spoofable, development-only** identity that
exists to exercise the multi-user data model before real authentication is
built. Missing/invalid headers fall back to `DEV_USER_ID` (default `dev`).

## Production mode

`NODE_ENV=production` fails closed: every protected `/api` route returns 401
until real authentication is implemented. `X-User-Id` is never consulted in
production. The static site is still served.

## Premises (Phase 2A)

Each adventure gets **one story spine and one opening plot hook**, generated
once — on the first chat message — from the adventure's character snapshot and
the player's first message, then stored on the adventure row and reused for
the life of the adventure (never silently regenerated). If generation fails,
the chat turn fails closed with a retryable error and nothing is persisted.

The premise call reuses the exact same provider request shape as normal DM
chat (same endpoint, same configured model, same prompt-text references to the
"50 Campaign Spines" note and `CampaignStart → Plot Hooks.txt`), so it has the
same Open WebUI knowledge access the DM model already has. No provider-specific
knowledge metadata is used; knowledge attachment is the Open WebUI model
configuration's responsibility, as it already is for ordinary chat.

## Tests

`npm test` runs deterministic tests against a local mock Open WebUI server.
No live or authenticated provider requests are made.
