// =====================================================================
// BART Departures — Configuration
//
// This is the ONE file you should need to edit for normal setup.
// See README.md for step-by-step instructions on getting your own
// API key and (if needed) setting up the CORS proxy.
// =====================================================================

const CONFIG = {
  // Your BART API key. The value below is BART's published public
  // "test" key (MW9S-E7SL-26DU-VV8V) — it works immediately with no
  // signup, but BART asks that ongoing/personal use get its own free
  // key. See README.md > "Get your own BART API key".
  BART_API_KEY: 'MW9S-E7SL-26DU-VV8V',

  // Where the app sends BART API requests.
  //   - Direct to BART (default, simplest — try this first):
  //       'https://api.bart.gov/api'
  //   - Through your own Cloudflare Worker proxy (only needed if your
  //     browser blocks direct requests with a CORS error — see
  //     README.md > "If direct requests don't work"):
  //       'https://your-worker-name.your-subdomain.workers.dev'
  API_BASE: 'https://api.bart.gov/api',

  // How often to refresh live departure times, in milliseconds.
  REFRESH_INTERVAL_MS: 30000,

  // How many minutes ahead to show departures for (the timetable will
  // always show at least MIN_PER_DESTINATION trains per destination
  // even if that stretches past this window — useful late at night
  // when trains are far apart).
  DEPARTURE_WINDOW_MINUTES: 90,
  MIN_PER_DESTINATION: 3,

  // Matching tolerance: how many minutes apart a live estimate and a
  // scheduled departure (to the same destination) can be and still be
  // considered "the same train". See README.md > "How matching works".
  MATCH_TOLERANCE_MINUTES: 12,
};
