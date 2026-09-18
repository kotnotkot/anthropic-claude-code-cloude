// =====================================================================
// BART Departures — App logic
//
// Overview of the flow:
//   1. Load (or fetch + cache) the full BART station list.
//   2. Pick a station: saved override > GPS nearest > station picker.
//   3. Fetch today's published schedule (sched.aspx) for that station —
//      this is the backbone timetable, since it covers the whole
//      service day (BART's live feed only looks ~1 hour ahead).
//   4. Fetch live estimates (etd.aspx) and match each one to a
//      schedule row so we can show "scheduled -> live".
//   5. Render, then repeat step 4 every REFRESH_INTERVAL_MS.
//
// All times are absolute Pacific clock times, always rounded DOWN to
// the minute (see roundDownToMinuteMs and its uses in
// buildDeparturesModel).
// =====================================================================

const LS_KEYS = {
  stations: 'bart_stations_cache_v1',
  favorites: 'bart_favorites_v1',
  selected: 'bart_selected_station_v1',
};

const PACIFIC_TZ = 'America/Los_Angeles';

const state = {
  stations: [],          // [{abbr, name, lat, lng}]
  station: null,         // currently displayed station object
  schedule: [],          // today's scheduled rows for state.station
  scheduleDateKey: null, // Pacific YYYY-MM-DD the schedule was fetched for
  refreshTimer: null,
};

// --------------------------- DOM shortcuts ---------------------------

const el = (id) => document.getElementById(id);
const stationNameEl = el('stationName');
const updatedLineEl = el('updatedLine');
const statusBannerEl = el('statusBanner');
const departuresEl = el('departures');
const pickerOverlayEl = el('pickerOverlay');
const stationSearchEl = el('stationSearch');
const stationListEl = el('stationList');

// ============================== Utilities ==============================

function normalizeArray(x) {
  // BART's XML->JSON conversion collapses a single-item list into a
  // plain object instead of a one-element array. Always coerce to array.
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function roundDownToMinuteMs(epochMs) {
  return Math.floor(epochMs / 60000) * 60000;
}

// The schedule reports platforms as "PL 2", the live feed as plain "2"
// — pull out just the number so the two can be compared.
function normalizePlatform(p) {
  if (!p) return null;
  const m = /\d+/.exec(String(p));
  return m ? m[0] : null;
}

// Mutes a BART line color (e.g. "#ffff33") to a soft, pastel version for
// group headings and row accents — same hue, fixed moderate saturation
// and lightness so every line reads at a similar, gentle intensity and
// stays legible in both light and dark mode. Returns null (no color) for
// anything that isn't a recognizable hex color, so callers can fall back
// to the normal neutral styling.
function mutedLineColor(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1];
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let hue = 0;
  if (max !== min) {
    const d = max - min;
    switch (max) {
      case r: hue = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: hue = ((b - r) / d + 2); break;
      default: hue = ((r - g) / d + 4);
    }
    hue *= 60;
  }
  return hslToHex(hue, 0.40, 0.52);
}

