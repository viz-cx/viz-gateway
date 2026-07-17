# CORS allowlist (`allowed-origins.json`)

Origins allowed to read the gateway's public data endpoints (`/health`, `/fees`)
from a browser on another site.

- Entries are exact **origins** — scheme + host, **no path** and no trailing
  slash. GitHub Pages sends `Origin: https://viz-cx.github.io` (the host only),
  so that single entry covers every page under `viz-cx.github.io`.
- The coordinator echoes a listed origin back in `Access-Control-Allow-Origin`;
  unlisted origins get no CORS header and the browser blocks the read.
- Same-origin requests (the app served from `gateway.viz.cx`) need no entry.

**External site developers:** add your origin here in a PR. It takes effect on
the next coordinator restart/deploy.
