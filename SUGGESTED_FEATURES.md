# Suggested features & developer handoff

This is a pick-up-where-we-left-off guide for the next developer. It assumes you
have **not** worked on this repo before.

## 1. Read these first (10 minutes)

1. `PROGRESS.md` — what's built, architecture, and the shipped feature list.
2. `README.md` — setup and how the per-device token/station works.
3. `LICENSE` — PolyForm Noncommercial 1.0.0 (commercial use needs the owner's OK).

**The one rule that shapes everything:** this must run in **Safari on iOS 10.3.3**
(an iPad 4 wall display). That is non-negotiable and it disqualifies most modern
tooling. Before writing any code, internalize the constraints in §2.

## 2. Hard constraints (don't violate these)

- **Vanilla ES5 only.** No `let`/`const`, arrow functions, template literals,
  `fetch`, Promises, `async`/`await`, optional chaining, or spread. Use `var`,
  `function`, and `XMLHttpRequest`. There is no build step or transpiler — what
  you write is what ships.
- **CSS:** no CSS grid, no flexbox `gap`, no custom properties (`--vars`), no
  `clamp()`. Use flexbox with `-webkit-` prefixes + margins, and `calc()`.
- **Graphics:** inline SVG or HTML/CSS only. **No** icon fonts, **no** external
  SVG `<use xlink:href>`, **no** CDNs or web fonts (a strict environment and old
  WebKit will silently fail). Inline every SVG's markup directly into the DOM.
- **No secrets in the repo.** Station ID + token are per-device in `localStorage`
  (`tempest_station`, `tempest_token`). Never hardcode them or a location.
- **Test on the real device.** Desktop Safari/Chrome do NOT reproduce iOS 10.3.3.
  The owner has the iPad; give them a URL to check after each deploy.

## 3. How to build, test, deploy

```
# Serve locally (file:// breaks localStorage + the API call)
npx serve public

# Deploy — Firebase CLI is already authenticated as the owner
firebase deploy --only hosting        # -> https://mytempestst.web.app
```

**Testing pattern (important — recreate this).** The prior work verified every
feature by driving the real `public/app.js` through a Node stub of
`document`/`localStorage`/`XMLHttpRequest`, then asserting the resulting DOM. The
harness files were kept in scratch and are **not committed** — recreate them (and
consider committing them under `test/` this time). The stub, in short:

```js
// minimal shape — see PROGRESS.md for the fuller version
global.localStorage = { getItem, setItem, removeItem };   // holds token+station
global.XMLHttpRequest = function () {                       // returns canned JSON
  this.open = function(){}; this.send = function(){
    this.readyState = 4; this.status = 200;
    this.responseText = JSON.stringify(cannedPayload);
    if (this.onreadystatechange) this.onreadystatechange();
  };
};
global.document = { readyState:'complete', hidden:false,
  getElementById:function(id){ return fakeElements[id]; }, addEventListener:function(){} };
require('../public/app.js');   // runs the IIFE + init(); inspect fakeElements[...]
```

Two variants proved useful: a **deterministic** one (canned payload, exact
assertions) and a **live** one (stub XHR does a real `fetch` to the Tempest API
using a token from env, prints every tile). Per-feature loop:
`node --check public/app.js` → deterministic test → live test → deploy → have the
owner eyeball the iPad → commit + push (one commit per feature).

## 4. Where the code lives (orientation)

`public/app.js` is one IIFE. Roughly: credential storage → screen switching →
formatting/convert helpers (`cToF`, `mpsToMph`, `mbToInHg`, `mmToIn`, `kmToMi`,
`toNum`, `pct`) → per-tile `render*` functions → `render(data)` (observations) →
`renderForecast(data)` → fetch (`fetchData`, `fetchForecast`, `refreshAll`) →
watch/idle timers → clock/theme → `init()`. Add new tiles by (a) adding markup in
`index.html`, (b) a `renderX()` in `app.js` called from `render`/`renderForecast`,
(c) styles in `style.css`. Follow the existing patterns exactly.

## 5. Remaining backlog — detailed specs

### F7 · SVG weather-icon set + conditions hero  ← START HERE (biggest item)
- **Goal:** show the current sky condition as text + a graphic (like the official
  app's "Partly Cloudy" + icon), and reuse the icons in F8/F9.
- **Data:** `better_forecast` → `current_conditions.conditions` (string) and
  `current_conditions.icon` (string key). Hourly/daily entries also carry `icon`.
- **The work:** hand-draw an inline-SVG icon for each Tempest `icon` key. Known
  keys: `clear-day`, `clear-night`, `cloudy`, `foggy`, `partly-cloudy-day`,
  `partly-cloudy-night`, `possibly-rainy-day`, `possibly-rainy-night`,
  `possibly-sleet-day`, `possibly-sleet-night`, `possibly-snow-day`,
  `possibly-snow-night`, `possibly-thunderstorm-day`, `possibly-thunderstorm-night`,
  `rainy`, `sleet`, `snow`, `thunderstorm`, `windy`. Build a JS map
  `icon key -> SVG markup string` and a `iconSvg(key)` helper with a sensible
  fallback (e.g. cloudy). Keep each icon ~2–4 simple paths/circles.
- **Placement:** put the icon + conditions text in the temperature hero banner
  (right side has room), or a dedicated conditions area near the summary line.
- **Gotchas:** inline the SVG (no `<use>`, no font). Provide day/night variants
  (pick using sun position — the theme code already computes day vs night). Test
  the icon renders on the actual iPad (old WebKit SVG quirks).
- **Done when:** current condition shows correct text + icon and switches
  day/night; unknown keys fall back gracefully.

### F8 · Hourly forecast strip
- **Goal:** a horizontally-scrolling row of upcoming hours: icon + temp + precip%.
- **Data:** `forecast.hourly[]` (≈229 entries). Per hour: `icon`,
  `air_temperature` (°C → °F), `precip_probability`, `local_hour` (0–23).
- **Approach:** reuse F7's `iconSvg()`. Lay cells out as `inline-block` with
  margins (no `gap`); wrap in `overflow-x:auto; -webkit-overflow-scrolling:touch`.
  Show ~12–24 hours. There is already a precip strip and heat strip — match their
  style. Label every few hours with `hourLabel(local_hour)` (helper exists).
- **Gotchas:** don't rely on `gap`; icon set must exist first (F7).

### F9 · Multi-day forecast
- **Goal:** a row of upcoming days: icon + hi/lo + precip%.
- **Data:** `forecast.daily[]`. Per day: `icon`, `air_temp_high`/`air_temp_low`
  (°C → °F), `precip_probability`, `conditions`, `day_start_local` (epoch; derive
  weekday via `new Date(x*1000).getDay()` + the `DOW` array already in app.js).
- **Approach:** full-width tile, cells `inline-block`. Use a shared temp scale
  across days if you draw hi/lo range bars. Reuse `iconSvg()`.

### F10 · History layer (foundation for F11–F14)
- **Goal:** a rolling client-side history so charts have data. Build ONCE.
- **Approach A (recommended, zero extra API):** on each successful obs poll, push
  a lean tuple `[timestamp, tempC, pressureMb, windDirDeg, windAvgMps]` into a
  ring buffer in `localStorage` (separate key, e.g. `tempest_history`). Cap by
  count (e.g. last 1500 points ≈ 24h at 60s) and wrap writes in try/catch
  (`QuotaExceededError` behaves oddly on old Safari / Private Mode). History fills
  over time; charts start sparse.
- **Approach B (instant backfill):** the device-history endpoint
  `observations/device/{device_id}?time_start=&time_end=` returns real past data,
  but needs `device_id` (discover via `GET stations/{id}`, cache it). More code.
- **Recommendation:** ship A first; add B later if the owner wants instant charts.
- **Gotcha:** localStorage is shared with the token — don't let history growth
  crowd it; keep tuples numeric and capped.

### F11 · Temperature sparkline  ·  F12 · Pressure sparkline
- **Goal:** a small line under the relevant tile showing recent hours.
- **Data:** the F10 ring buffer. Draw an inline-SVG `<polyline>` from scaled
  points; auto-scale Y to min/max (pressure has a narrow range — essential).
  Downsample if the point count is large.

### F13 · Today's observed high/low
- **Goal:** actual observed hi/lo so far today (distinct from forecast hi/lo).
- **Data:** F10 history filtered to the local day; or track running min/max in a
  small `localStorage` record that resets at local midnight.

### F14 · Wind rose
- **Goal:** polar plot of which directions the wind has blown from, and how hard.
- **Data:** F10 history: bin `wind_direction` into 8 or 16 sectors weighted by
  `wind_avg`. `<canvas>` (arc/moveTo/lineTo) is likely simpler than many SVG wedge
  paths here. Needs meaningful accumulated history to look like anything.

### F15 · Add-to-home-screen + offline shell
- **Goal:** opens instantly, survives a dropped connection on the wall display.
- **Approach:** Apple touch meta tags + a small icon (already partly set:
  `apple-mobile-web-app-*` metas exist). Cache the last observation JSON in
  `localStorage` and render it on load before the network returns. Note: iOS
  10.3.3 has **no Service Worker**, so a true offline cache isn't available — do
  the "last-known-reading from localStorage" trick instead.

## 6. Fresh ideas (not yet in the backlog)

- **Heat-stress badge (WBGT):** `obs.wet_bulb_globe_temperature` — outdoor-work
  safety level. Data already fetched; cheap.
- **Feels-like delta:** show how far `feels_like` sits from `air_temperature` and
  why (humidity vs wind).
- **Solar/brightness gauge:** `solar_radiation` (W/m²) + `brightness` (lux) — good
  for gardening/solar; a simple bar.
- **Pressure storm nowcast:** combine `pressure_trend` with the F12 rate of change
  → "pressure falling fast" callout in the summary line (F5 is the natural home).
- **Configurable alert thresholds UI:** F6 thresholds are hardcoded constants;
  add a small settings panel to edit them (store in localStorage).
- **Rotating detail panels:** for the wall display, auto-cycle a "focus" view
  (e.g. big wind, then big rain) every N seconds.
- **Sunrise/sunset countdown + daylight length:** enrich the existing sun arc.
- **Season/almanac line:** daylight change vs yesterday, using sun times.

## 7. API field reference (verified against a live station)

Values are **metric** — convert client-side (helpers exist in app.js).

**`observations/station/{id}` → `obs[0]`:** `timestamp`, `air_temperature`,
`feels_like`, `dew_point`, `wet_bulb_temperature`, `wet_bulb_globe_temperature`,
`relative_humidity`, `station_pressure`, `sea_level_pressure`,
`barometric_pressure`, `pressure_trend` (`rising`/`falling`/`steady`), `wind_avg`,
`wind_gust`, `wind_lull`, `wind_direction` (deg; **no** cardinal — compute it),
`uv`, `solar_radiation`, `brightness`, `air_density`, `delta_t`, `heat_index`,
`wind_chill`, `lightning_strike_count`, `lightning_strike_count_last_1hr`,
`lightning_strike_count_last_3hr`, `lightning_strike_last_distance` (km),
`lightning_strike_last_epoch`, `precip`, `precip_accum_last_1hr`,
`precip_accum_local_day`, `precip_accum_local_yesterday`,
`precip_minutes_local_day`, `precip_minutes_local_yesterday`.

**`better_forecast`:** `current_conditions` (incl. `conditions`, `icon`, and most
obs fields), `forecast.daily[]` (`air_temp_high`, `air_temp_low`, `conditions`,
`icon`, `precip_icon`, `precip_probability`, `precip_type`, `sunrise`, `sunset`,
`day_start_local`, `day_num`, `month_num`), `forecast.hourly[]` (~229 entries:
`air_temperature`, `conditions`, `feels_like`, `icon`, `local_day`, `local_hour`,
`precip`, `precip_probability`, `relative_humidity`, `sea_level_pressure`, `time`,
`uv`, `wind_avg`, `wind_direction`, `wind_direction_cardinal`, `wind_gust`),
`timezone`, `timezone_offset_minutes`, `units`.

## 8. Suggested order

F7 → F8 → F9 (icon/forecast wave; F7 is the gate), then F10 → F11/F12/F13/F14
(history wave; F10 is the gate), then F15. Interleave the cheap §6 ideas
(WBGT, feels-like delta, solar bar) whenever a quick win is wanted.