function hslToHex(hueDeg, sat, light) {
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hueDeg / 60) % 2) - 1));
  const m = light - c / 2;
  let seg;
  if (hueDeg < 60) seg = [c, x, 0];
  else if (hueDeg < 120) seg = [x, c, 0];
  else if (hueDeg < 180) seg = [0, c, x];
  else if (hueDeg < 240) seg = [0, x, c];
  else if (hueDeg < 300) seg = [x, 0, c];
  else seg = [c, 0, x];
  const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(seg[0])}${toHex(seg[1])}${toHex(seg[2])}`;
}

function pacificDateKey(epochMs) {
  // "YYYY-MM-DD" for the given instant, in Pacific time — used only to
  // notice when the service day has rolled over so we refetch the
  // schedule.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PACIFIC_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(epochMs));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function formatClock(epochMs) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_TZ, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(epochMs));
}

// Parse a BART schedule time like "6:15 AM" (Pacific wall-clock, today)
// into an absolute epoch ms. We build it by taking "now" in Pacific,
// then overwriting the hour/minute — this avoids ever having to know
// the viewer's own timezone offset.
function pacificWallTimeToEpoch(timeStr, referenceEpochMs) {
  if (typeof timeStr !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(timeStr.trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10) % 12;
  const minute = parseInt(m[2], 10);
  if (m[3].toUpperCase() === 'PM') hour += 12;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_TZ, timeZoneName: 'shortOffset',
  }).formatToParts(new Date(referenceEpochMs));
  const offsetPart = parts.find((p) => p.type === 'timeZoneName').value; // e.g. "GMT-7"
  const offsetMatch = /GMT([+-]\d+)/.exec(offsetPart);
  const offsetHours = offsetMatch ? parseInt(offsetMatch[1], 10) : -8;

  const dateKey = pacificDateKey(referenceEpochMs); // YYYY-MM-DD
  const iso = `${dateKey}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${offsetHours >= 0 ? '+' : '-'}${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;
  return new Date(iso).getTime();
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function showStatus(message, isError = true) {
  statusBannerEl.textContent = message;
  statusBannerEl.hidden = !message;
  statusBannerEl.style.borderColor = isError ? '' : 'var(--accent)';
}

function clearStatus() {
  statusBannerEl.hidden = true;
}

// ============================== BART API ==============================

async function bartFetch(endpoint, params) {
  const url = new URL(`${CONFIG.API_BASE.replace(/\/$/, '')}/${endpoint}`);
  const allParams = { ...params, key: CONFIG.BART_API_KEY, json: 'y' };
  Object.entries(allParams).forEach(([k, v]) => url.searchParams.set(k, v));

  let res;
  try {
    res = await fetch(url.toString());
  } catch (err) {
    throw new Error(
      'Could not reach the BART API — your browser may be blocking the '
      + 'request (CORS). See README.md > "If direct requests don\'t work".',
    );
  }
  if (!res.ok) {
    throw new Error(`BART API returned an error (HTTP ${res.status}).`);
  }
  const data = await res.json();
  if (data && data.root && data.root.message && data.root.message.error) {
    const e = data.root.message.error;
    throw new Error(`BART API error: ${e.text || JSON.stringify(e)}`);
  }
  return data;
}

async function fetchStationsFromApi() {
  const data = await bartFetch('stn.aspx', { cmd: 'stns' });
  return normalizeArray(data.root.stations.station).map((s) => ({
    abbr: s.abbr,
    name: s.name,
    lat: parseFloat(s.gtfs_latitude),
    lng: parseFloat(s.gtfs_longitude),
  }));
}

async function fetchScheduleForStation(abbr) {
  const data = await bartFetch('sched.aspx', { cmd: 'stnsched', orig: abbr, date: 'today' });
  // BART's XML->JSON conversion prefixes attribute-style fields with
  // "@" (confirmed against a real response — sched.aspx has no plain
  // "trainId", "origTime" etc., only "@origTime" and friends).
  const stationBlock = normalizeArray(data.root.station)[0];
  const items = stationBlock ? normalizeArray(stationBlock.item) : [];
  return items.map((it) => ({
    // NOTE: despite the name, this is NOT a station abbreviation like
    // "MLBR" — it's a rider-facing route/headsign string such as
    // "SF / SFO Airport / Millbrae". BART's live feed (etd.aspx)
    // appears to describe destinations more specifically than that, so
    // destination-text matching against the live feed is unreliable
    // until confirmed against a real etd.aspx response.
    destinationAbbr: it['@trainHeadStation'],
    origTime: it['@origTime'], // e.g. "6:15 AM"
    line: it['@line'],
    platform: it['@platform'], // e.g. "PL 2"
    bikeFlag: it['@bikeflag'] === '1',
  }));
}

async function fetchLiveEtd(abbr) {
  const data = await bartFetch('etd.aspx', { cmd: 'etd', orig: abbr });
  const stationBlock = normalizeArray(data.root.station)[0];
  const etdList = stationBlock ? normalizeArray(stationBlock.etd) : [];
  const rows = [];
  etdList.forEach((etd) => {
    normalizeArray(etd.estimate).forEach((est) => {
      rows.push({
        destination: etd.destination,
        destinationAbbr: est.abbreviation || etd.abbreviation,
        minutesRaw: est.minutes, // number-as-string, or "Leaving"
        platform: est.platform,
        delaySeconds: parseInt(est.delay || '0', 10),
        cancelled: est.cancelflag === '1',
        direction: est.direction,
        hexcolor: est.hexcolor || etd.hexcolor || null, // BART's own line color, e.g. "#ffff33"
      });
    });
  });
  return rows;
}

// ============================ Station list =============================

async function getStations() {
  const cached = localStorage.getItem(LS_KEYS.stations);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed.stations) && parsed.stations.length) return parsed.stations;
    } catch (e) { /* fall through to refetch */ }
  }
  const stations = await fetchStationsFromApi();
  localStorage.setItem(LS_KEYS.stations, JSON.stringify({ stations, cachedAt: Date.now() }));
  return stations;
}

