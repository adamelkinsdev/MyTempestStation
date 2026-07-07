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

  var refreshTimer = null;  // periodic data refresh
  var watchTimer = null;    // 1s ticker driving the watch countdown/fallback
  var watchEndsAt = 0;      // epoch ms when watch mode auto-reverts to idle

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

  /* ---------- Dew-point comfort ---------- */

  // Comfort is driven by dew point (F), the metric people actually feel.
  function renderComfort(dewC) {
    var el = byId('v-comfort');
    if (!el) { return; }
    var d = toNum(dewC);
    if (d === null) { el.innerHTML = '&mdash;'; return; }
    var f = cToF(d);
    var word, cls;
    if (f < 55) { word = 'Dry'; cls = 'comfort-good'; }
    else if (f < 60) { word = 'Comfortable'; cls = 'comfort-good'; }
    else if (f < 65) { word = 'Sticky'; cls = 'comfort-mid'; }
    else if (f < 70) { word = 'Muggy'; cls = 'comfort-mid'; }
    else if (f < 75) { word = 'Oppressive'; cls = 'comfort-bad'; }
    else { word = 'Sweltering'; cls = 'comfort-bad'; }
    el.innerHTML = '<span class="' + cls + '">' + word + '</span>';
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
  }

  function renderForecast(data) {
    if (!data || !data.forecast) { return; }
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
