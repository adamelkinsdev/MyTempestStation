# CLAUDE.md

Guidance for working on this repo. This file is a **map + rules**, not a feature
list. For what any feature does, read the code in `public/app.js` or just look at
the running dashboard — those are the source of truth; this file is only the
durable "how to work here" guide.

## What this is

A dependency-free static weather dashboard for one personal **WeatherFlow Tempest**
station, built to run in **Safari on iOS 10.3.3** (an old iPad wall display). It's
three static files served by Firebase Hosting. There is **no build step** — what
you write in `public/` is what ships.

## The one non-negotiable rule: iOS 10.3.3 / Safari 10 compatibility

What you write must run on 2017-era WebKit. This shapes everything:

- **JS: ES5 only.** `var`/`function` (no `let`/`const`/arrow fns/classes),
  `XMLHttpRequest` (no `fetch`), no Promises/`async`, no template literals, no
  spread/destructuring. Don't rely on `classList` — use the string-based
  `hasClass`/`addClass`/`removeClass` helpers in `app.js`.
- **CSS:** flexbox with `-webkit-` prefixes and **margin gutters (no `gap`)**,
  `calc()` for widths. **No** CSS grid, custom properties, or `clamp()`.
- **Graphics:** inline SVG + HTML/CSS bars only. No icon fonts, no external
  `<use>`/`xlink`, no gradients/filters/masks/transforms, no CDNs. Solid fills
  via inline presentation attributes.

When unsure whether a feature is safe, assume it isn't and use the older idiom.
Verify with `node --check public/app.js` (syntax) — but the real test is the iPad.

## Where things live

- `public/index.html` — markup. Each dashboard module is a `.tile` with a
  `data-mod` key (drives Customize show/hide) and inner `id`s that JS fills.
- `public/style.css` — all styling. Base is single-column; `@media (min-width:420px)`
  goes 2-up; `@media (min-width:760px)` (iPad wide) goes 3-up metric tiles, with
  `.tile-full` spanning the row.
- `public/app.js` — **all** logic, in one IIFE. Roughly ordered: constants/state →
  helpers → per-feature `render*()` fns → `fetch*()` fns → refresh/watch loop →
  Customize mode → `init()`.

## Patterns to follow (match the surrounding code)

- **Render is data-driven and idempotent.** `render(obs)` / `renderForecast(fc)`
  repaint inner value nodes by `id`; they run on every refresh and on cached
  replay, so keep them side-effect-light and null-safe (see `fmt`, `toNum`).
- **Dynamic text → `textContent`, never `innerHTML`.** Only our own whitelisted
  constant markup (e.g. the `ICONS` SVG strings) goes into `innerHTML`. This is a
  deliberate XSS guard for third-party API strings — don't regress it.
- **Adding a tile:** add a `<div class="tile" data-mod="foo">` with inner `id`s in
  `index.html`; write `renderFoo()` in `app.js` and call it from `render()`/`renderForecast()`;
  style it in `style.css`. The `data-mod` attribute is all Customize mode needs —
  toggles are injected automatically at `init()`.
- **Extra data sources** (beyond Tempest) follow one shape: `build*Url()` +
  `fetch*()` (plain header-less `XMLHttpRequest` GET) + `maybe*()` time throttle,
  cached to `localStorage` via `saveLast`, replayed on load in `renderCached()`.
  Copy an existing one (AQI, alerts, stats) rather than inventing a new pattern.
- **Client history:** each observation is appended to a `localStorage` ring buffer
  (`recordHistory`) as a compact numeric tuple; sparklines/wind-rose read from it.

## Data sources & gotchas

- **Tempest** (needs the per-device token + station id): observations, `better_forecast`,
  and `stats/station/<id>` (daily hi/lo). Tempest payloads are **always metric** —
  convert client-side (`cToF`, `mpsToMph`, `mbToInHg`, …). `obs[0]` has no
  `wind_direction_cardinal` (compute it).
- **Open-Meteo air-quality** and **NWS `api.weather.gov`** (alerts + `/points`):
  free, no key, keyed off the station lat/lon captured from Tempest responses.
- **NWS CORS gotcha:** send **no custom headers** — a `User-Agent` header trips the
  NWS CORS preflight. Plain header-less GETs (what we do everywhere) work fine.

## Secrets / privacy — the repo is PUBLIC

- **Nothing personal in source:** no token, station ID, coordinates, or location.
  The token + station id are entered on the device and live only in that browser's
  `localStorage`; lat/lon and NWS zone are derived at runtime and cached per-device.
- `.gitignore` already blocks `*token*.txt`, `*.token`, `.env*`, and `.claude/`.
- Don't paste real tokens/IDs into committed files, docs, or test fixtures. Test
  harnesses take the token via an env var (`APP_TOKEN`) — never hardcode it.

## Dev / test / deploy

```bash
# Serve locally over HTTP (file:// breaks localStorage + API calls)
npx serve public

# Syntax check
node --check public/app.js

# Deploy (Firebase already authenticated as the owner)
firebase deploy --only hosting
```

Test harnesses live in the session scratchpad (not committed) and drive the real
`app.js` through a stubbed document/localStorage/XHR, then assert on the fake DOM —
run with `APP_JS=<abs path to public/app.js> node <harness>.js`. Recreate them if
the scratchpad is gone.

Working cadence: build one feature at a time, then `node --check` → regression
harness → deploy → commit + push per feature.
