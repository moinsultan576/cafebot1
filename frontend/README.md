# Frontend

Plain static HTML/CSS/JS — no framework, no build step.

- **`index.html`** / **`script.js`** — the customer chat widget, talks to
  the backend's `POST /api/chat`. Edit `API_BASE` at the top of
  `script.js` if the backend isn't running on its default port, or before
  deploying the frontend to a different host than the backend.
- **`dashboard.html`** / **`dashboard.js`** — a minimal staff dashboard
  that lists orders from `data/orders.json` (via the backend's
  `GET /api/orders`) and lets staff update an order's status (via
  `PATCH /api/orders/:orderId`). Edit `API_BASE` at the top of
  `dashboard.js` if the backend isn't running on its default port.
