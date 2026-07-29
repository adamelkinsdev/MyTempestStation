# Tempest Weather Station — API Guide for Developers

**Prepared:** July 2026
**Official docs:** https://apidocs.tempestwx.com/reference/quick-start
**Machine-readable index (for AI tooling):** https://apidocs.tempestwx.com/llms.txt

This guide summarizes the APIs available to the owner of a WeatherFlow Tempest weather station and what a developer needs to start building against them. Verify details against the official docs before implementation — WeatherFlow has reorganized their documentation before, and apidocs.tempestwx.com is the current source of truth.

---

## 1. Overview: Four Ways to Get Data

| Interface | Transport | Use Case | Auth Required |
|---|---|---|---|
| **Tempest Home API (REST)** | HTTPS | On-demand queries: current conditions, history, stats, forecast | Access token |
| **WebSocket API** | WSS | Real-time push of observations & events (~1/min, plus rapid wind) | Access token |
| **Local UDP Broadcast** | UDP on LAN | Off-grid / local-only access; hub broadcasts JSON on the local network | None |
| **TempestOne API (Commercial)** | HTTPS | Enterprise/multi-station network access, radar, tides, lightning network | API key (business agreement) |

For a personal integration with your own station, you will use the **Home API (REST)** and/or **WebSocket** interfaces, with **UDP** as an optional local fallback. WeatherFlow explicitly recommends the remote (REST/WebSocket) interfaces as the primary data source even for apps running on the same LAN as the hub; UDP is intended as a backup or for fully off-grid setups.

---

## 2. Authentication

Two options for personal use:

### Personal Access Token (recommended to start)
1. Sign in at https://tempestwx.com
2. Go to **Settings → Data Authorizations → Create Token**
3. Pass the token as a query parameter: `?token=YOUR_TOKEN`

This is the simplest path for scripts, dashboards, home-automation integrations, and anything without a web UI.

### OAuth 2.0
Preferred for production apps with a web or mobile interface where *other* users would connect their own Tempest accounts. This is how the official Alexa/Google Home/IFTTT integrations work. Docs: https://apidocs.tempestwx.com/reference/oauth

**Note:** The old "API key" concept still exists but only applies to Enterprise (TempestOne) apps. Personal apps use access tokens.

**Access policy:** Third-party apps must ensure the user viewing station data is the station's authenticated owner. See the Remote Data Access Policy: https://apidocs.tempestwx.com/reference/remote-data-access-policy

---

## 3. Key Concept: Station vs. Device

- A **station** is the logical location/account entity (has a `station_id`).
- A **device** is a physical unit (has a `device_id`): the Tempest sensor itself (`ST-` serial), the hub (`HB-`), or legacy AIR (`AR-`) / SKY (`SK-`) units.
- Station-level endpoints return merged, user-friendly data; device-level endpoints return raw device observation arrays.
- Get your `station_id` and `device_id`s from the `GET /stations` call below.

Docs: https://apidocs.tempestwx.com/reference/station-vs-device

---

## 4. Tempest Home API (REST)

**Base URL:** `https://swd.weatherflow.com/swd/rest/`

All endpoints are GET requests authenticated with `?token=...`

### 4.1 Station Metadata

```
GET https://swd.weatherflow.com/swd/rest/stations?token=[token]
GET https://swd.weatherflow.com/swd/rest/stations/[station_id]?token=[token]
```

Returns your stations, their locations, and all connected devices (this is where you discover `station_id` and `device_id` values).

### 4.2 Observations (Current & Historical)

```
# Latest observation for a station (merged, human-friendly fields)
GET https://swd.weatherflow.com/swd/rest/observations/stn/[station_id]?token=[token]

# Observations for a specific device (raw observation arrays)
GET https://swd.weatherflow.com/swd/rest/observations/?device_id=[device_id]&token=[token]
```

The device observations endpoint supports time-range parameters (e.g., `time_start` / `time_end` as epoch seconds, or `day_offset`) for pulling historical data — see the endpoint reference for exact parameter names and limits: https://apidocs.tempestwx.com/reference/getobservationsbydeviceid