function findStationByAbbr(abbr) {
  return state.stations.find((s) => s.abbr === abbr) || null;
}

function stationNameForAbbr(abbr) {
  const s = findStationByAbbr(abbr);
  return s ? s.name : abbr;
}

function nearestStation(lat, lng) {
  let best = null;
  let bestDist = Infinity;
  state.stations.forEach((s) => {
    const d = haversineMiles(lat, lng, s.lat, s.lng);
    if (d < bestDist) { bestDist = d; best = s; }
  });
  return best;
}

function getCurrentPositionOnce(timeoutMs = 8000) {
  // Some browsers only start counting `timeout` once permission has been
  // granted, so a permission prompt that's never answered can otherwise
  // hang forever. Race against our own timer so we always fall back to
  // the station picker within a bounded time.
  return new Promise((resolve) => {
    let settled = false;
    const settle = (val) => { if (!settled) { settled = true; resolve(val); } };
    if (!('geolocation' in navigator)) return settle(null);
    setTimeout(() => settle(null), timeoutMs + 2000);
    navigator.geolocation.getCurrentPosition(
      (pos) => settle(pos.coords),
      () => settle(null),
      { timeout: timeoutMs, maximumAge: 5 * 60 * 1000 },
    );
  });
}

// ============================== Favorites ===============================

function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEYS.favorites) || '[]');
  } catch (e) { return []; }
}

function toggleFavorite(abbr) {
  const favs = getFavorites();
  const idx = favs.indexOf(abbr);
  if (idx >= 0) favs.splice(idx, 1); else favs.push(abbr);
  localStorage.setItem(LS_KEYS.favorites, JSON.stringify(favs));
  return favs;
}

// ========================= Matching (the tricky part) =========================
//
// The live feed (etd.aspx) only looks ~1 hour ahead and doesn't carry a
// stable train ID we can rely on across both endpoints, so we have to
// pair a live estimate with a scheduled row some other way.
//
// Destination text turned out NOT to be a reliable way to do that: a
// real sched.aspx response describes a destination as a route headsign
// like "SF / SFO Airport / Millbrae", while etd.aspx describes it as a
// specific station code like "MLBR" — those never match as text, so
// matching by destination silently matched nothing at all, and every
// train ended up listed twice (once from each feed, under two
// different-looking group headings for what was really one train).
//
// Matching instead scopes by PLATFORM — both feeds report one (as
// "PL 2" vs plain "2"; see normalizePlatform), and which platform a
// train uses reliably tells you its direction, which is what actually
// matters here — then picks the closest departure time within that
// platform, within CONFIG.MATCH_TOLERANCE_MINUTES.
//
// Within a platform, matching is greedy by closest PAIR first, not by
// walking live trains in time order: we list every (live, scheduled)
// candidate pair within tolerance, sort all of them by how close
// together they are, and claim pairs in that order (each live estimate
// and each scheduled slot can only be claimed once). Processing by
// live-train order instead would be order-dependent — a slightly-off
// extra train processed first could steal the slot that really belongs
// to a spot-on match considered later.
//
// A live estimate that finds no scheduled slot within tolerance simply
// has no real published time to show — its "scheduled" time is instead
// derived as live time minus the reported delay (see scheduledEpoch
// below). Cancellations come straight from BART's cancelflag.

