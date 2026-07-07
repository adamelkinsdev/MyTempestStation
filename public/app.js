/* MyTempestStation dashboard.
 * Written in conservative ES5 (no arrow functions, template literals, let/const,
 * fetch, or Promises) so it runs on Safari for iOS 10.3.3.
 * The station ID and API token are stored only in this browser's localStorage -
 * never in source, so nothing here reveals the station or its location. */
(function () {
  'use strict';

  var TOKEN_KEY = 'tempest_token';
  var STATION_KEY = 'tempest_station';
  var STALE_MS = 15 * 60 * 1000; // flag data older than 15 min

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

  function renderForecast(data) {
    if (!data) { return; }
    renderSummary(data);
    renderConditions(data.current_conditions);
    if (!data.forecast) { return; }
    if (data.forecast.daily && data.forecast.daily.length) {
      renderSunArc(data.forecast.daily[0]);
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

  /* ---------- rendering ---------- */

  function render(data) {
    setError('');

    if (data && data.station_name) {
      byId('station-name').innerHTML = data.station_name;
    }

    if (!data || !data.obs || !data.obs.length) {
      setStatus('No recent observation');
      setError('The station returned no observation data yet. It may be offline or newly set up.');
      return;
    }

    var o = data.obs[0];

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
      renderForecast(data);
    };
    xhr.send();
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
    byId('save-token').onclick = onSaveSetup;
    byId('refresh-btn').onclick = refreshAll;
    byId('watch-btn').onclick = toggleWatch;
    byId('settings-btn').onclick = onSettings;

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
      refreshAll();
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