Station observations include **derived metrics** computed by WeatherFlow's servers in addition to raw sensor data: sea-level pressure, feels-like temperature, dew point, wet bulb temperature, wet bulb globe temperature, daily rain accumulation, and more. Derived metrics docs: https://apidocs.tempestwx.com/reference/derived-metrics

### 4.3 Statistics

```
GET https://swd.weatherflow.com/swd/rest/stats/station/[station_id]?token=[token]
```

Daily / monthly / yearly / all-time statistics for a station (highs, lows, accumulations).

### 4.4 Forecast

```
GET https://swd.weatherflow.com/swd/rest/better_forecast?station_id=[station_id]&token=[token]
```

Returns current conditions plus a ~10-day forecast tuned to your station's location and data.

Optional unit parameters (defaults in parentheses):

| Param | Values |
|---|---|
| `units_temp` | c (default), f |
| `units_wind` | mps (default), mph, kph, kts, bft, lfm |
| `units_pressure` | mb (default), inhg, mmhg, hpa |
| `units_precip` | mm (default), cm, in |
| `units_distance` | km (default), mi |

### 4.5 Reference Pages for Response Parsing

- Observation & event record formats (array index → field mapping): https://apidocs.tempestwx.com/reference/observation-record-format
- Default units: https://apidocs.tempestwx.com/reference/default-units-1
- Interactive API explorer (try calls in the browser): https://apidocs.tempestwx.com/reference

---

## 5. WebSocket API (Real-Time Push)

**Endpoint:** `wss://ws.weatherflow.com/swd/data?token=[token]`

After connecting, send JSON control messages. Key rules: open only **one** connection per client; idle connections are disconnected after **10 minutes**; all messages are JSON strings.

### Request Messages

```json
// Start receiving observations/events for a device (~1 obs per minute)
{ "type": "listen_start", "device_id": 12345, "id": "any-request-id" }

// Stop
{ "type": "listen_stop", "device_id": 12345, "id": "any-request-id" }

// Subscribe to lightning strikes in a geographic bounding box
{
  "type": "geo_strike_listen_start",
  "lat_min": 37.28, "lat_max": 41.32,
  "lon_min": -101.76, "lon_max": -91.00,
  "id": 12345
}
```

For `geo_strike_listen_start`, an optional `strike_type` field selects `cg` (cloud-to-ground, default), `ic` (cloud-to-cloud), or `all`.

### Response Message Types

| `type` | Meaning |
|---|---|
| `ack` | Acknowledgment of a request |
| `obs_st` | Tempest device observation (array format; see UDP table below — WS adds a few extra trailing fields) |
| `obs_air` / `obs_sky` | Legacy AIR / SKY device observations |
| `rapid_wind` | Wind speed/direction updates (frequent, ~every 3s) |
| `evt_precip` | Rain start event |
| `evt_strike` | Lightning strike detected by your device `[epoch, distance_km, energy]` |
| `geo_strike` | Network lightning strike (from geo subscription) with lat/lon/magnitude |

Docs: https://apidocs.tempestwx.com/reference/websocket-reference

---

## 6. Local UDP Broadcast (LAN)

The Tempest hub broadcasts JSON messages via **UDP on port 50222** to the local network. No authentication, no internet required. Any device on the same LAN can bind to that port and parse the JSON. Intended as a backup to REST/WebSocket or for off-grid use.

### Message Types

| `type` | Frequency | Contents |
|---|---|---|
| `obs_st` | ~1/min | Full Tempest observation (see field table below) |
| `rapid_wind` | ~3 sec | `[epoch, wind_speed_mps, wind_direction_deg]` |
| `evt_precip` | On rain start | `[epoch]` |
| `evt_strike` | On strike | `[epoch, distance_km, energy]` |
| `device_status` | ~1/min | Battery voltage, RSSI, uptime, sensor status bitfield, firmware |
| `hub_status` | ~10 sec | Hub firmware, uptime, RSSI, reset flags, radio stats |
| `obs_air` / `obs_sky` | Legacy | Only for older AIR/SKY hardware |

### `obs_st` Observation Array (UDP)

The `obs` field is an array of arrays; each inner array has these indices:

