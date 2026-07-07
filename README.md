# My Tempest Station

A tiny, dependency-free weather dashboard for a
[WeatherFlow Tempest](https://tempestwx.com/) weather station, built to work in
**Safari on iOS 10.3.3**.

The official Tempest site doesn't run on that old iOS version, so this is a
stripped-down static page that reads the same data through the Tempest REST API
and renders it with plain HTML/CSS/vanilla JavaScript (no framework, no build step).

## How setup works (no secrets in this repo)

The site contains **no station ID, no token, no location** — nothing personal.
The first time you open it on a device, it asks for two things and stores them in
that browser's `localStorage` only:

1. **Station ID** — the number in your station's `tempestwx.com/station/<id>` URL.
2. **Access token** — create one at **tempestwx.com → Settings → Data
   Authorizations → Create Token**.

Neither value ever goes into the source, into git, or to any server other than
Tempest's own API. To use it on a new device, just enter the two values once.

## Features

Current conditions (temp, feels-like, humidity), wind (speed bar + gust/lull +
rotating compass), pressure with rising/falling/steady trend, rain today vs.
yesterday, UV index color bar, lightning proximity radar, a sunrise→sunset sun
arc, a 12-hour rain-chance strip, and a 24-hour temperature heat-strip. Auto-
refreshes every 60 seconds.

## Project layout

```
public/
  index.html   # markup: setup screen + dashboard
  style.css    # conservative CSS (no grid / flex-gap / custom properties)
  app.js       # ES5 logic: credential storage, fetch, render, auto-refresh
firebase.json  # Firebase Hosting config
.firebaserc    # Firebase project
```

## iOS 10.3.3 compatibility notes

To guarantee it runs on that old WebKit, the code deliberately avoids modern features:

- **JS:** `XMLHttpRequest` (not `fetch`), `var`/`function` (no `let`/`const`/arrow
  functions), no template literals, no Promises. Graphics are inline SVG (no
  external `<use>`, no icon fonts).
- **CSS:** flexbox with margin gutters (no `gap`), `calc()` for widths, no CSS
  grid, no custom properties, no `clamp()`.

## Local development

Serve the `public/` folder over HTTP (opening the file directly can break
`localStorage` and the API call). Any static server works, e.g.:

```
npx serve public
# or
python -m http.server --directory public 8080
```

## Deploy

```
npm install -g firebase-tools   # one time
firebase login                  # one time
firebase deploy                 # publishes public/ to Hosting
```

## API reference

- Observations: `https://swd.weatherflow.com/swd/rest/observations/station/<id>?token=<token>`
- Forecast: `https://swd.weatherflow.com/swd/rest/better_forecast?station_id=<id>&token=<token>`

## License

**Noncommercial use only.** This project is licensed under the
[PolyForm Noncommercial License 1.0.0](./LICENSE) — you may use, copy, modify, and
share it for any **noncommercial** purpose, with attribution.

**Commercial use is not permitted without a separate paid license from the
author.** If you want to use this (or a derivative) in a product, service, or any
revenue-generating context, you must contact the author to arrange a commercial
license / royalty terms first.

© 2026 Adam Elkins. All rights reserved except as granted by the LICENSE.
*(This notice is a plain-language summary, not legal advice; the LICENSE file
controls.)*
