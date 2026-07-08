# Project status & build log

A running record of what's been built, how the project works, and what's next.
Last updated: 2026-07-07.

## What this is

A dependency-free static weather dashboard for a personal **WeatherFlow Tempest**
station, built specifically to run in **Safari on iOS 10.3.3** (an iPad 4 /
MD513LL/A wall display). The official Tempest site doesn't run on that old
WebKit; this does. Deployed on **Firebase Hosting** at
**https://mytempestst.web.app** and versioned at
**https://github.com/adamelkinsdev/MyTempestStation**.

## Architecture & hard constraints

- **Plain HTML + CSS + vanilla ES5 JS.** No framework, no build step, no bundler.
  Three files in `public/`: `index.html`, `style.css`, `app.js`.
- **iOS 10.3.3 / Safari 10 compatibility is non-negotiable.** The code avoids
  everything that old WebKit lacks:
  - JS: `XMLHttpRequest` (not `fetch`), `var`/`function` (no `let`/`const`/arrow
    fns), no template literals, no Promises/async.
  - CSS: flexbox with margin gutters (no `gap`), `calc()` for widths, **no** CSS
    grid, custom properties, or `clamp()`.
  - Graphics: inline SVG and HTML/CSS bars only (no icon fonts, no external
    `<use>`, no CDNs).
- **No secrets in the repo.** The **Station ID** and **API token** are entered
  per-device on a setup screen and stored in that browser's `localStorage`
  (`tempest_station`, `tempest_token`). Nothing personal — no station ID, token,
  or location — lives in source.
- **Data sources** (both always metric → converted to imperial client-side):
  - Observations: `swd.weatherflow.com/swd/rest/observations/station/<id>?token=<t>`
  - Forecast: `swd.weatherflow.com/swd/rest/better_forecast?station_id=<id>&token=<t>`
- **License:** PolyForm Noncommercial 1.0.0 (`LICENSE`). Free for noncommercial
  use with attribution; commercial use requires a separate paid license.

## Refresh behavior

- **Idle mode:** observations + forecast every 60s.
- **Watch mode:** tap **Watch** → 10s observation polling with a live countdown;
  auto-reverts to Idle after 5 minutes. Tap again to exit early. (Constants in
  `app.js`: `IDLE_REFRESH_MS`, `WATCH_REFRESH_MS`, `WATCH_DURATION_MS`.)
- Also refreshes on returning to the foreground (visibilitychange).

## Features shipped

### Core dashboard (Q1)
Current conditions tiles with unit conversion, per-device token setup, error/stale
handling, 60s auto-refresh.

- **Wave A** — wind speed bar (0–20 mph, gust/lull markers), rain today-vs-yesterday
  bars + duration, UV color-band bar.
- **Wave B** — wind compass dial (rotating SVG needle), lightning proximity radar
  (distance rings, time-since-last, 3h count).
- **Wave C** — forecast fetch + sun arc (sunrise→sunset with sun position), 12h
  rain-chance strip, 24h temperature heat-strip.

### Platform / layout
- iPad wide-view optimization (1000px shell, 3 tiles/row ≥760px, larger type).
- Compact temperature banner (was a tall 3-row block).
- Watch/Idle refresh modes.

### History wave (F10–F14)
- **F10 ✅ History layer** — `recordHistory(o)` appends each observation to a
  `localStorage` ring buffer (`tempest_history`, cap 1500 ≈ 24h at 60s) as a lean
  numeric tuple `[ts, tempC, pressureMb, windDirDeg, windAvgMps]`. Deduped by
  timestamp; `saveHistory` sheds the oldest half on quota/Private-Mode failure.
  Zero extra API calls (Approach A). No UI — the foundation for F11–F14. History
  fills over time, so charts start sparse.

### Feature backlog progress (F-series)
- **F1 ✅ Dew-point comfort** — Humidity tile shows dew point + Dry/Comfortable/
  Sticky/Muggy/Oppressive/Sweltering.
- **F2 ✅ Rain last hour** — added to the Rain tile sub-line.
- **F3 ✅ Header clock + date** — shown from tablet width up.
- **F4 ✅ Auto day/night theme** — background shifts night/dawn/day/dusk from sun
  position, re-checked each clock tick (`#app.theme-*` classes).
