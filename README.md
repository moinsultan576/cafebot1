# CafeBot

An AI chatbot for a cafe that answers menu questions, takes pickup/delivery
orders (with promotions, tax, and a delivery fee), and requires the
customer to explicitly confirm a full order summary before it's saved.
Built to be beginner-friendly and low-cost to run: no frameworks, no
database, no build step.

## Project structure

```
CafeBot/
├── prompts/
│   └── system-prompt.md     # Intro text prepended to the AI's system prompt
├── data/
│   ├── menu.json            # Menu items, prices, sizes, options, availability
│   ├── promotions.json      # Discounts; only "active": true ones are ever used
│   ├── orders.json          # Confirmed orders, appended to at checkout (gitignored — see below)
│   └── faq.json             # Placeholder; not currently wired up
├── frontend/
│   ├── index.html/script.js/styles.css   # Customer chat UI — currently mock messages only,
│   │                                       not yet connected to the backend
│   └── dashboard.html/dashboard.js       # Staff dashboard — lists/updates orders via the backend
├── backend/
│   ├── server.js            # The whole backend: /api/chat, /api/orders, /api/orders/:id
│   ├── package.json
│   └── README.md            # Full endpoint/behavior documentation
├── .env.example              # Template for required/optional config (copy to .env)
├── .gitignore
└── README.md                 # This file
```

See [backend/README.md](backend/README.md) for full details on every
endpoint and ordering rule, and [frontend/README.md](frontend/README.md)
for the two frontend pages.

## Local development

1. `cp .env.example .env` and fill in a real `ANTHROPIC_API_KEY` and
   `AI_MODEL`. `TAX_RATE` and `DELIVERY_FEE` are optional (default to 0).
2. `cd backend && npm start` — starts the API on `http://localhost:$PORT`
   (default `3000`). Requires Node 18+.
3. Serve `frontend/` with any static file server (e.g.
   `python -m http.server 8791 --directory frontend`) and open
   `index.html` (chat) or `dashboard.html` (staff order list).

## Deployment

This is two independent pieces — there's no combined build or single
"deploy" command:

- **Backend** (`backend/`) — a plain Node 18+ script with zero
  dependencies. Deploy it to any Node host (a VPS, or a platform like
  Render/Railway/Fly.io). Set `ANTHROPIC_API_KEY` and `AI_MODEL` (required)
  and optionally `TAX_RATE`/`DELIVERY_FEE` as environment variables in the
  host's config — the app reads `process.env` directly, so this works
  whether or not the host also gives you a way to upload a `.env` file.
  Start command: `npm start` (or `node server.js`) from `backend/`. The
  host must set `PORT`, or the app defaults to `3000`.
- **Frontend** (`frontend/`) — static files, deployable to any static host
  (Netlify, Vercel, GitHub Pages, an nginx bucket, etc.) or served by a
  reverse proxy in front of the backend. Before deploying
  `dashboard.html`, edit the `API_BASE` constant at the top of
  `frontend/dashboard.js` to the backend's real deployed URL (it defaults
  to `http://localhost:3000` for local dev). `index.html`'s chat UI has no
  such setting since it isn't connected to the backend yet — deploying it
  as-is only shows mock messages, not a working chatbot.

**Order storage caveat:** confirmed orders are appended to
`data/orders.json`, a plain file on the backend's local disk (see
`backend/README.md`). That file is gitignored so real customer names and
addresses never get committed. It also means orders will **not** persist
across restarts/redeploys on any host with an ephemeral filesystem
(most serverless/container platforms) — fine for local development or a
host with a persistent disk, but a real production deployment would need
a proper database, which is outside this project's current minimal scope.

## Coding guidance

See [CLAUDE.md](CLAUDE.md) for the rules this project is built under
(minimalism, no frameworks, security/secret handling, task scope).
