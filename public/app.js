/* MyTempestStation dashboard.
 * Written in conservative ES5 (no arrow functions, template literals, let/const,
 * fetch, or Promises) so it runs on Safari for iOS 10.3.3.
 * The station ID and API token are stored only in this browser's localStorage -
 * never in source, so nothing here reveals the station or its location. */
(function () {
  'use strict';

  var TOKEN_KEY = 'tempest_token';
  var STATION_KEY = 'tempest_station';
  var HISTORY_KEY = 'tempest_history';
  var HISTORY_MAX = 1500;         // ring-buffer cap (~24h at the 60s idle poll)
  var LAST_OBS_KEY = 'tempest_last_obs';       // F15: last-known payloads so the
  var LAST_FC_KEY = 'tempest_last_forecast';   // wall display paints on load
  var HIDDEN_KEY = 'tempest_hidden';           // per-device list of hidden modules
  var COORDS_KEY = 'tempest_coords';           // station lat/lon (for AQI + alerts)
  var PLACE_KEY = 'tempest_place';             // NWS zone/county for this location
  var LAST_AQI_KEY = 'tempest_last_aqi';       // cached Open-Meteo air-quality payload
  var LAST_ALERTS_KEY = 'tempest_last_alerts'; // cached NWS active-alerts payload
  var STALE_MS = 15 * 60 * 1000; // flag data older than 15 min

  // Air quality (Open-Meteo) and NWS alerts refresh slowly; poll each at most
  // this often even though observations tick every 60s.
  var AQI_REFRESH_MS = 15 * 60 * 1000;
  var ALERTS_REFRESH_MS = 10 * 60 * 1000;

  // Refresh cadence. Idle is the normal pace; Watch is a temporary fast pace for
  // storm-watching that auto-relaxes back to Idle after WATCH_DURATION_MS.
  var IDLE_REFRESH_MS = 60000;          // 60s normal
  var WATCH_REFRESH_MS = 10000;         // 10s while watching
  var WATCH_DURATION_MS = 5 * 60 * 1000; // watch mode lasts 5 minutes

  var MODE_IDLE = 'idle';
  var MODE_WATCH = 'watch';
  var mode = MODE_IDLE;

  // Alert thresholds — a tile glows when its metric crosses one of these.
  var ALERT_GUST_MPH = 25;
  var ALERT_UV = 6;
  var ALERT_TEMP_F = 34;
  var ALERT_LIGHTNING_MI = 10;

  var refreshTimer = null;  // periodic data refresh
  var watchTimer = null;    // 1s ticker driving the watch countdown/fallback
  var watchEndsAt = 0;      // epoch ms when watch mode auto-reverts to idle
  var sunTimes = null;      // {sr, ss} epoch seconds, for the day/night theme
  var stationCoords = null; // {lat, lon} captured from the Tempest responses
  var stationPlace = null;  // {zone, county, city, state} from the NWS points API
  var lastAqiAt = 0;        // epoch ms of the last air-quality fetch (throttle)
  var lastAlertsAt = 0;     // epoch ms of the last NWS alerts fetch (throttle)

  // Alert glows on for genuinely unhealthy air (US AQI above "Unhealthy for
  // Sensitive Groups").
  var ALERT_AQI = 150;

  function byId(id) { return document.getElementById(id); }

  /* ---------- credential storage (token + station, per-device) ---------- */

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY); }
    catch (e) { return null; }
  }
  function setToken(t) {
    try { localStorage.setItem(TOKEN_KEY, t); } catch (e) {}
  }
  function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  function getStation() {
    try { return localStorage.getItem(STATION_KEY); }
    catch (e) { return null; }
  }
  function setStation(s) {
    try { localStorage.setItem(STATION_KEY, s); } catch (e) {}
  }

  // True only when this device has both values configured.
  function isConfigured() {
    return !!(getToken() && getStation());
  }

  /* ---------- station coordinates (for air quality + alerts) ---------- */
  // The Tempest observation and forecast responses carry the station's lat/lon.
  // We stash it per-device (like the token) so the client can query Open-Meteo
  // and, later, the NWS alerts API by point — no location ever lives in source.

  function loadCoords() {
    try {
      var raw = localStorage.getItem(COORDS_KEY);
      if (!raw) { return null; }
      var c = JSON.parse(raw);
      if (c && typeof c.lat === 'number' && typeof c.lon === 'number') { return c; }
    } catch (e) {}
    return null;
  }

  function captureCoords(data) {
    if (!data) { return; }
    var la = toNum(data.latitude);
    var lo = toNum(data.longitude);
    if (la === null || lo === null) { return; }
    stationCoords = { lat: la, lon: lo };
    try { localStorage.setItem(COORDS_KEY, JSON.stringify(stationCoords)); } catch (e) {}
  }

  function loadPlace() {
    try {
      var raw = localStorage.getItem(PLACE_KEY);
      if (!raw) { return null; }
      var p = JSON.parse(raw);
      if (p && (p.zone || p.county)) { return p; }
    } catch (e) {}
    return null;
  }

  /* ---------- screen switching ---------- */

  function showSetup(message) {
    stopAutoRefresh();
    byId('dashboard').style.display = 'none';
    byId('setup').style.display = '';
    var err = byId('setup-error');
    if (message) { err.innerHTML = message; err.style.display = ''; }
    else { err.style.display = 'none'; }
    byId('token-input').value = getToken() || '';
    byId('station-input').value = getStation() || '';
  }

  function showDashboard() {
    byId('setup').style.display = 'none';
    byId('dashboard').style.display = '';
  }

  /* ---------- status + errors ---------- */

  function setStatus(text) { byId('status-line').innerHTML = text; }

  function setError(text) {
    var b = byId('error-banner');
    if (text) { b.innerHTML = text; b.style.display = ''; }
    else { b.style.display = 'none'; }
  }

  /* ---------- formatting helpers ---------- */

  /* The Tempest "obs" array is ALWAYS metric (deg C, m/s, mb, mm) regardless of
     any units_* query params, so we convert to imperial here on the client. */
  function cToF(c) { return c * 9 / 5 + 32; }
  function mpsToMph(m) { return m * 2.2369362920544; }
  function mbToInHg(mb) { return mb * 0.0295299830714; }
  function mmToIn(mm) { return mm * 0.0393700787402; }

  // Format a value: optionally convert units, round to `decimals`, append suffix.
  function fmt(value, convert, decimals, suffix) {
    if (value === null || value === undefined || value === '') { return '&mdash;'; }
    var n = Number(value);
    if (isNaN(n)) { return '&mdash;'; }
    if (convert) { n = convert(n); }
    return n.toFixed(decimals) + (suffix || '');
  }

  var CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                   'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

  function cardinal(deg) {
    if (deg === null || deg === undefined || isNaN(Number(deg))) { return ''; }
    var idx = Math.round(Number(deg) / 22.5) % 16;
    return CARDINALS[idx];
  }

  // Return a finite Number, or null for missing/invalid values.
  function toNum(value) {
    if (value === null || value === undefined || value === '') { return null; }
    var n = Number(value);
    return isNaN(n) ? null : n;
  }

  // m/s -> mph as a Number (null-safe), for the bars/gauges.
  function mpsToMphN(value) {
    var n = toNum(value);
    return n === null ? null : mpsToMph(n);
  }

  // Clamp value/max to a 0-100 percentage.
  function pct(value, max) {
    if (value === null || !max) { return 0; }
    var p = value / max * 100;
    if (p < 0) { return 0; }
    if (p > 100) { return 100; }
    return p;
  }

  function fmtDuration(mins) {
    var m = toNum(mins);
    if (m === null) { return ''; }
    m = Math.round(m);
    if (m < 60) { return m + ' min'; }
    var h = Math.floor(m / 60);
    return h + 'h ' + pad2(m % 60) + 'm';
  }

  /* ---------- Wind speed bar (0-20 mph, gust + lull markers) ---------- */

  function windClass(mph) {
    if (mph === null) { return 'wind-calm'; }
    if (mph < 5) { return 'wind-calm'; }
    if (mph < 15) { return 'wind-mod'; }
    return 'wind-strong';
  }

  function renderWindBar(avgMph, gustMph, lullMph) {
    var max = 20;
    var fill = byId('windbar-fill');
    var gust = byId('windbar-gust');
    var lull = byId('windbar-lull');
    if (fill) {
      fill.style.width = pct(avgMph, max) + '%';
      fill.className = 'windbar-fill ' + windClass(avgMph);
    }
    if (gust) {
      if (gustMph === null) { gust.style.display = 'none'; }
      else { gust.style.display = ''; gust.style.left = pct(gustMph, max) + '%'; }
    }
    if (lull) {
      // Only show the lull marker when it is meaningfully above zero.
      if (lullMph === null || lullMph < 0.5) { lull.style.display = 'none'; }
      else { lull.style.display = ''; lull.style.left = pct(lullMph, max) + '%'; }
    }
  }

  /* ---------- Rain today vs. yesterday ---------- */

  function rainText(inches) {
    if (inches === null) { return '&mdash;'; }
    if (inches > 0 && inches < 0.01) { return 'Trace'; }
    return inches.toFixed(2) + ' in';
  }

  function renderRain(o) {
    var todayMm = toNum(o.precip_accum_local_day);
    var yestMm = toNum(o.precip_accum_local_yesterday);
    var todayIn = todayMm === null ? null : mmToIn(todayMm);
    var yestIn = yestMm === null ? null : mmToIn(yestMm);

    byId('v-rain').innerHTML = rainText(todayIn);

    // Sub line: rain in the last hour + how long it rained today.
    var last1Mm = toNum(o.precip_accum_last_1hr);
    var last1In = last1Mm === null ? null : mmToIn(last1Mm);
    var durToday = fmtDuration(o.precip_minutes_local_day);
    var parts = [];
    if (last1In !== null) {
      parts.push('Last hr ' + (last1In > 0 && last1In < 0.01 ? 'Trace' : last1In.toFixed(2) + '"'));
    }
    if (durToday) { parts.push('rained ' + durToday + ' today'); }
    byId('v-rain-dur').innerHTML = parts.length ? parts.join(' &middot; ') : '&nbsp;';

    // Scale both bars to the larger of the two (min floor avoids divide-by-zero).
    var max = Math.max(todayIn || 0, yestIn || 0, 0.01);
    byId('rainbar-today').style.width = pct(todayIn, max) + '%';
    byId('rainbar-yest').style.width = pct(yestIn, max) + '%';
    byId('rainbar-today-val').innerHTML = todayIn === null ? '&mdash;' : (todayIn > 0 && todayIn < 0.01 ? 'Trace' : todayIn.toFixed(2) + '"');
    byId('rainbar-yest-val').innerHTML = yestIn === null ? '&mdash;' : yestIn.toFixed(2) + '"';
  }

  /* ---------- Threshold alerts (tile glow) ---------- */

  function hasClass(el, c) { return (' ' + el.className + ' ').indexOf(' ' + c + ' ') !== -1; }
  function addClass(el, c) { if (!hasClass(el, c)) { el.className = el.className ? (el.className + ' ' + c) : c; } }
  function removeClass(el, c) {
    el.className = (' ' + el.className + ' ').replace(' ' + c + ' ', ' ').replace(/^\s+|\s+$/g, '');
  }
  function setAlert(id, on) {
    var el = byId(id);
    if (!el) { return; }
    if (on) { addClass(el, 'tile-alert'); } else { removeClass(el, 'tile-alert'); }
  }

  function applyAlerts(o) {
    var gust = mpsToMphN(o.wind_gust);
    setAlert('tile-wind', gust !== null && gust >= ALERT_GUST_MPH);

    var uv = toNum(o.uv);
    setAlert('tile-uv', uv !== null && uv >= ALERT_UV);

    var tc = toNum(o.air_temperature);
    var tf = tc === null ? null : cToF(tc);
    setAlert('tile-temp', tf !== null && tf <= ALERT_TEMP_F);

    // Lightning only alerts for a genuinely recent strike (< 3h) within range.
    var distKm = toNum(o.lightning_strike_last_distance);
    var distMi = distKm === null ? null : kmToMi(distKm);
    var epoch = toNum(o.lightning_strike_last_epoch);
    var recent = epoch !== null && (new Date().getTime() / 1000 - epoch) < 3 * 3600;
    setAlert('tile-lightning', recent && distMi !== null && distMi <= ALERT_LIGHTNING_MI);
  }

  /* ---------- Dew-point comfort ---------- */

  // Comfort is driven by dew point (F), the metric people actually feel.
  function comfortWord(f) {
    if (f < 55) { return 'Dry'; }
    if (f < 60) { return 'Comfortable'; }
    if (f < 65) { return 'Sticky'; }
    if (f < 70) { return 'Muggy'; }
    if (f < 75) { return 'Oppressive'; }
    return 'Sweltering';
  }
  function comfortClass(f) {
    if (f < 60) { return 'comfort-good'; }
    if (f < 70) { return 'comfort-mid'; }
    return 'comfort-bad';
  }
  function renderComfort(dewC) {
    var el = byId('v-comfort');
    if (!el) { return; }
    var d = toNum(dewC);
    if (d === null) { el.innerHTML = '&mdash;'; return; }
    var f = cToF(d);
    el.innerHTML = '<span class="' + comfortClass(f) + '">' + comfortWord(f) + '</span>';
  }

  /* ---------- UV index (WHO color bands) ---------- */

  function uvCategory(uv) {
    if (uv === null) { return ''; }
    if (uv < 3) { return 'Low'; }
    if (uv < 6) { return 'Moderate'; }
    if (uv < 8) { return 'High'; }
    if (uv < 11) { return 'Very High'; }
    return 'Extreme';
  }

  function renderUV(uvRaw) {
    var uv = toNum(uvRaw);
    byId('v-uv').innerHTML = uv === null ? '&mdash;' : uv.toFixed(1);
    byId('v-uv-cat').innerHTML = uv === null ? '&nbsp;' : uvCategory(uv);
    var marker = byId('uvbar-marker');
    if (marker) { marker.style.left = pct(uv, 11) + '%'; }
  }

  /* ---------- Wind compass (rotating SVG needle) ---------- */

  // Meteorological wind_direction is the bearing the wind comes FROM. SVG
  // rotate() is clockwise like compass bearings, so a north-pointing needle
  // rotated by the bearing points at the source direction.
  function renderCompass(deg) {
    var g = byId('compass-needle');
    if (!g || !g.setAttribute) { return; }
    var d = (deg === null) ? 0 : deg;
    g.setAttribute('transform', 'rotate(' + d + ' 50 50)');
  }

  /* ---------- Lightning proximity ---------- */

  function kmToMi(km) { return km * 0.621371; }

  function fmtAgo(epoch) {
    var e = toNum(epoch);
    if (e === null || e <= 0) { return 'None'; }
    var diff = Math.floor(new Date().getTime() / 1000 - e);
    if (diff < 0) { diff = 0; }
    if (diff < 60) { return diff + 's ago'; }
    if (diff < 3600) { return Math.floor(diff / 60) + 'm ago'; }
    if (diff < 86400) { return Math.floor(diff / 3600) + 'h ago'; }
    return Math.floor(diff / 86400) + 'd ago';
  }

  function renderLightning(o) {
    var distKm = toNum(o.lightning_strike_last_distance);
    var distMi = distKm === null ? null : kmToMi(distKm);
    var epoch = toNum(o.lightning_strike_last_epoch);
    var c3 = toNum(o.lightning_strike_count_last_3hr);

    byId('v-lightning-last').innerHTML = fmtAgo(epoch);
    byId('v-lightning-dist').innerHTML = distMi === null ? '&mdash;' : (distMi.toFixed(1) + ' mi');
    byId('v-lightning-3hr').innerHTML = (c3 === null ? '0' : Math.round(c3));

    // Show the radar dot only for a genuinely recent strike (< 3h) at a real
    // distance; older strikes leave the radar clear (station dot only).
    var dot = byId('lightning-dot');
    if (dot && dot.setAttribute) {
      var secSince = epoch === null ? null : (new Date().getTime() / 1000 - epoch);
      var recent = secSince !== null && secSince < 3 * 3600 && distMi !== null;
      if (recent) {
        var maxMi = 25;
        var r = pct(distMi, maxMi) / 100 * 42; // up to the outer ring
        dot.setAttribute('cy', (50 - r).toFixed(1));
        dot.setAttribute('opacity', '1');
      } else {
        dot.setAttribute('opacity', '0');
      }
    }
  }

  /* ---------- Forecast: sun arc, precip strip, heat strip ---------- */

  function hourLabel(lh) {
    var h = lh % 12;
    if (h === 0) { h = 12; }
    return h + (lh < 12 ? 'a' : 'p');
  }

  function precipColor(pp) {
    if (pp < 20) { return '#3f6b8f'; }
    if (pp < 50) { return '#4a9fd0'; }
    if (pp < 75) { return '#3ec1ea'; }
    return '#5ed0f5';
  }

  // Temperature (F) -> blue(cold)..red(hot) via HSL hue interpolation.
  function tempColor(f) {
    if (f === null) { return '#5b6b7e'; }
    var c = f; if (c < 10) { c = 10; } if (c > 100) { c = 100; }
    var hue = 220 - ((c - 10) / 90) * 220;
    return 'hsl(' + Math.round(hue) + ', 68%, 52%)';
  }

  function renderSunArc(day) {
    var sun = byId('sun-dot');
    if (!day || !sun || !sun.setAttribute) { return; }
    var sr = toNum(day.sunrise), ss = toNum(day.sunset);
    if (sr === null || ss === null || ss <= sr) { return; }

    // Remember these so the clock tick can re-theme as time passes.
    sunTimes = { sr: sr, ss: ss };
    applyTheme(sr, ss);

    var now = new Date().getTime() / 1000;
    var t = (now - sr) / (ss - sr);
    var night = (t < 0 || t > 1);
    if (t < 0) { t = 0; } if (t > 1) { t = 1; }

    // Point on the semicircle: center (100,82) r72, apex at top.
    var th = (1 - t) * Math.PI;
    sun.setAttribute('cx', (100 + 72 * Math.cos(th)).toFixed(1));
    sun.setAttribute('cy', (82 - 72 * Math.sin(th)).toFixed(1));
    sun.setAttribute('opacity', night ? '0.3' : '1');

    byId('sun-rise').innerHTML = formatTime(sr);
    byId('sun-set').innerHTML = formatTime(ss);
  }

  function renderHourly(hourly) {
    if (!hourly || !hourly.length) { return; }

    // Precip probability strip — next 12 hours.
    var precip = byId('precip-strip');
    if (precip) {
      var pcells = '';
      var pn = Math.min(12, hourly.length);
      for (var i = 0; i < pn; i++) {
        var h = hourly[i];
        var pp = toNum(h.precip_probability); if (pp === null) { pp = 0; }
        var lh = toNum(h.local_hour); var lbl = lh === null ? '' : hourLabel(lh);
        pcells += '<div class="hcell">' +
          '<div class="hbar-area"><div class="hbar" style="height:' + Math.max(2, pp) + '%;background-color:' + precipColor(pp) + '"></div></div>' +
          '<div class="hval">' + Math.round(pp) + '</div>' +
          '<div class="hlabel">' + lbl + '</div></div>';
      }
      precip.innerHTML = pcells;
    }

    // Temperature heat-strip — next 24 hours.
    var heat = byId('heat-strip');
    if (heat) {
      var hn = Math.min(24, hourly.length);
      var segs = '';
      var lo = null, hi = null;
      for (var j = 0; j < hn; j++) {
        var tc = toNum(hourly[j].air_temperature);
        var tf = tc === null ? null : cToF(tc);
        if (tf !== null) {
          if (lo === null || tf < lo) { lo = tf; }
          if (hi === null || tf > hi) { hi = tf; }
        }
        segs += '<span class="heatseg" style="background-color:' + tempColor(tf) + '"></span>';
      }
      heat.innerHTML = segs;

      // Sparse hour labels beneath the ribbon.
      var labels = byId('heat-labels');
      if (labels) {
        var marks = [0, 6, 12, 18, hn - 1];
        var lcells = '';
        for (var k = 0; k < marks.length; k++) {
          var idx = marks[k];
          if (idx < hn) {
            var mlh = toNum(hourly[idx].local_hour);
            lcells += '<span>' + (mlh === null ? '' : hourLabel(mlh)) + '</span>';
          }
        }
        labels.innerHTML = lcells;
      }

      var cap = byId('heat-caption');
      if (cap) {
        cap.innerHTML = (lo === null || hi === null) ? '&nbsp;'
          : ('Low ' + Math.round(lo) + '&deg; &middot; High ' + Math.round(hi) + '&deg;');
      }
    }

    renderHourlyStrip(hourly);
  }

  // F8: combined hourly strip — hour + weather icon + temp + precip% per cell,
  // horizontally scrollable. Reuses the F7 iconSvg() set. Only our own icon
  // constants and formatted numbers go into innerHTML (h.icon is used solely as
  // an ICONS lookup key), so there's no dynamic-string injection here.
  function renderHourlyStrip(hourly) {
    var strip = byId('hourly-strip');
    if (!strip || !hourly || !hourly.length) { return; }
    var n = Math.min(24, hourly.length);
    var cells = '';
    for (var i = 0; i < n; i++) {
      var h = hourly[i];
      var lh = toNum(h.local_hour);
      var lbl = lh === null ? '' : hourLabel(lh);
      var tc = toNum(h.air_temperature);
      var tf = tc === null ? null : Math.round(cToF(tc));
      var pp = toNum(h.precip_probability); if (pp === null) { pp = 0; }
      var showPp = pp >= 5;
      cells += '<div class="fcell">' +
        '<div class="fhour">' + lbl + '</div>' +
        '<div class="ficon">' + iconSvg(h.icon ? String(h.icon) : '', 34) + '</div>' +
        '<div class="ftemp">' + (tf === null ? '&mdash;' : tf + '&deg;') + '</div>' +
        '<div class="fprecip" style="color:' + (showPp ? precipColor(pp) : 'transparent') + '">' +
          (showPp ? Math.round(pp) + '%' : '0') + '</div>' +
        '</div>';
    }
    strip.innerHTML = cells;
  }

  // F9: multi-day forecast — a row of upcoming days (icon + hi/lo + precip%)
  // from forecast.daily[]. Weekday derived from day_start_local (local midnight
  // epoch) via the DOW array. Same iOS-10-safe innerHTML story as the hourly
  // strip: only whitelisted icon markup and formatted numbers.
  function renderDaily(daily) {
    var strip = byId('daily-strip');
    if (!strip || !daily || !daily.length) { return; }
    var n = Math.min(8, daily.length);
    var cells = '';
    for (var i = 0; i < n; i++) {
      var d = daily[i];
      var ds = toNum(d.day_start_local);
      var lbl = (ds === null) ? '' : (i === 0 ? 'Today' : DOW[new Date(ds * 1000).getDay()]);
      var hiC = toNum(d.air_temp_high); var hi = hiC === null ? null : Math.round(cToF(hiC));
      var loC = toNum(d.air_temp_low); var lo = loC === null ? null : Math.round(cToF(loC));
      var pp = toNum(d.precip_probability); if (pp === null) { pp = 0; }
      var showPp = pp >= 5;
      cells += '<div class="dcell">' +
        '<div class="fhour">' + lbl + '</div>' +
        '<div class="ficon">' + iconSvg(d.icon ? String(d.icon) : '', 34) + '</div>' +
        '<div class="dtemps"><span class="dhi">' + (hi === null ? '&mdash;' : hi + '&deg;') + '</span> ' +
          '<span class="dlo">' + (lo === null ? '&mdash;' : lo + '&deg;') + '</span></div>' +
        '<div class="fprecip" style="color:' + (showPp ? precipColor(pp) : 'transparent') + '">' +
          (showPp ? Math.round(pp) + '%' : '0') + '</div>' +
        '</div>';
    }
    strip.innerHTML = cells;
  }

  function hourLabelLong(lh) {
    var ap = lh < 12 ? 'AM' : 'PM';
    var h = lh % 12; if (h === 0) { h = 12; }
    return h + ' ' + ap;
  }

  // Scan the next ~12 hours of precip probability into a plain-English clause.
  function rainOutlook(hourly) {
    if (!hourly || !hourly.length) { return ''; }
    var n = Math.min(12, hourly.length);
    var firstLikely = -1, anyChance = false;
    for (var i = 0; i < n; i++) {
      var pp = toNum(hourly[i].precip_probability); if (pp === null) { pp = 0; }
      if (pp >= 50 && firstLikely < 0) { firstLikely = i; }
      if (pp >= 30) { anyChance = true; }
    }
    if (firstLikely === 0) { return 'Rain likely now.'; }
    if (firstLikely > 0) {
      var lh = toNum(hourly[firstLikely].local_hour);
      return lh === null ? 'Rain likely soon.' : ('Rain likely around ' + hourLabelLong(lh) + '.');
    }
    if (anyChance) { return 'A chance of showers later.'; }
    return '';
  }

  // Synthesize a one-line summary from the forecast's current conditions + outlook.
  /* ---------- F7: weather icons (inline SVG, iOS10-safe) ---------- */
  // Hand-drawn icon set for the better_forecast `icon` keys. One 64x64 grid, a
  // few reused atoms, solid fills only — no gradients/filters/masks/<use>/
  // transforms — so old WebKit renders them reliably. Sun/moon are concatenated
  // BEFORE the cloud so paint order masks the "peek"; do not reorder the atoms.
  var IC_CLOUD = '<path fill="#eaf1f8" d="M18 45 A8.1 8.1 0 0 1 18 29 A13.2 13.2 0 0 1 44 29 A8.1 8.1 0 0 1 44 45 Z"/>';
  var IC_CLOUD_HI = '<path fill="#eaf1f8" d="M18 39 A8.1 8.1 0 0 1 18 23 A13.2 13.2 0 0 1 44 23 A8.1 8.1 0 0 1 44 39 Z"/>';
  var IC_BACKCLOUD = '<path fill="#9fb3c8" d="M30 27 A6.4 6.4 0 0 1 30 14.6 A10.4 10.4 0 0 1 50.3 14.6 A6.4 6.4 0 0 1 50.3 27 Z"/>';
  var IC_MOON = '<path fill="#cfe2ff" d="M44 20 A15 15 0 1 0 44 44 A12.2 12.2 0 0 1 44 20 Z"/>';
  var IC_MOON_A = '<path fill="#cfe2ff" d="M29.6 10.6 A9.3 9.3 0 1 0 29.6 25.4 A7.6 7.6 0 0 1 29.6 10.6 Z"/>';
  var IC_MOON_B = '<path fill="#cfe2ff" d="M24.6 7.6 A9.3 9.3 0 1 0 24.6 22.4 A7.6 7.6 0 0 1 24.6 7.6 Z"/>';
  var IC_SUN = '<circle cx="32" cy="32" r="13" fill="#ffd23f"/><path d="M32 14 L32 8 M44.5 19.5 L49 15 M50 32 L56 32 M44.5 44.5 L49 49 M32 50 L32 56 M19.5 44.5 L15 49 M14 32 L8 32 M19.5 19.5 L15 15" fill="none" stroke="#ffd23f" stroke-width="4.5" stroke-linecap="round"/>';
  var IC_SUN_A = '<circle cx="23" cy="19" r="7" fill="#ffd23f"/><path d="M23 9 L23 5.5 M30 12 L32.5 9.5 M33 19 L36.5 19 M30 26 L32.5 28.5 M23 29 L23 32.5 M16 26 L13.5 28.5 M13 19 L9.5 19 M16 12 L13.5 9.5" fill="none" stroke="#ffd23f" stroke-width="3.5" stroke-linecap="round"/>';
  var IC_SUN_B = '<circle cx="20" cy="16" r="7" fill="#ffd23f"/><path d="M20 6 L20 2.5 M27 9 L29.5 6.5 M30 16 L33.5 16 M27 23 L29.5 25.5 M20 26 L20 29.5 M13 23 L10.5 25.5 M10 16 L6.5 16 M13 9 L10.5 6.5" fill="none" stroke="#ffd23f" stroke-width="3.5" stroke-linecap="round"/>';
  var IC_STARS = '<circle cx="51" cy="15" r="2.2" fill="#eaf1f8"/><circle cx="14" cy="49" r="1.8" fill="#eaf1f8"/>';
  var IC_RAIN3 = '<path d="M23 43 L20 53 M33 43 L30 53 M43 43 L40 53" fill="none" stroke="#6fb2ff" stroke-width="4" stroke-linecap="round"/>';
  var IC_RAIN2 = '<path d="M27 43 L24 52 M39 43 L36 52" fill="none" stroke="#6fb2ff" stroke-width="4" stroke-linecap="round"/>';
  var IC_SNOW3 = '<path d="M21 43 L21 51 M17.5 45 L24.5 49 M17.5 49 L24.5 45 M32 49 L32 57 M28.5 51 L35.5 55 M28.5 55 L35.5 51 M43 43 L43 51 M39.5 45 L46.5 49 M39.5 49 L46.5 45" fill="none" stroke="#eaf1f8" stroke-width="2.5" stroke-linecap="round"/>';
  var IC_SNOW2 = '<path d="M26 44 L26 52 M22.5 46 L29.5 50 M22.5 50 L29.5 46 M38 44 L38 52 M34.5 46 L41.5 50 M34.5 50 L41.5 46" fill="none" stroke="#eaf1f8" stroke-width="2.5" stroke-linecap="round"/>';
  var IC_SLEET_F = '<path d="M22 43 L19 53 M42 43 L39 53 M32 47 L32 55 M28.5 49 L35.5 53 M28.5 53 L35.5 49" fill="none" stroke="#6fb2ff" stroke-width="3.5" stroke-linecap="round"/>';
  var IC_SLEET_L = '<path d="M25 43 L22 52 M38 45 L38 53 M34.5 47 L41.5 51 M34.5 51 L41.5 47" fill="none" stroke="#6fb2ff" stroke-width="3.5" stroke-linecap="round"/>';
  var IC_BOLT = '<polygon points="35,35 24,47 31,47 28,57 41,44 33,44" fill="#ffd23f"/>';
  var IC_TSTREAK = '<path d="M17 42 L14 50 M47 42 L44 50" fill="none" stroke="#6fb2ff" stroke-width="4" stroke-linecap="round"/>';
  var IC_FOG = '<path d="M12 46 L50 46 M20 54 L46 54" fill="none" stroke="#9fb3c8" stroke-width="4.5" stroke-linecap="round"/>';
  var IC_WIND = '<path d="M8 25 L38 25 C45 25 46 15 39 15 M8 35 L46 35 C54 35 55 45 47 45" fill="none" stroke="#eaf1f8" stroke-width="4.5" stroke-linecap="round"/><path d="M10 45 L26 45" fill="none" stroke="#9fb3c8" stroke-width="4.5" stroke-linecap="round"/>';

  var ICONS = {
    'clear-day': IC_SUN,
    'clear-night': IC_MOON + IC_STARS,
    'cloudy': IC_BACKCLOUD + IC_CLOUD,
    'foggy': IC_CLOUD_HI + IC_FOG,
    'partly-cloudy-day': IC_SUN_A + IC_CLOUD,
    'partly-cloudy-night': IC_MOON_A + IC_CLOUD,
    'possibly-rainy-day': IC_SUN_B + IC_CLOUD_HI + IC_RAIN2,
    'possibly-rainy-night': IC_MOON_B + IC_CLOUD_HI + IC_RAIN2,
    'possibly-sleet-day': IC_SUN_B + IC_CLOUD_HI + IC_SLEET_L,
    'possibly-sleet-night': IC_MOON_B + IC_CLOUD_HI + IC_SLEET_L,
    'possibly-snow-day': IC_SUN_B + IC_CLOUD_HI + IC_SNOW2,
    'possibly-snow-night': IC_MOON_B + IC_CLOUD_HI + IC_SNOW2,
    'possibly-thunderstorm-day': IC_SUN_B + IC_CLOUD_HI + IC_BOLT,
    'possibly-thunderstorm-night': IC_MOON_B + IC_CLOUD_HI + IC_BOLT,
    'rainy': IC_CLOUD_HI + IC_RAIN3,
    'sleet': IC_CLOUD_HI + IC_SLEET_F,
    'snow': IC_CLOUD_HI + IC_SNOW3,
    'thunderstorm': IC_CLOUD_HI + IC_BOLT + IC_TSTREAK,
    'windy': IC_WIND
  };

  // Return a self-contained <svg> string for an icon key. Unknown/missing keys
  // fall back to 'cloudy' — neutral, asserts no sun/moon or precipitation.
  // Explicit width/height on the <svg> keeps old Safari from mis-sizing it.
  function iconSvg(key, px) {
    var inner = ICONS[key];
    if (!inner) { inner = ICONS.cloudy; }
    var size = px || 64;
    return '<svg viewBox="0 0 64 64" width="' + size + '" height="' + size + '">' + inner + '</svg>';
  }

  // Current-conditions hero: icon + words on the right of the temperature tile.
  function renderConditions(cc) {
    var wrap = byId('hero-cond');
    var iconEl = byId('cond-icon');
    var textEl = byId('cond-text');
    if (!wrap || !iconEl || !textEl) { return; }
    if (!cc) { wrap.style.display = 'none'; return; }
    iconEl.innerHTML = iconSvg(cc.icon ? String(cc.icon) : '', 64);
    // Plain text from the API -> textContent (not innerHTML) so a condition
    // string can never inject markup. ' ' is a non-breaking space.
    textEl.textContent = cc.conditions ? String(cc.conditions) : ' ';
    wrap.style.display = '';
  }

  function renderSummary(data) {
    var el = byId('summary');
    if (!el) { return; }
    var cc = data.current_conditions;
    if (!cc) { el.innerHTML = '&nbsp;'; return; }

    var s = cc.conditions ? String(cc.conditions) : '';
    var tF = toNum(cc.air_temperature);
    if (tF !== null) { s += (s ? ', ' : '') + Math.round(cToF(tF)) + '°'; }

    var dp = toNum(cc.dew_point);
    if (dp !== null) {
      var dF = cToF(dp);
      if (dF >= 60) { s += ' and ' + comfortWord(dF).toLowerCase(); }
    }
    if (s) { s += '.'; }

    var g = toNum(cc.wind_gust);
    if (g !== null) {
      var gm = mpsToMph(g);
      if (gm >= 30) { s += ' Windy.'; }
      else if (gm >= 18) { s += ' Breezy.'; }
    }

    var ro = data.forecast ? rainOutlook(data.forecast.hourly) : '';
    if (ro) { s += ' ' + ro; }

    el.innerHTML = s || '&nbsp;';
  }

  /* ---------- Air quality (Open-Meteo US AQI) ---------- */
  // Tempest hardware has no air sensors, so AQI comes from Open-Meteo (free, no
  // key, CORS-enabled) queried by the station's lat/lon.

  // Sub-AQI field -> short pollutant label, for the "dominant pollutant" note.
  var AQI_POLL = {
    us_aqi_pm2_5: 'PM2.5',
    us_aqi_pm10: 'PM10',
    us_aqi_ozone: 'Ozone',
    us_aqi_nitrogen_dioxide: 'NO₂',
    us_aqi_sulphur_dioxide: 'SO₂',
    us_aqi_carbon_monoxide: 'CO'
  };

  // US EPA AQI category for a value -> label + color class.
  function aqiCategory(aqi) {
    if (aqi <= 50) { return { label: 'Good', cls: 'aqi-good' }; }
    if (aqi <= 100) { return { label: 'Moderate', cls: 'aqi-mod' }; }
    if (aqi <= 150) { return { label: 'Unhealthy for Sensitive', cls: 'aqi-usg' }; }
    if (aqi <= 200) { return { label: 'Unhealthy', cls: 'aqi-unhealthy' }; }
    if (aqi <= 300) { return { label: 'Very Unhealthy', cls: 'aqi-vhigh' }; }
    return { label: 'Hazardous', cls: 'aqi-hazardous' };
  }

  function renderAirQuality(data) {
    var valEl = byId('v-aqi');
    var catEl = byId('v-aqi-cat');
    var mk = byId('aqibar-marker');
    if (!valEl || !catEl) { return; }

    var cur = data && data.current;
    var aqi = cur ? toNum(cur.us_aqi) : null;
    if (aqi === null) {
      valEl.innerHTML = '&mdash;';
      valEl.className = 'tile-value';
      catEl.innerHTML = '&nbsp;';
      if (mk) { mk.style.display = 'none'; }
      setAlert('tile-aqi', false);
      return;
    }

    aqi = Math.round(aqi);
    var c = aqiCategory(aqi);
    valEl.innerHTML = String(aqi);
    valEl.className = 'tile-value ' + c.cls;

    // Dominant pollutant = the component whose sub-AQI drives the overall value.
    var domKey = null, domVal = -1, k;
    for (k in AQI_POLL) {
      if (AQI_POLL.hasOwnProperty(k)) {
        var v = toNum(cur[k]);
        if (v !== null && v > domVal) { domVal = v; domKey = k; }
      }
    }
    var dom = domKey ? (' &middot; ' + AQI_POLL[domKey]) : '';
    catEl.innerHTML = '<span class="' + c.cls + '">' + c.label + '</span>' + dom;

    if (mk) {
      var posp = aqi; if (posp > 500) { posp = 500; } if (posp < 0) { posp = 0; }
      mk.style.left = (posp / 500 * 100) + '%';
      mk.style.display = '';
    }

    setAlert('tile-aqi', aqi > ALERT_AQI);
  }

  /* ---------- Weather alerts (NWS active alerts) ---------- */
  // Official watches/warnings/advisories (flood, severe storm, air quality, …)
  // from the free api.weather.gov, queried by the station point. Shown in a
  // banner above the tiles, colored by the most severe active alert.

  function sevRank(s) {
    s = (s || '').toLowerCase();
    if (s === 'extreme') { return 4; }
    if (s === 'severe') { return 3; }
    if (s === 'moderate') { return 2; }
    if (s === 'minor') { return 1; }
    return 0; // Unknown
  }
  function sevClass(rank) {
    if (rank >= 3) { return 'alert-extreme'; }
    if (rank === 2) { return 'alert-moderate'; }
    if (rank === 1) { return 'alert-minor'; }
    return 'alert-unknown';
  }

  // ISO timestamp -> friendly local "h:mm AM/PM" (empty string if unparseable).
  function fmtAlertTime(iso) {
    if (!iso) { return ''; }
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return ''; }
    var h = d.getHours(), m = d.getMinutes();
    var ap = h >= 12 ? 'PM' : 'AM';
    var hh = h % 12; if (hh === 0) { hh = 12; }
    return hh + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
  }

  // NWS areaDesc is a long "A; B; C; …" list; show the first couple for context.
  function firstAreas(s) {
    if (!s) { return ''; }
    var parts = s.split(';'), out = [];
    for (var i = 0; i < parts.length && out.length < 2; i++) {
      var t = parts[i].replace(/^\s+|\s+$/g, '');
      if (t) { out.push(t); }
    }
    return out.join(', ');
  }

  // The alert's areaDesc segments run parallel to geocode.UGC; pick the segment
  // whose zone/county code matches THIS location, so a multi-zone alert shows the
  // local area (e.g. "Southern New London") rather than a far-off zone.
  function localArea(p) {
    if (!stationPlace) { return ''; }
    var codes = (p.geocode && p.geocode.UGC) || [];
    var names = (p.areaDesc || '').split(';');
    for (var i = 0; i < codes.length && i < names.length; i++) {
      if (codes[i] === stationPlace.zone || codes[i] === stationPlace.county) {
        return names[i].replace(/^\s+|\s+$/g, '');
      }
    }
    return '';
  }

  function renderAlerts(data) {
    var banner = byId('alerts-banner');
    if (!banner) { return; }

    var feats = (data && data.features) || [];
    var seen = {}, items = [], topRank = -1, i;
    for (i = 0; i < feats.length; i++) {
      var p = feats[i].properties || {};
      if (p.status && p.status !== 'Actual') { continue; }
      if (p.messageType === 'Cancel') { continue; }
      var ev = p.event || 'Weather Alert';
      if (seen[ev]) { continue; } // collapse repeated same-event alerts
      seen[ev] = true;
      var rank = sevRank(p.severity);
      if (rank > topRank) { topRank = rank; }
      items.push({
        event: ev, rank: rank, expires: p.expires || p.ends,
        area: p.areaDesc || '', local: localArea(p)
      });
    }

    if (!items.length) {
      banner.style.display = 'none';
      banner.className = 'alerts-banner';
      banner.innerHTML = '';
      return;
    }

    items.sort(function (a, b) { return b.rank - a.rank; }); // worst first

    // Build via DOM + textContent so alert text can never inject markup.
    banner.innerHTML = '';
    banner.className = 'alerts-banner ' + sevClass(topRank);

    var head = document.createElement('div');
    head.className = 'alerts-head';
    head.innerHTML = '&#9888; '; // warning triangle (static markup)
    var hs = document.createElement('span');
    hs.textContent = items.length === 1 ? '1 active alert' : (items.length + ' active alerts');
    head.appendChild(hs);
    banner.appendChild(head);

    for (i = 0; i < items.length; i++) {
      var it = items[i];
      var row = document.createElement('div');
      row.className = 'alert-item ' + sevClass(it.rank);

      var evEl = document.createElement('div');
      evEl.className = 'alert-event';
      evEl.textContent = it.event;
      row.appendChild(evEl);

      var meta = document.createElement('div');
      meta.className = 'alert-meta';
      var until = fmtAlertTime(it.expires);
      var area = it.local || firstAreas(it.area);
      var metaTxt = until ? ('Until ' + until) : '';
      if (area) { metaTxt += (metaTxt ? ' · ' : '') + area; }
      meta.textContent = metaTxt || ' ';
      row.appendChild(meta);

      banner.appendChild(row);
    }

    banner.style.display = '';
  }

  function renderForecast(data) {
    if (!data) { return; }
    captureCoords(data);
    renderSummary(data);
    renderConditions(data.current_conditions);
    if (!data.forecast) { return; }
    if (data.forecast.daily && data.forecast.daily.length) {
      renderSunArc(data.forecast.daily[0]);
      renderDaily(data.forecast.daily);
    }
    renderHourly(data.forecast.hourly);
  }

  // Map the pressure_trend string ("rising"/"falling"/"steady") to a colored
  // arrow + label. Storm-watchers care about this more than the number itself.
  function renderPressureTrend(trend) {
    var el = byId('v-pressure-trend');
    if (!el) { return; }
    var t = trend ? String(trend).toLowerCase() : '';
    var arrow, label, cls;
    if (t.indexOf('ris') !== -1) { arrow = '↑'; label = 'RISING'; cls = 'trend-up'; }
    else if (t.indexOf('fall') !== -1) { arrow = '↓'; label = 'FALLING'; cls = 'trend-down'; }
    else if (t.indexOf('stead') !== -1) { arrow = '→'; label = 'STEADY'; cls = 'trend-flat'; }
    else { el.innerHTML = '&nbsp;'; return; }
    el.innerHTML = '<span class="' + cls + '"><span class="trend-arrow">' + arrow + '</span> ' + label + '</span>';
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* ---------- Header clock ---------- */

  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function updateClock() {
    var d = new Date();
    var t = byId('clock-time');
    var dt = byId('clock-date');
    if (t) { t.innerHTML = formatTime(d.getTime() / 1000); }
    if (dt) { dt.innerHTML = DOW[d.getDay()] + ', ' + MON[d.getMonth()] + ' ' + d.getDate(); }
    // Re-evaluate the day/night theme as time passes (crossing dawn/dusk).
    if (sunTimes) { applyTheme(sunTimes.sr, sunTimes.ss); }
  }

  /* ---------- Day/night theme ---------- */

  // Choose a background phase from the sun times, with a ~40 min warm window
  // around sunrise (dawn) and sunset (dusk).
  function applyTheme(sr, ss) {
    var app = byId('app');
    if (!app || sr === null || ss === null) { return; }
    var now = new Date().getTime() / 1000;
    var W = 40 * 60;
    var cls;
    if (now < sr - W || now > ss + W) { cls = 'theme-night'; }
    else if (now < sr + W) { cls = 'theme-dawn'; }
    else if (now > ss - W) { cls = 'theme-dusk'; }
    else { cls = 'theme-day'; }
    if (app.className !== cls) { app.className = cls; }
  }

  function formatTime(epochSeconds) {
    var d = new Date(Number(epochSeconds) * 1000);
    var h = d.getHours();
    var ampm = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12; if (h12 === 0) { h12 = 12; }
    return h12 + ':' + pad2(d.getMinutes()) + ' ' + ampm;
  }

  /* ---------- F10: observation history (localStorage ring buffer) ---------- */
  // A rolling client-side record so F11+ (sparklines, observed hi/lo, wind rose)
  // have data to draw. Zero extra API calls — we just capture each obs we already
  // poll. Tuples are lean + numeric to keep localStorage (shared with the token)
  // small: [ts(sec), tempC, pressureMb, windDirDeg, windAvgMps].

  function loadHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) { return []; }
      var arr = JSON.parse(raw);
      return (arr && arr.length) ? arr : [];
    } catch (e) { return []; }
  }

  function saveHistory(arr) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(arr));
    } catch (e) {
      // Quota (or old-Safari Private Mode, where setItem throws). Shed the oldest
      // half and try once more so we degrade instead of losing all history.
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(Math.floor(arr.length / 2)))); }
      catch (e2) {}
    }
  }

  function round1(v) { return v === null ? null : Math.round(v * 10) / 10; }

  // Append one observation, deduped by timestamp, capped to a ring buffer.
  function recordHistory(o) {
    if (!o) { return; }
    var ts = toNum(o.timestamp);
    if (ts === null) { return; }

    var hist = loadHistory();
    // Same observation re-rendered (e.g. a foreground refresh): don't duplicate.
    if (hist.length && hist[hist.length - 1][0] === ts) { return; }

    var press = toNum(o.sea_level_pressure);
    if (press === null) { press = toNum(o.barometric_pressure); }
    if (press === null) { press = toNum(o.station_pressure); }

    hist.push([
      ts,
      round1(toNum(o.air_temperature)),
      round1(press),
      (toNum(o.wind_direction) === null) ? null : Math.round(toNum(o.wind_direction)),
      round1(toNum(o.wind_avg))
    ]);
    if (hist.length > HISTORY_MAX) { hist = hist.slice(hist.length - HISTORY_MAX); }
    saveHistory(hist);
  }

  /* ---------- F15: last-known payload cache ---------- */
  // iOS 10.3.3 has no Service Worker, so we can't truly cache offline. Instead we
  // stash the last successful obs + forecast JSON in localStorage and repaint it
  // on load before the network returns — instant display, and the wall panel
  // still shows the last reading through a dropped connection.

  function saveLast(key, data) {
    try { localStorage.setItem(key, JSON.stringify(data)); } catch (e) {}
  }

  function renderCached() {
    try {
      var o = localStorage.getItem(LAST_OBS_KEY);
      if (o) { render(JSON.parse(o)); }
    } catch (e) {}
    try {
      var f = localStorage.getItem(LAST_FC_KEY);
      if (f) { renderForecast(JSON.parse(f)); }
    } catch (e) {}
    try {
      var a = localStorage.getItem(LAST_AQI_KEY);
      if (a) { renderAirQuality(JSON.parse(a)); }
    } catch (e) {}
    try {
      var al = localStorage.getItem(LAST_ALERTS_KEY);
      if (al) { renderAlerts(JSON.parse(al)); }
    } catch (e) {}
  }

  /* ---------- F11/F12: sparklines from history ---------- */

  var SPARK_WINDOW_SEC = 6 * 3600; // show roughly the last 6 hours
  var SPARK_MAX_PTS = 60;          // downsample target for a light polyline

  // Collect recent values at tuple index `idx`, within the trailing window.
  function recentSeries(hist, idx) {
    var cutoff = (new Date().getTime() / 1000) - SPARK_WINDOW_SEC;
    var vals = [];
    for (var i = 0; i < hist.length; i++) {
      var v = hist[i][idx];
      if (hist[i][0] >= cutoff && v !== null && v !== undefined) { vals.push(v); }
    }
    return vals;
  }

  // Draw a min/max-scaled <polyline> sparkline into `el`. Clears when there
  // aren't yet 2 points. Y auto-scales to the series range (essential for
  // pressure's narrow band); a flat series draws as a centered line.
  function renderSparkline(el, values, color) {
    if (!el) { return; }
    var pts = values;
    if (!pts || pts.length < 2) { el.innerHTML = ''; return; }

    if (pts.length > SPARK_MAX_PTS) {
      var ds = [];
      var step = pts.length / SPARK_MAX_PTS;
      for (var k = 0; k < SPARK_MAX_PTS; k++) { ds.push(pts[Math.floor(k * step)]); }
      ds.push(pts[pts.length - 1]);
      pts = ds;
    }

    var lo = pts[0], hi = pts[0];
    for (var m = 1; m < pts.length; m++) {
      if (pts[m] < lo) { lo = pts[m]; }
      if (pts[m] > hi) { hi = pts[m]; }
    }
    var flat = (hi - lo) <= 0;         // steady series (common for pressure)
    var span = flat ? 1 : (hi - lo);

    var W = 100, H = 30, PAD = 3;
    var coords = '';
    for (var j = 0; j < pts.length; j++) {
      var norm = flat ? 0.5 : (pts[j] - lo) / span; // center a flat line
      var x = PAD + (j / (pts.length - 1)) * (W - 2 * PAD);
      var y = PAD + (1 - norm) * (H - 2 * PAD);
      coords += (j ? ' ' : '') + (Math.round(x * 10) / 10) + ',' + (Math.round(y * 10) / 10);
    }
    // preserveAspectRatio="none" stretches to the tile width; non-scaling-stroke
    // keeps the line an even weight (a no-op fallback on engines that lack it).
    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" class="spark-svg">' +
      '<polyline points="' + coords + '" fill="none" stroke="' + color + '" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>';
  }

  // F11 temperature (tuple idx 1) + F12 pressure (idx 2) trend lines.
  function renderTrends() {
    var hist = loadHistory();
    renderSparkline(byId('temp-spark'), recentSeries(hist, 1), '#ff9d5c');
    renderSparkline(byId('pressure-spark'), recentSeries(hist, 2), '#6fb2ff');
  }

  // F13: today's OBSERVED high/low (from history since local midnight) — distinct
  // from the forecast hi/lo. Includes the latest reading (just recorded).
  function renderObservedHiLo() {
    var el = byId('v-hilo');
    if (!el) { return; }
    var midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    var dayStart = midnight.getTime() / 1000;
    var hist = loadHistory();
    var lo = null, hi = null;
    for (var i = 0; i < hist.length; i++) {
      if (hist[i][0] < dayStart) { continue; }
      var tc = hist[i][1];
      if (tc === null || tc === undefined) { continue; }
      var tf = cToF(tc);
      if (lo === null || tf < lo) { lo = tf; }
      if (hi === null || tf > hi) { hi = tf; }
    }
    if (lo === null) { el.innerHTML = '&nbsp;'; return; }
    el.innerHTML = 'Today <span class="hilo-hi">&uarr;' + Math.round(hi) + '&deg;</span> ' +
      '<span class="hilo-lo">&darr;' + Math.round(lo) + '&deg;</span>';
  }

  /* ---------- F14: wind rose ---------- */

  // Point on a compass circle: deg measured clockwise from North (up).
  function rosePoint(cx, cy, r, deg) {
    var t = deg * Math.PI / 180;
    return {
      x: Math.round((cx + r * Math.sin(t)) * 100) / 100,
      y: Math.round((cy - r * Math.cos(t)) * 100) / 100
    };
  }

  function roseColor(frac) {
    if (frac < 0.34) { return '#3f6b8f'; }
    if (frac < 0.67) { return '#4a9fd0'; }
    return '#6fb2ff';
  }

  // Polar plot of which directions the wind has blown FROM, weighted by speed.
  // Bins history's wind_direction into 8 sectors, sums wind_avg per sector, and
  // draws one SVG wedge per sector with length scaled to the busiest sector.
  function renderWindRose() {
    var el = byId('windrose');
    if (!el) { return; }
    var hist = loadHistory();
    var SECTORS = 8;
    var sums = [0, 0, 0, 0, 0, 0, 0, 0];
    var any = false;
    for (var i = 0; i < hist.length; i++) {
      var dir = hist[i][3], spd = hist[i][4];
      if (dir === null || dir === undefined || spd === null || spd === undefined || spd <= 0) { continue; }
      var s = Math.round(dir / 45) % SECTORS; if (s < 0) { s += SECTORS; }
      sums[s] += spd;
      any = true;
    }
    if (!any) { el.innerHTML = '<div class="rose-empty">Gathering wind history&hellip;</div>'; return; }

    var max = 0;
    for (var m = 0; m < SECTORS; m++) { if (sums[m] > max) { max = sums[m]; } }
    if (max <= 0) { max = 1; }

    var cx = 50, cy = 50, rmax = 42;
    var wedges = '';
    for (var k = 0; k < SECTORS; k++) {
      if (sums[k] <= 0) { continue; }
      var r = 9 + (sums[k] / max) * (rmax - 9); // min stub so small sectors show
      var p0 = rosePoint(cx, cy, r, k * 45 - 22.5);
      var p1 = rosePoint(cx, cy, r, k * 45 + 22.5);
      wedges += '<path d="M' + cx + ' ' + cy + ' L' + p0.x + ' ' + p0.y +
        ' A' + r + ' ' + r + ' 0 0 1 ' + p1.x + ' ' + p1.y + ' Z" fill="' + roseColor(sums[k] / max) + '"/>';
    }
    el.innerHTML = '<svg viewBox="0 0 100 100" class="rose-svg">' +
      '<circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1"></circle>' +
      '<circle cx="50" cy="50" r="21" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"></circle>' +
      wedges +
      '<text x="50" y="13" text-anchor="middle" font-size="9" fill="#9fb3c8">N</text>' +
      '<text x="89" y="53" text-anchor="middle" font-size="8" fill="#7f96ac">E</text>' +
      '<text x="50" y="95" text-anchor="middle" font-size="8" fill="#7f96ac">S</text>' +
      '<text x="11" y="53" text-anchor="middle" font-size="8" fill="#7f96ac">W</text>' +
      '</svg>';
  }

  /* ---------- rendering ---------- */

  function render(data) {
    setError('');

    captureCoords(data);
    fetchPlace();
    maybeFetchAqi();
    maybeFetchAlerts();

    if (data && data.station_name) {
      byId('station-name').innerHTML = data.station_name;
    }

    if (!data || !data.obs || !data.obs.length) {
      setStatus('No recent observation');
      setError('The station returned no observation data yet. It may be offline or newly set up.');
      return;
    }

    var o = data.obs[0];
    recordHistory(o);
    renderTrends();
    renderObservedHiLo();
    renderWindRose();

    byId('v-temp').innerHTML = fmt(o.air_temperature, cToF, 0, '&deg;');
    byId('v-feels').innerHTML = fmt(o.feels_like, cToF, 0, '&deg;');
    byId('v-humidity').innerHTML = fmt(o.relative_humidity, null, 0, '%');
    byId('v-dewpoint').innerHTML = fmt(o.dew_point, cToF, 0, '&deg;');
    renderComfort(o.dew_point);
    byId('v-wind').innerHTML = fmt(o.wind_avg, mpsToMph, 1, ' mph');
    byId('v-gust').innerHTML = fmt(o.wind_gust, mpsToMph, 1, ' mph');

    var card = o.wind_direction_cardinal || cardinal(o.wind_direction);
    var deg = (o.wind_direction === null || o.wind_direction === undefined)
      ? '' : (' ' + Math.round(Number(o.wind_direction)) + '&deg;');
    byId('v-winddir').innerHTML = card ? (card + deg) : (deg || '&mdash;');

    renderWindBar(mpsToMphN(o.wind_avg), mpsToMphN(o.wind_gust), mpsToMphN(o.wind_lull));
    renderCompass(toNum(o.wind_direction));

    // Prefer sea-level pressure; fall back to station/barometric pressure.
    var pressure = (o.sea_level_pressure !== undefined && o.sea_level_pressure !== null)
      ? o.sea_level_pressure
      : (o.barometric_pressure !== undefined ? o.barometric_pressure : o.station_pressure);
    byId('v-pressure').innerHTML = fmt(pressure, mbToInHg, 2, ' inHg');
    renderPressureTrend(o.pressure_trend);

    renderRain(o);
    renderUV(o.uv);
    renderLightning(o);
    applyAlerts(o);

    // timestamp / staleness
    var stamp = o.timestamp;
    if (stamp) {
      var ageMs = (new Date().getTime()) - (Number(stamp) * 1000);
      var stale = ageMs > STALE_MS;
      byId('updated-line').innerHTML = 'Observed ' + formatTime(stamp);
      byId('status-line').className = stale ? 'status-line is-stale' : 'status-line';
      setStatus(stale ? 'Data may be stale' : 'Up to date');
      if (stale) {
        setError('This observation is more than 15 minutes old. Your station may be offline.');
      }
    } else {
      byId('updated-line').innerHTML = '&nbsp;';
      setStatus('Up to date');
    }
  }

  /* ---------- data fetch ---------- */

  function buildUrl(token, station) {
    // The obs array is always metric; we convert to imperial in render().
    return 'https://swd.weatherflow.com/swd/rest/observations/station/' + encodeURIComponent(station) +
      '?token=' + encodeURIComponent(token);
  }

  function fetchData() {
    var token = getToken();
    var station = getStation();
    if (!token || !station) { showSetup(); return; }

    setStatus('Updating&hellip;');

    var xhr = new XMLHttpRequest();
    xhr.open('GET', buildUrl(token, station), true);
    xhr.timeout = 15000;

    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) { return; }

      if (xhr.status === 200) {
        var data = null;
        try { data = JSON.parse(xhr.responseText); }
        catch (e) { setStatus('Error'); setError('Received malformed data from the weather service.'); return; }
        saveLast(LAST_OBS_KEY, data);
        render(data);
      } else if (xhr.status === 401 || xhr.status === 403) {
        setStatus('Token rejected');
        setError('Your token was rejected. Open Settings to re-enter it.');
      } else if (xhr.status === 404) {
        setStatus('Not found');
        setError('Station ' + station + ' was not found. Check the Station ID in Settings.');
      } else if (xhr.status === 0) {
        setStatus('Offline');
        setError('Network error &mdash; check your internet connection.');
      } else {
        setStatus('Error');
        setError('Weather service error (HTTP ' + xhr.status + ').');
      }
    };

    xhr.ontimeout = function () {
      setStatus('Timed out');
      setError('The request timed out. Pull to refresh or tap Refresh.');
    };

    xhr.send();
  }

  function buildForecastUrl(token, station) {
    return 'https://swd.weatherflow.com/swd/rest/better_forecast?station_id=' + encodeURIComponent(station) +
      '&token=' + encodeURIComponent(token);
  }

  // Forecast is secondary: on any failure we quietly leave the forecast tiles
  // as-is rather than disturbing the primary observation display.
  function fetchForecast() {
    var token = getToken();
    var station = getStation();
    if (!token || !station) { return; }

    var xhr = new XMLHttpRequest();
    xhr.open('GET', buildForecastUrl(token, station), true);
    xhr.timeout = 15000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4 || xhr.status !== 200) { return; }
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
      saveLast(LAST_FC_KEY, data);
      renderForecast(data);
    };
    xhr.send();
  }

  function buildAqiUrl(lat, lon) {
    return 'https://air-quality-api.open-meteo.com/v1/air-quality' +
      '?latitude=' + encodeURIComponent(lat) +
      '&longitude=' + encodeURIComponent(lon) +
      '&current=us_aqi,us_aqi_pm2_5,us_aqi_pm10,us_aqi_ozone,' +
      'us_aqi_nitrogen_dioxide,us_aqi_sulphur_dioxide,us_aqi_carbon_monoxide' +
      '&timezone=auto';
  }

  // Air quality is a best-effort extra: on any failure we quietly leave the tile
  // as-is (no header-setting, so the request stays a simple CORS GET).
  function fetchAirQuality() {
    if (!stationCoords) { return; }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', buildAqiUrl(stationCoords.lat, stationCoords.lon), true);
    xhr.timeout = 15000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4 || xhr.status !== 200) { return; }
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
      saveLast(LAST_AQI_KEY, data);
      renderAirQuality(data);
    };
    xhr.send();
  }

  // Throttled: AQI changes hourly, so fetch at most every AQI_REFRESH_MS even
  // though render() (which calls this) runs on every observation tick.
  function maybeFetchAqi() {
    if (!stationCoords) { return; }
    var now = new Date().getTime();
    if (now - lastAqiAt < AQI_REFRESH_MS) { return; }
    lastAqiAt = now;
    fetchAirQuality();
  }

  function buildAlertsUrl(lat, lon) {
    // NWS rejects more than 4 decimal places on the point parameter.
    return 'https://api.weather.gov/alerts/active?point=' +
      Number(lat).toFixed(4) + ',' + Number(lon).toFixed(4);
  }

  // Last path segment of an NWS URL, e.g. ".../zones/forecast/CTZ012" -> "CTZ012".
  function lastPath(url) {
    if (!url) { return ''; }
    var parts = String(url).split('/');
    return parts[parts.length - 1];
  }

  // One-time NWS "points" lookup: which forecast zone/county this location is in,
  // so an alert can be labeled with the LOCAL area name (not the first zone in a
  // big multi-zone list). Cached per-device; place doesn't change.
  function fetchPlace() {
    if (!stationCoords || stationPlace) { return; }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://api.weather.gov/points/' +
      Number(stationCoords.lat).toFixed(4) + ',' + Number(stationCoords.lon).toFixed(4), true);
    xhr.timeout = 15000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4 || xhr.status !== 200) { return; }
      var d = null;
      try { d = JSON.parse(xhr.responseText); } catch (e) { return; }
      var p = d.properties || {};
      var rl = (p.relativeLocation && p.relativeLocation.properties) || {};
      stationPlace = {
        zone: lastPath(p.forecastZone),
        county: lastPath(p.county),
        city: rl.city || '',
        state: rl.state || ''
      };
      try { localStorage.setItem(PLACE_KEY, JSON.stringify(stationPlace)); } catch (e) {}
      // Re-label any cached alerts now that we know the local area.
      try {
        var al = localStorage.getItem(LAST_ALERTS_KEY);
        if (al) { renderAlerts(JSON.parse(al)); }
      } catch (e) {}
    };
    xhr.send();
  }

  // Best-effort like the forecast/AQI: no custom headers (a User-Agent header
  // would trip NWS's CORS preflight), so this stays a simple cross-origin GET.
  function fetchAlerts() {
    if (!stationCoords) { return; }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', buildAlertsUrl(stationCoords.lat, stationCoords.lon), true);
    xhr.timeout = 15000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4 || xhr.status !== 200) { return; }
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
      saveLast(LAST_ALERTS_KEY, data);
      renderAlerts(data);
    };
    xhr.send();
  }

  function maybeFetchAlerts() {
    if (!stationCoords) { return; }
    var now = new Date().getTime();
    if (now - lastAlertsAt < ALERTS_REFRESH_MS) { return; }
    lastAlertsAt = now;
    fetchAlerts();
  }

  // Fetch current conditions and forecast together.
  function refreshAll() {
    fetchData();
    fetchForecast();
  }

  /* ---------- auto refresh + watch mode ---------- */

  // Each periodic tick: while watching we pull observations only (the forecast
  // barely changes minute-to-minute and we don't want to hammer it).
  function refreshTick() {
    if (mode === MODE_WATCH) { fetchData(); }
    else { refreshAll(); }
  }

  function restartRefreshTimer() {
    if (refreshTimer) { clearInterval(refreshTimer); }
    var interval = (mode === MODE_WATCH) ? WATCH_REFRESH_MS : IDLE_REFRESH_MS;
    refreshTimer = setInterval(refreshTick, interval);
  }

  function startAutoRefresh() {
    mode = MODE_IDLE;
    restartRefreshTimer();
    updateWatchButton();
  }

  function stopAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    stopWatchCountdown();
    mode = MODE_IDLE;
    updateWatchButton();
  }

  function updateWatchButton() {
    var b = byId('watch-btn');
    if (!b) { return; }
    if (mode === MODE_WATCH) {
      b.className = 'btn btn-ghost btn-active';
      var rem = Math.ceil((watchEndsAt - new Date().getTime()) / 1000);
      if (rem < 0) { rem = 0; }
      var m = Math.floor(rem / 60);
      var s = rem % 60;
      b.innerHTML = 'Watching ' + m + ':' + (s < 10 ? '0' : '') + s;
    } else {
      b.className = 'btn btn-ghost';
      b.innerHTML = 'Watch';
    }
  }

  function startWatchCountdown() {
    stopWatchCountdown();
    watchTimer = setInterval(function () {
      if (new Date().getTime() >= watchEndsAt) { exitWatch(); }
      else { updateWatchButton(); }
    }, 1000);
  }
  function stopWatchCountdown() {
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  }

  function enterWatch() {
    mode = MODE_WATCH;
    watchEndsAt = new Date().getTime() + WATCH_DURATION_MS;
    restartRefreshTimer();
    startWatchCountdown();
    updateWatchButton();
    fetchData(); // immediate fresh pull on entering
  }

  function exitWatch() {
    mode = MODE_IDLE;
    stopWatchCountdown();
    restartRefreshTimer();
    updateWatchButton();
  }

  function toggleWatch() {
    if (mode === MODE_WATCH) { exitWatch(); }
    else { enterWatch(); }
  }

  /* ---------- Module show/hide (Customize mode) ---------- */
  // Each dashboard tile carries a data-mod key. The user hides/shows tiles in an
  // edit mode; the hidden set persists per-device in localStorage. Re-renders
  // only touch inner value nodes, so the injected toggle button + mod-hidden
  // class on the tile survive refreshes.

  function getHidden() {
    try {
      var raw = localStorage.getItem(HIDDEN_KEY);
      if (!raw) { return []; }
      var arr = JSON.parse(raw);
      return (arr && arr.length) ? arr : [];
    } catch (e) { return []; }
  }
  function setHidden(arr) {
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(arr)); } catch (e) {}
  }
  function inList(arr, v) {
    for (var i = 0; i < arr.length; i++) { if (arr[i] === v) { return true; } }
    return false;
  }
  function isModuleHidden(mod) { return inList(getHidden(), mod); }

  // All tiles that opted in with a data-mod attribute.
  function moduleTiles() {
    var out = [];
    var tiles = document.getElementsByClassName('tile');
    for (var i = 0; i < tiles.length; i++) {
      var mod = tiles[i].getAttribute ? tiles[i].getAttribute('data-mod') : null;
      if (mod) { out.push({ el: tiles[i], mod: mod }); }
    }
    return out;
  }

  function applyModuleVisibility() {
    var hidden = getHidden();
    var list = moduleTiles();
    for (var i = 0; i < list.length; i++) {
      var hid = inList(hidden, list[i].mod);
      if (hid) { addClass(list[i].el, 'mod-hidden'); } else { removeClass(list[i].el, 'mod-hidden'); }
      var btns = list[i].el.getElementsByClassName('mod-toggle');
      if (btns && btns[0]) { btns[0].innerHTML = hid ? 'Show' : 'Hide'; }
    }
  }

  function setModuleHidden(mod, hide) {
    var h = getHidden();
    if (hide && !inList(h, mod)) { h.push(mod); }
    else if (!hide) {
      var next = [];
      for (var i = 0; i < h.length; i++) { if (h[i] !== mod) { next.push(h[i]); } }
      h = next;
    }
    setHidden(h);
    applyModuleVisibility();
  }

  // Inject a Hide/Show toggle into each module tile (shown only in edit mode).
  function injectModuleToggles() {
    var list = moduleTiles();
    for (var i = 0; i < list.length; i++) {
      (function (item) {
        var btn = document.createElement('button');
        btn.className = 'mod-toggle';
        btn.type = 'button';
        btn.innerHTML = 'Hide';
        btn.onclick = function () { setModuleHidden(item.mod, !isModuleHidden(item.mod)); };
        item.el.appendChild(btn);
      })(list[i]);
    }
    applyModuleVisibility();
  }

  function toggleEditMode() {
    var dash = byId('dashboard');
    if (!dash) { return; }
    var editing = !hasClass(dash, 'editing');
    if (editing) { addClass(dash, 'editing'); } else { removeClass(dash, 'editing'); }
    var b = byId('customize-btn');
    if (b) { b.innerHTML = editing ? 'Done' : 'Customize'; }
  }

  /* ---------- event wiring ---------- */

  function trim(s) { return s ? s.replace(/^\s+|\s+$/g, '') : ''; }

  function onSaveSetup() {
    var station = trim(byId('station-input').value);
    var token = trim(byId('token-input').value);
    if (!station) { showSetup('Please enter your Station ID.'); return; }
    if (!token) { showSetup('Please paste your access token.'); return; }
    setStation(station);
    setToken(token);
    setError('');
    showDashboard();
    refreshAll();
    startAutoRefresh();
  }

  function onSettings() {
    showSetup('');
  }

  function init() {
    stationCoords = loadCoords();
    stationPlace = loadPlace();

    byId('save-token').onclick = onSaveSetup;
    byId('refresh-btn').onclick = refreshAll;
    byId('watch-btn').onclick = toggleWatch;
    byId('settings-btn').onclick = onSettings;
    byId('customize-btn').onclick = toggleEditMode;

    // Customize mode: inject per-tile Hide/Show toggles and apply saved state.
    injectModuleToggles();

    // Header clock: set now, then tick (minutes only, so 15s is plenty).
    updateClock();
    setInterval(updateClock, 15000);

    // Enter key in either setup field submits.
    function submitOnEnter(e) {
      var key = e.which || e.keyCode;
      if (key === 13) { onSaveSetup(); }
    }
    byId('token-input').onkeydown = submitOnEnter;
    byId('station-input').onkeydown = submitOnEnter;

    // Refresh when the app returns to foreground (iOS resumes from background).
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && isConfigured()) { refreshAll(); }
      }, false);
    }

    if (isConfigured()) {
      showDashboard();
      renderCached();   // instant paint from the last-known reading
      refreshAll();     // then refresh from the network
      startAutoRefresh();
    } else {
      showSetup('');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, false);
  } else {
    init();
  }

})();