function buildDeparturesModel(nowMs) {
  const live = state._liveRows || [];
  const sched = state.schedule;

  // Rough (unrounded) live epoch, used only for matching distance —
  // display rounding happens later, per-row.
  const liveWithApproxEpoch = live.map((r) => {
    const minutes = r.minutesRaw && /^\d+$/.test(r.minutesRaw) ? parseInt(r.minutesRaw, 10) : 0;
    return { ...r, approxEpoch: nowMs + minutes * 60000 };
  });

  const schedWithEpoch = sched.map((s) => ({
    ...s,
    epoch: pacificWallTimeToEpoch(s.origTime, nowMs),
  })).filter((s) => s.epoch !== null);

  const claimed = new Set();
  const matches = new Map(); // live row index -> sched row

  // A given platform serves one direction all day, so the live feed's
  // destination naming for a platform (reliable) can stand in for the
  // schedule's naming (a coarser headsign) on that same platform's
  // schedule-only rows below — otherwise a far-future train (beyond the
  // live feed's ~1hr window) would show under a different-looking group
  // heading than its own near-term, live-matched departures.
  const platformToLiveDest = new Map();
  liveWithApproxEpoch.forEach((r) => {
    const p = normalizePlatform(r.platform);
    if (p !== null && !platformToLiveDest.has(p)) {
      platformToLiveDest.set(p, {
        destination: r.destination,
        destinationAbbr: r.destinationAbbr,
        lineColor: mutedLineColor(r.hexcolor),
      });
    }
  });

  const platforms = new Set(
    liveWithApproxEpoch.map((r) => normalizePlatform(r.platform)).filter((p) => p !== null),
  );
  platforms.forEach((platform) => {
    const liveForPlatform = liveWithApproxEpoch
      .map((r, i) => ({ r, i }))
      .filter((x) => normalizePlatform(x.r.platform) === platform);

    const schedForPlatform = schedWithEpoch
      .map((s, i) => ({ s, i }))
      .filter((x) => normalizePlatform(x.s.platform) === platform);

    const candidates = [];
    liveForPlatform.forEach(({ r, i }) => {
      schedForPlatform.forEach(({ s, i: si }) => {
        const diff = Math.abs(s.epoch - r.approxEpoch);
        if (diff <= CONFIG.MATCH_TOLERANCE_MINUTES * 60000) {
          candidates.push({ i, si, s, diff });
        }
      });
    });
    candidates.sort((a, b) => a.diff - b.diff);

    const claimedLive = new Set();
    candidates.forEach((c) => {
      if (claimedLive.has(c.i) || claimed.has(c.si)) return;
      claimedLive.add(c.i);
      claimed.add(c.si);
      matches.set(c.i, c.s);
    });
  });

  // Build final display rows.
  const rows = [];

  liveWithApproxEpoch.forEach((r, i) => {
    const matchedSched = matches.get(i) || null;
    const isBoarding = /leav/i.test(r.minutesRaw || '');
    const minutes = isBoarding ? 0
      : (r.minutesRaw && /^\d+$/.test(r.minutesRaw) ? parseInt(r.minutesRaw, 10) : 0);
    const liveEpochRaw = nowMs + minutes * 60000;
    const liveEpoch = roundDownToMinuteMs(liveEpochRaw);

    let scheduledEpoch;
    if (matchedSched) {
      scheduledEpoch = roundDownToMinuteMs(matchedSched.epoch);
    } else {
      // Can't match to a published schedule row: derive scheduled time
      // as live time minus the reported delay, rounded down.
      scheduledEpoch = roundDownToMinuteMs(liveEpochRaw - r.delaySeconds * 1000);
    }

    rows.push({
      destination: r.destination,
      destinationAbbr: r.destinationAbbr,
      scheduledEpoch,
      liveEpoch,
      showLive: liveEpoch !== scheduledEpoch,
      boarding: isBoarding,
      cancelled: r.cancelled,
      platform: normalizePlatform(r.platform),
      lineColor: mutedLineColor(r.hexcolor),
      sortEpoch: matchedSched ? scheduledEpoch : liveEpoch,
    });
  });

  // Scheduled rows with no live match yet (beyond the live feed's
  // ~1-hour horizon, or simply not published as an estimate) — these
  // fill out the rest of the timetable, with no live time but still
  // showing the platform the schedule itself publishes.
  schedWithEpoch.forEach((s, si) => {
    if (claimed.has(si)) return;
    if (s.epoch < nowMs - 60000) return; // already departed
    const platform = normalizePlatform(s.platform);
    const liveDest = platform !== null ? platformToLiveDest.get(platform) : null;
    rows.push({
      destination: liveDest ? liveDest.destination : stationNameForAbbr(s.destinationAbbr),
      destinationAbbr: liveDest ? liveDest.destinationAbbr : s.destinationAbbr,
      scheduledEpoch: roundDownToMinuteMs(s.epoch),
      liveEpoch: null,
      showLive: false,
      boarding: false,
      cancelled: false,
      platform,
      lineColor: liveDest ? liveDest.lineColor : null,
      sortEpoch: roundDownToMinuteMs(s.epoch),
    });
  });

  return rows.filter((r) => r.sortEpoch >= nowMs - 60000 || r.cancelled)
    .sort((a, b) => a.sortEpoch - b.sortEpoch);
}