- **F5 ✅ Plain-English summary line** — one synthesized sentence under the header
  (conditions + temp + comfort + wind + rain outlook).
- **F6 ✅ Threshold alerts** — tiles glow orange when a metric crosses a limit
  (lightning ≤ 10 mi recent, gust ≥ 25 mph, UV ≥ 6, temp ≤ 34°F); thresholds are
  constants in `app.js`.
- **F7 ✅ Weather-icon set + conditions hero** — hand-drawn inline-SVG icon for
  each of the 19 Tempest `icon` keys (one 64×64 grid, reused atoms, solid fills
  only — no gradients/filters/masks/`<use>`/transforms, iOS-10-safe). `ICONS`
  map + `iconSvg(key, px)` (fallback → `cloudy`) in `app.js`; `renderConditions`
  shows the icon + `current_conditions.conditions` words on the right of the
  temperature hero. Reusable at any px for F8/F9.
- **F8 ✅ Hourly forecast strip** — new full-width tile "Hourly · next 24h": a
  horizontally-scrollable row (`renderHourlyStrip`), one cell per hour with hour
  label + F7 icon (34px) + temp°F + precip%. Cells are fixed-width `inline-block`
  with margins in an `overflow-x:auto` container (no `gap`). 0% precip is drawn
  transparent to keep vertical rhythm without clutter.
- **F9 ✅ Multi-day forecast** — new full-width tile "Next days": a row of up to 8
  day-cells (`renderDaily`), each with weekday label (`Today` for day 0, else
  `DOW[getDay()]` from `day_start_local`) + F7 icon + hi/lo °F + precip%, from
  `forecast.daily[]`. Reuses the hourly-strip styles + `iconSvg()`. This is the
  answer to the "daily forecast" ask — served off the existing Tempest
  `better_forecast`, no NOAA/second data source needed.

## Remaining backlog (not yet built)

Ordered; build one at a time, deploy + verify + push per checkpoint.
See `SUGGESTED_FEATURES.md` for detailed specs, data fields, and approach per item.

- **Icon/forecast wave — COMPLETE** ✅: ~~F7 icon set + conditions hero~~ · ~~F8
  hourly strip~~ · ~~F9 multi-day forecast~~. The icon/forecast wave is fully
  shipped. `iconSvg(key, px)` is the shared unlock; `.fstrip` cells are reused by
  both strips.
- **History wave** *(F11 is next up)*: ~~F10 history layer~~ ✅ → F11 temperature
  sparkline · F12 pressure sparkline · F13 today's observed high/low · F14 wind
  rose. All draw from the F10 `tempest_history` ring buffer.
- **Platform:** F15 add-to-home-screen + offline shell (PWA polish).

## Local development, testing, deploy

```
# Serve locally over HTTP (file:// breaks localStorage + the API call)
npx serve public          # or: python -m http.server --directory public 8080

# Deploy (Firebase already authenticated as the owner)
firebase deploy --only hosting
```

**Test harnesses** live in the session scratchpad (not committed) and drive the
real `app.js` through a DOM/localStorage/XHR stub:
- `test-harness.js` — deterministic render assertions against a canned payload.
- `test-live.js` — fetches the **real** Tempest API (needs `APP_TOKEN` + `APP_JS`
  env vars) and prints every rendered tile; used to verify each feature against
  live data before deploying.
- `test-watch.js` — drives the Watch/Idle state machine via the button handler.

Verification pattern per feature: `node --check public/app.js` → run
`test-harness.js` (regression) → run `test-live.js` (real data) → deploy → push.

## Notes / gotchas learned

- The Tempest `obs` array and `better_forecast` are **always metric** regardless
  of `units_*` query params — convert C→F, m/s→mph, mb→inHg, mm→in, km→mi
  client-side.
- `obs[0]` has **no** `wind_direction_cardinal` — computed from `wind_direction`.
- `lightning_strike_count_last_3hr` is provided directly (no accumulation needed).
- Station ID for reference during dev: **210198** (Waterford). It is NOT in
  source — it's entered on the device and stored in localStorage.
