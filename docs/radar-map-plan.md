# Radar map tile — implementation plan

Status: **proposal, not yet implemented.** This doc is the plan; code comes in a
follow-up commit on this branch after review.

## Goal

Add a radar/weather-map tile to the dashboard, within the existing constraints in
`CLAUDE.md`: dependency-free, ES5, no CDNs, no build step, must run on Safari 10 /
iOS 10.3.3.

## Research summary (why this approach)

- **Tempest itself doesn't offer this for free.** The Home API this app uses (see
  `docs/tempest-api-guide.md`) has no radar/satellite endpoint. Radar & satellite
  map layers exist only in **TempestOne**, WeatherFlow's commercial/enterprise
  tier that requires a business agreement — not usable for a personal station.
- **Options considered for a free/public/open source map:**
  - **NWS RIDGE radar loop GIF** — `https://radar.weather.gov/ridge/standard/<SITE>_loop.gif`.
    Free, no key, public domain (US government work). Verified live: returns
    `HTTP 200`, `content-type: image/gif`. Plain animated GIF over HTTP — no JS
    map library required. Coverage: CONUS + AK/HI/PR (NEXRAD sites only).
  - **RainViewer public API** — free, worldwide radar tiles (`api.rainviewer.com/public/weather-maps.json`
    + XYZ tile paths). Rendering it as an actual pannable map needs a JS
    slippy-map library (e.g. Leaflet), which means vendoring + auditing a
    third-party library for ES5/Safari-10 compatibility and shipping it locally
    (no CDN allowed). A *single static tile* (no pan/zoom) is technically
    possible with some slippy-map tile-index math, but adds real complexity for
    no benefit over the NWS option if the station is in the US.
  - **Iowa Environmental Mesonet `radmap.php`** — free static PNG generator,
    flexible (custom bbox, overlays), but IEM's own docs ask that it not be used
    on high-traffic/production sites ("this application may be disabled to keep
    the IEM web farm from melting"). Weaker fit for a something that's expected
    to stay up as a wall display.
  - **Windy.com embed / OpenWeatherMap map tiles** — both need an iframe or a JS
    map library with modern JS/WebGL; real risk of not rendering (or rendering
    badly) on iOS 10.3.3's WebKit, and OpenWeatherMap's free tier is tile-based
    too (same library problem as RainViewer).
- **Decision: NWS RIDGE loop GIF.** It's one `<img>` tag — no new JS library, no
  CDN, fits the app's existing "extra data source" pattern exactly, and is free/
  public/no-key. Trade-offs: US NEXRAD coverage only, and it's a fixed regional
  loop, not a pannable/zoomable map — consistent with the rest of the dashboard,
  which is read-only tiles rather than an interactive UI anyway.

## Getting the radar site code for free

The app already calls NWS `api.weather.gov/points/{lat},{lon}` for alerts/zone
(see `CLAUDE.md` → Data sources). That response includes a `radarStation` field:

```
$ curl -s https://api.weather.gov/points/39.9526,-75.1652 | jq .properties.radarStation
"KDIX"
```

So the nearest NEXRAD site comes for free from data already being fetched — no
new API call, just read one more field off the existing response and cache it
alongside the zone/lat/lon the app already stores per-device.

## Implementation shape

Follows the existing `build*Url()` + `fetch*()`/render + `maybe*()` throttle
pattern used for AQI/alerts/stats (`CLAUDE.md` → Patterns to follow), with one
simplification: this source is an image, not JSON, so there's no XHR/parse step —
just a `src` assignment.

1. **`index.html`** — add a `<div class="tile tile-full" data-mod="radarmap">`
   containing `<img id="v-radarmap">` and a small caption ("NWS radar · KDIX").
   `tile-full` width so the loop stays legible.
2. **`app.js`**
   - In the existing NWS `/points` handler, capture `properties.radarStation`
     next to the zone/lat/lon that are already cached to `localStorage`.
   - `buildRadarMapUrl(site)` → `https://radar.weather.gov/ridge/standard/<SITE>_loop.gif?t=<epoch rounded to 5 min>`
     (cache-busting param so the browser refetches periodically instead of
     serving one stale GIF forever).
   - `renderRadarMap()` — sets `img.src` when `radarStation` is known; hides the
     tile when it's missing (station outside NWS coverage), matching the
     graceful-degrade pattern already used for AQI.
   - `maybeRadarMap()` throttled to roughly every 5 minutes (radar composites
     update on that order — no need to refetch every 60s poll, and it's a
     better neighbor to a free public government service).
   - Defensive check: validate `radarStation` matches `^[A-Z0-9]{3,4}$` before
     interpolating into the URL — cheap belt-and-suspenders since it's a
     third-party API string, consistent with the "never trust third-party API
     strings" rule in `CLAUDE.md`, even though in practice NWS only returns
     valid site codes.
3. **`style.css`** — fixed-height container + `max-width:100%; height:auto` for
   the `<img>` so the tile doesn't reflow while the GIF loads.
4. **Customize mode** — automatic, comes for free from the existing `data-mod`
   toggle mechanism.

## Constraints checklist (per `CLAUDE.md`)

- ES5 only — yes, just `img.src = url`, no `fetch`/Promises.
- No CDN — yes, image loads straight from `radar.weather.gov`, not a JS library.
- No build step — yes.
- XSS guard — URL built from a validated station code, not raw third-party text
  written into `innerHTML`.
- Secrets/privacy — no token involved; site code is derived at runtime from the
  station's own coordinates, same as the existing NWS zone lookup.

## Known limitations to confirm with the user

1. **US-only.** If the station is outside NWS NEXRAD coverage the tile just
   won't render (hidden, not broken) — should be fine since the app already
   depends on `api.weather.gov` for alerts, which is also US-only.
2. **No pan/zoom**, just a fixed regional loop around the nearest radar site. A
   real interactive map would need a vendored map library and is a bigger,
   separately-scoped effort given the no-CDN/ES5 constraints.
3. **Attribution** — NWS/NOAA data is public domain, no attribution legally
   required; adding a small "NWS radar" caption anyway for clarity.

## Test plan

- `node --check public/app.js`
- Regression harness (recreated in scratchpad per `CLAUDE.md`) stubbing the NWS
  `/points` response with/without `radarStation`, asserting the `<img src>` is
  built correctly and the tile hides when the field is absent.
- Manual check on the iPad: tile loads, GIF renders/animates, Customize toggle
  shows/hides it, no layout jank.