function windowAndGroup(rows, nowMs) {
  const cutoff = nowMs + CONFIG.DEPARTURE_WINDOW_MINUTES * 60000;
  const byDest = new Map();
  rows.forEach((r) => {
    if (!byDest.has(r.destinationAbbr)) byDest.set(r.destinationAbbr, []);
    byDest.get(r.destinationAbbr).push(r);
  });

  const groups = [];
  byDest.forEach((destRows, abbr) => {
    destRows.sort((a, b) => a.sortEpoch - b.sortEpoch);
    const kept = destRows.filter((r) => r.sortEpoch <= cutoff);
    const finalRows = kept.length >= CONFIG.MIN_PER_DESTINATION
      ? kept
      : destRows.slice(0, CONFIG.MIN_PER_DESTINATION);
    if (finalRows.length) {
      const lineColor = finalRows.find((r) => r.lineColor)?.lineColor || null;
      groups.push({
        abbr, name: finalRows[0].destination, rows: finalRows, next: finalRows[0].sortEpoch, lineColor,
      });
    }
  });

  groups.sort((a, b) => a.next - b.next);
  return groups;
}

// ============================== Rendering ===============================

function renderDepartures() {
  const nowMs = Date.now();
  if (!state._liveRows) {
    departuresEl.innerHTML = '<p class="empty-state">Loading departures&hellip;</p>';
    return;
  }

  // Guards a real bug I hit before: BART's API occasionally has rows
  // with an unexpected/missing field (e.g. no origTime on a schedule
  // item), which used to throw and blank the whole screen. One bad row
  // should never take down the rest of the timetable.
  let groups;
  try {
    const rows = buildDeparturesModel(nowMs);
    groups = windowAndGroup(rows, nowMs);
  } catch (err) {
    showStatus(`Couldn't display departures: ${err.message}. If this keeps happening, BART's API may have changed a field name — please report it.`);
    departuresEl.innerHTML = '<p class="empty-state">Something went wrong showing departures.</p>';
    return;
  }

  if (!groups.length) {
    departuresEl.innerHTML = '<p class="empty-state">No upcoming departures found for this station right now.</p>';
    return;
  }

  // g.lineColor is set as a CSS custom property on the group wrapper —
  // custom properties inherit, so the heading and every row inside can
  // read it via var(--line-color, <fallback>) without repeating it.
  departuresEl.innerHTML = groups.map((g) => `
    <section class="dest-group"${g.lineColor ? ` style="--line-color: ${g.lineColor}"` : ''}>
      <h2 class="dest-heading">To ${escapeHtml(g.name)}</h2>
      ${g.rows.map(renderRow).join('')}
    </section>
  `).join('');
}

