# My Tempest Station

A tiny, dependency-free weather dashboard for my [Tempest](https://tempestwx.com/station/210198/)
weather station, built to work in **Safari on iOS 10.3.3**.

The official Tempest site doesn't run on that old iOS version, so this is a
stripped-down static page that reads the same data through the Tempest REST API
and renders it with plain HTML/CSS/vanilla JavaScript (no framework, no build step).

## How the token works

The site contains **no secrets**. The first time you open it on a device, it asks
for your Tempest personal access token and stores it in that browser's
`localStorage`. It never goes into the source, into git, or to any server other
than Tempest's own API. To use it on a new device, just enter the token once.

Create a token at: **tempestwx.com → Settings → Data Authorizations → Create Token**.

## Project layout

```
public/
  index.html   # markup: setup screen + dashboard
  style.css    # conservative CSS (no grid / flex-gap / custom properties)
  app.js       # ES5 logic: token storage, fetch, render, auto-refresh
firebase.json  # Firebase Hosting config
.firebaserc    # Firebase project: mytempestst
```

## iOS 10.3.3 compatibility notes

To guarantee it runs on that old WebKit, the code deliberately avoids modern features:

- **JS:** `XMLHttpRequest` (not `fetch`), `var`/`function` (no `let`/`const`/arrow
  functions), no template literals, no Promises.
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

Then open the printed URL.

## Deploy

```
npm install -g firebase-tools   # one time
firebase login                  # one time
firebase deploy                 # publishes public/ to Hosting
```

Live at: https://mytempestst.web.app

## Station

- Station: https://tempestwx.com/station/210198/
- API: `https://swd.weatherflow.com/swd/rest/observations/station/210198?token=...`