| Index | Field | Units |
|---|---|---|
| 0 | Timestamp | epoch seconds (UTC) |
| 1 | Wind lull | m/s |
| 2 | Wind average | m/s |
| 3 | Wind gust | m/s |
| 4 | Wind direction | degrees |
| 5 | Wind sample interval | seconds |
| 6 | Station pressure | mb |
| 7 | Air temperature | °C |
| 8 | Relative humidity | % |
| 9 | Illuminance | lux |
| 10 | UV | index |
| 11 | Solar radiation | W/m² |
| 12 | Rain over previous minute | mm |
| 13 | Precipitation type | 0=none, 1=rain, 2=hail, 3=rain+hail |
| 14 | Lightning strike avg distance | km |
| 15 | Lightning strike count | count |
| 16 | Battery | volts |
| 17 | Reporting interval | minutes |

Note: local daily rain accumulation is **not** available over UDP — use the REST API for accumulation totals.

Quick test from a machine on the same network (Python):

```python
import socket, json

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("", 50222))
while True:
    data, addr = sock.recvfrom(4096)
    msg = json.loads(data)
    print(msg["type"], msg)
```

Docs: https://apidocs.tempestwx.com/reference/tempest-udp-broadcast

---

## 7. TempestOne API (Commercial — FYI Only)

A separate commercial tier requiring a business agreement and API key. Not needed for personal use, but relevant if the project ever grows beyond a single owner's station:

- **Metadata / Observations / Stats / Forecast** across the broader Tempest network (100k+ stations including third-party networks)
- **Lightning** network data
- **Extended API:** enhanced forecasts, radar & satellite imagery, sea-surface currents & tides

Contact: https://business.tempest.earth/contact-professional-services

---

## 8. Practical Notes for the Developer

1. **Start with the Personal Access Token** — one minute of setup, works for both REST and WebSocket. Add OAuth only if the app will be used by other Tempest owners.
2. **Discovery flow:** call `GET /stations` first to enumerate `station_id` and `device_id`s; cache them.
3. **Polling vs. push:** for a dashboard or logger, WebSocket `listen_start` gives ~1-minute observations without polling. For periodic jobs (e.g., hourly summaries), REST is simpler.
4. **Parse arrays by index, not assumption:** observation payloads are positional arrays; index maps differ slightly between UDP and WebSocket variants of `obs_st` (WS appends extra fields). Always consult the observation record format page.
5. **Units:** raw data is metric (m/s, °C, mb, mm). The `better_forecast` endpoint can convert units server-side; raw observation endpoints do not — convert client-side.
6. **Rate limits / fair use:** WeatherFlow doesn't publish hard numeric limits for personal use but governs access via the Remote Data Access Policy. Poll reasonably (observations only update ~once per minute anyway).
7. **Ecosystem:** mature community libraries exist (e.g., WeeWX drivers, Home Assistant integrations, Python/Elixir UDP parsers). The community developer forum is active: https://community.tempest.earth/c/developers/5
8. **Sandbox:** the interactive docs let you try REST calls in the browser with your token before writing code.

---

## 9. Quick Reference Card

```
# Auth token: tempestwx.com → Settings → Data Authorizations → Create Token

# List stations & devices
curl "https://swd.weatherflow.com/swd/rest/stations?token=$TOKEN"

# Latest station observation
curl "https://swd.weatherflow.com/swd/rest/observations/stn/$STATION_ID?token=$TOKEN"

# Device observations (historical)
curl "https://swd.weatherflow.com/swd/rest/observations/?device_id=$DEVICE_ID&token=$TOKEN"

# Station statistics
curl "https://swd.weatherflow.com/swd/rest/stats/station/$STATION_ID?token=$TOKEN"

# 10-day forecast + current conditions (imperial units example)
curl "https://swd.weatherflow.com/swd/rest/better_forecast?station_id=$STATION_ID&units_temp=f&units_wind=mph&units_pressure=inhg&units_precip=in&units_distance=mi&token=$TOKEN"

# Real-time WebSocket
wss://ws.weatherflow.com/swd/data?token=$TOKEN
  → send: {"type":"listen_start","device_id":DEVICE_ID,"id":"1"}

# Local LAN (no auth): listen on UDP port 50222
```