function renderRow(r) {
  const badges = [];
  if (r.cancelled) badges.push('<span class="dep-badge badge-cancelled">Cancelled</span>');
  if (r.boarding && !r.cancelled) badges.push('<span class="dep-badge badge-boarding">Boarding</span>');
  if (r.platform) badges.push(`<span class="dep-badge badge-platform">Platform ${escapeHtml(r.platform)}</span>`);

  const schedTimeHtml = `<span class="dep-time${r.cancelled ? ' struck' : ''}">${formatClock(r.scheduledEpoch)}</span>`;

  let liveHtml = '';
  if (!r.cancelled && !r.boarding && r.liveEpoch !== null && r.showLive) {
    liveHtml = `<span class="dep-arrow">&rarr;</span><span class="dep-live">${formatClock(r.liveEpoch)}</span>`;
  }

  // A boarding train shows one current clock time plus its badge,
  // rather than a "sched -> live" arrow that reads oddly once a train
  // is already at the platform. Every other row shows its scheduled
  // time, plus a red live time after an arrow only when it differs.
  const primaryHtml = r.boarding && r.liveEpoch !== null
    ? `<span class="dep-time">${formatClock(r.liveEpoch)}</span>`
    : schedTimeHtml + liveHtml;

  return `
    <div class="dep-row${r.cancelled ? ' cancelled' : ''}">
      ${primaryHtml}
      <div class="dep-spacer"></div>
      ${badges.join('')}
    </div>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderUpdatedLine() {
  updatedLineEl.textContent = `Updated ${formatClock(Date.now())}`;
}

// ============================== Station picker ===============================

function openPicker() {
  pickerOverlayEl.hidden = false;
  stationSearchEl.value = '';
  renderStationList('');
  stationSearchEl.focus();
}

function closePicker() {
  pickerOverlayEl.hidden = true;
}

function renderStationList(query) {
  const q = (query || '').trim().toLowerCase();
  const favs = getFavorites();
  const all = [...state.stations].sort((a, b) => a.name.localeCompare(b.name));
  const filtered = q ? all.filter((s) => s.name.toLowerCase().includes(q)) : all;

  const favStations = filtered.filter((s) => favs.includes(s.abbr));
  const otherStations = filtered.filter((s) => !favs.includes(s.abbr));

  const rowHtml = (s) => {
    const isFav = favs.includes(s.abbr);
    return `
      <div class="station-row" data-abbr="${s.abbr}">
        <button class="star-btn" data-star="${s.abbr}" aria-label="${isFav ? 'Remove favorite' : 'Add favorite'}">${isFav ? '&#9733;' : '&#9734;'}</button>
        <span class="name">${escapeHtml(s.name)}</span>
      </div>`;
  };

  let html = '';
  if (favStations.length) {
    html += '<div class="station-group-label">Favorites</div>' + favStations.map(rowHtml).join('');
  }
  html += `<div class="station-group-label">${favStations.length ? 'All stations' : 'Stations'}</div>${otherStations.map(rowHtml).join('')}`;
  stationListEl.innerHTML = html;
}

stationListEl.addEventListener('click', (e) => {
  const starBtn = e.target.closest('[data-star]');
  if (starBtn) {
    toggleFavorite(starBtn.dataset.star);
    renderStationList(stationSearchEl.value);
    return;
  }
  const row = e.target.closest('.station-row');
  if (row) {
    selectStation(row.dataset.abbr, true);
    closePicker();
  }
});

stationSearchEl.addEventListener('input', () => renderStationList(stationSearchEl.value));
el('pickerClose').addEventListener('click', closePicker);
el('stationBtn').addEventListener('click', openPicker);
pickerOverlayEl.addEventListener('click', (e) => { if (e.target === pickerOverlayEl) closePicker(); });

el('useLocationBtn').addEventListener('click', async () => {
  el('useLocationBtn').textContent = 'Locating…';
  const coords = await getCurrentPositionOnce();
  el('useLocationBtn').textContent = '\u{1F4CD} Use my location';
  if (!coords) {
    showStatus('Could not get your location. Check your browser/location settings, or pick a station below.', true);
    return;
  }
  const nearest = nearestStation(coords.latitude, coords.longitude);
  if (nearest) {
    localStorage.removeItem(LS_KEYS.selected);
    selectStation(nearest.abbr, true);
    closePicker();
  }
});

// ============================== Core flow ===============================

async function selectStation(abbr, isManualOverride) {
  const station = findStationByAbbr(abbr);
  if (!station) return;
  state.station = station;
  stationNameEl.textContent = station.name;
  if (isManualOverride) {
    localStorage.setItem(LS_KEYS.selected, abbr);
  }
  clearStatus();
  departuresEl.innerHTML = '<p class="empty-state">Loading departures&hellip;</p>';
  stopRefreshLoop();
  try {
    await loadScheduleIfNeeded(true);
    await refreshLive();
  } catch (err) {
    showStatus(err.message);
  }
  startRefreshLoop();
}

async function loadScheduleIfNeeded(force) {
  const nowKey = pacificDateKey(Date.now());
  if (!force && state.scheduleDateKey === nowKey) return;
  state.schedule = await fetchScheduleForStation(state.station.abbr);
  state.scheduleDateKey = nowKey;
}

async function refreshLive() {
  await loadScheduleIfNeeded(false); // catches midnight rollover
  state._liveRows = await fetchLiveEtd(state.station.abbr);
  clearStatus();
  renderDepartures();
  renderUpdatedLine();
}

function startRefreshLoop() {
  stopRefreshLoop();
  state.refreshTimer = setInterval(async () => {
    try {
      await refreshLive();
    } catch (err) {
      showStatus(err.message);
    }
  }, CONFIG.REFRESH_INTERVAL_MS);
}

function stopRefreshLoop() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = null;
}

el('refreshBtn').addEventListener('click', async () => {
  try {
    await refreshLive();
  } catch (err) {
    showStatus(err.message);
  }
});

// Re-render (not re-fetch) periodically too, so "Updated" / boarding
// status stays fresh between fetches without hammering the API.
setInterval(() => { if (state._liveRows) renderDepartures(); }, 15000);

async function init() {
  try {
    state.stations = await getStations();
  } catch (err) {
    showStatus(`Could not load the BART station list: ${err.message}`);
    stationNameEl.textContent = 'Unavailable';
    return;
  }

  const savedAbbr = localStorage.getItem(LS_KEYS.selected);
  if (savedAbbr && findStationByAbbr(savedAbbr)) {
    await selectStation(savedAbbr, false);
    return;
  }

  stationNameEl.textContent = 'Finding your station…';
  const coords = await getCurrentPositionOnce();
  if (coords) {
    const nearest = nearestStation(coords.latitude, coords.longitude);
    if (nearest) {
      await selectStation(nearest.abbr, false);
      return;
    }
  }

  // Location denied/unavailable: fall back to the station picker.
  stationNameEl.textContent = 'Pick a station';
  showStatus('Location isn’t available, so pick your station below.', false);
  openPicker();
}

init();
