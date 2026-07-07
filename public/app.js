/* MyTempestStation dashboard.
 * Written in conservative ES5 (no arrow functions, template literals, let/const,
 * fetch, or Promises) so it runs on Safari for iOS 10.3.3.
 * The API token is stored only in this browser's localStorage - never in source. */
(function () {
  'use strict';

  var STATION_ID = '210198';
  var TOKEN_KEY = 'tempest_token';
  var REFRESH_MS = 60000; // auto-refresh every 60 seconds
  var STALE_MS = 15 * 60 * 1000; // flag data older than 15 min

  var refreshTimer = null;

  function byId(id) { return document.getElementById(id); }

  /* ---------- token storage ---------- */

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

  /* ---------- screen switching ---------- */

  function showSetup(message) {
    stopAutoRefresh();
    byId('dashboard').style.display = 'none';
    byId('setup').style.display = '';
    var err = byId('setup-error');
    if (message) { err.innerHTML = message; err.style.display = ''; }
    else { err.style.display = 'none'; }
    var input = byId('token-input');
    input.value = getToken() || '';
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

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

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
    byId('v-wind').innerHTML = fmt(o.wind_avg, mpsToMph, 1, ' mph');
    byId('v-gust').innerHTML = fmt(o.wind_gust, mpsToMph, 1, ' mph');

    var card = o.wind_direction_cardinal || cardinal(o.wind_direction);
    var deg = (o.wind_direction === null || o.wind_direction === undefined)
      ? '' : (' ' + Math.round(Number(o.wind_direction)) + '&deg;');
    byId('v-winddir').innerHTML = card ? (card + deg) : (deg || '&mdash;');

    // Prefer sea-level pressure; fall back to station/barometric pressure.
    var pressure = (o.sea_level_pressure !== undefined && o.sea_level_pressure !== null)
      ? o.sea_level_pressure
      : (o.barometric_pressure !== undefined ? o.barometric_pressure : o.station_pressure);
    byId('v-pressure').innerHTML = fmt(pressure, mbToInHg, 2, ' inHg');

    byId('v-rain').innerHTML = fmt(o.precip_accum_local_day, mmToIn, 2, ' in');

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

  function buildUrl(token) {
    // The obs array is always metric; we convert to imperial in render().
    return 'https://swd.weatherflow.com/swd/rest/observations/station/' + STATION_ID +
      '?token=' + encodeURIComponent(token);
  }

  function fetchData() {
    var token = getToken();
    if (!token) { showSetup(); return; }

    setStatus('Updating&hellip;');

    var xhr = new XMLHttpRequest();
    xhr.open('GET', buildUrl(token), true);
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
        setError('Station ' + STATION_ID + ' was not found.');
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

  /* ---------- auto refresh ---------- */

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(fetchData, REFRESH_MS);
  }
  function stopAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  /* ---------- event wiring ---------- */

  function onSaveToken() {
    var input = byId('token-input');
    var value = input.value ? input.value.replace(/^\s+|\s+$/g, '') : '';
    if (!value) {
      showSetup('Please paste a token first.');
      return;
    }
    setToken(value);
    setError('');
    showDashboard();
    fetchData();
    startAutoRefresh();
  }

  function onSettings() {
    showSetup('');
  }

  function init() {
    byId('save-token').onclick = onSaveToken;
    byId('refresh-btn').onclick = fetchData;
    byId('settings-btn').onclick = onSettings;

    // Enter key in the token field submits.
    byId('token-input').onkeydown = function (e) {
      var key = e.which || e.keyCode;
      if (key === 13) { onSaveToken(); }
    };

    // Refresh when the app returns to foreground (iOS resumes from background).
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && getToken()) { fetchData(); }
      }, false);
    }

    if (getToken()) {
      showDashboard();
      fetchData();
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
