# BART Departures

A one-page phone app that shows BART departures as clock times ("4:15 PM"),
never as countdowns. It shows the nearest station's timetable, and when a
train is running late it shows both times: "4:15 PM → 4:17 PM".

No build step, no server, no account system. It's plain HTML/CSS/JavaScript,
hosted for free on GitHub Pages.

## What's in this project

Think of this like a simple recipe: a few ingredients (files), no oven
(build tools) required.

| File | What it's for |
| --- | --- |
| `index.html` | The page's skeleton (the boxes on screen). |
| `style.css` | How it looks (colors, sizing, dark mode). |
| `app.js` | All the logic — the actual "brain" of the app. |
| `config.js` | **The one file you'll normally edit** — your API key and a couple of settings. |
| `manifest.json` | Tells your phone how to show the app when added to your home screen. |
| `icons/` | The home-screen icon, in a few sizes. |
| `proxy/worker.js` | An optional helper (explained below) — only needed if your browser blocks direct requests to BART. |

You don't need to know how to code to use this. The one edit you'll normally
make (your API key) is a single line in `config.js`, explained below.

## 1. Get your own BART API key

The app ships with BART's public "test" key, so it works immediately with no
signup. But BART's terms ask that ongoing/personal use gets its own free key
(it takes about a minute and doesn't require anything beyond an email
address):

1. Go to BART's developer page: https://www.bart.gov/schedules/developers/api
2. Look for the link to **request an API key** (sometimes labeled "Request
   a free API key" or similar) and fill out the short form — name and email
   are typically all that's asked.
3. BART emails you a key that looks like `XXXX-XXXX-XXXX-XXXX`.
4. Open `config.js` in this project (click it on GitHub, then the pencil/edit
   icon) and replace the value of `BART_API_KEY` with your new key:

   ```js
   BART_API_KEY: 'YOUR-NEW-KEY-HERE',
   ```
5. Commit the change (see "Updating the app later" below).

That's the only required setup step.

## 2. Put it on GitHub Pages (free hosting)

GitHub Pages turns a repository into a public website, for free, with HTTPS
already handled — which matters here because phones only share location
with secure (`https://`) pages.

1. On GitHub, open this repository's **Settings** tab.
2. In the left sidebar, click **Pages**.
3. Under "Build and deployment" → "Source", choose **Deploy from a branch**.
4. Under "Branch", choose the branch this code is on (see the note at the
   top of this repo, or ask whoever set it up) and folder **/ (root)**, then
   **Save**.
5. GitHub shows a URL like `https://yourusername.github.io/your-repo-name/`.
   It can take a minute or two to go live the first time.

Open that URL on your phone once it's ready.

## 3. Add it to your phone's home screen

This makes it open full-screen, like a regular app, with its own icon.

**iPhone (Safari):**
1. Open the GitHub Pages URL in Safari (must be Safari, not Chrome, for this
   step on iPhone).
2. Tap the **Share** icon (square with an arrow pointing up).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add**.

**Android (Chrome):**
1. Open the URL in Chrome.
2. Tap the **⋮** (three-dot) menu.
3. Tap **Add to Home screen** (or you may see an automatic "Install app"
   banner — either works).

## 4. Test it, and check whether the CORS proxy is needed

The brief for this app calls for testing, before relying on it, whether your
browser will let this page talk to `api.bart.gov` directly. I could not run
that test myself while building this (this build environment's network
policy blocks reaching `api.bart.gov` entirely, even to check), so **this is
a step you'll need to do once, and it only takes a minute**:

1. Open the app on your phone or in a desktop browser.
2. If departures show up: you're done, direct requests work, skip to the
   next section.
3. If you see a red banner saying the app couldn't reach the BART API, or
   (on desktop) you open the browser's developer console (F12) and see the
   word "CORS" in a red error: your browser is blocking direct requests, and
   you'll need the small proxy below.

### If direct requests don't work

A quick analogy: CORS is like a bouncer at a website's door who only lets in
guests from an approved list. BART's API is an old one that (as of this
writing) doesn't put your page on that list. The fix is a tiny relay — a
"Cloudflare Worker" — that fetches the data on your app's behalf and hands it
back with permission attached. It's free, takes about 5 minutes to set up
once, and you never touch it again after that.

1. Go to https://dash.cloudflare.com/sign-up and create a free account (email
   + password).
2. In the dashboard, find **Workers & Pages** in the left sidebar, then
   **Create** → **Create Worker**.
3. Give it any name (e.g. `bart-proxy`) and click **Deploy** to create it
   with the default "Hello World" code.
4. Click **Edit code**. Delete everything in the editor and paste in the
   contents of this project's `proxy/worker.js` file.
5. Click **Deploy** again (or **Save and deploy**).
6. Cloudflare shows you a URL like
   `https://bart-proxy.yourname.workers.dev` — copy it.
7. Back in this project's `config.js`, change:

   ```js
   API_BASE: 'https://api.bart.gov/api',
   ```
   to:
   ```js
   API_BASE: 'https://bart-proxy.yourname.workers.dev',
   ```
8. Commit and push (see below). Reload the app — it should now load
   departures through the proxy.

The proxy doesn't store anything; it just relays your request to BART and
adds the one missing permission header.

## How live trains are matched to the schedule

This is the trickiest part of the app, so here's how it works in plain
terms. BART gives us two different lists:

- **The schedule** (a full day's planned departures, including trains
  hours from now).
- **The live feed** (real-time estimates, but only for roughly the next
  hour, and without any ID that reliably lines up with the schedule).

To show "4:15 PM → 4:17 PM", the app has to guess which live estimate
corresponds to which scheduled train. It does this by:

1. Only comparing trains headed to the **same destination station**.
2. Finding the **closest-in-time pairs** first — of every possible
   (scheduled train, live estimate) pairing to that destination, the pair
   that's closest together in time gets matched first, then the next
   closest remaining pair, and so on. This "closest pair first" approach
   (rather than just processing trains in order) avoids a real bug I found
   while testing: an early, slightly-off live estimate could otherwise steal
   the schedule slot that actually belongs to a different, better-matching
   train.
3. Only accepting a match if it's within `MATCH_TOLERANCE_MINUTES` (12
   minutes by default, in `config.js`) of the scheduled time — if nothing
   scheduled is nearby, the app labels it **Added** (an extra, unscheduled
   train) rather than forcing a bad match.

**Cancelled** trains are different — BART's live feed flags those directly
(a `cancelflag`), so no guessing is involved there.

## Decisions I made that are yours to revisit

The brief asked me to flag anything I decided on your behalf rather than
choosing silently. Here's what I picked, and why — all are quick to change
if you'd rather have it differently (ask me, or edit the noted spot):

- **Grouped by destination, not by line** (e.g. "To Antioch", not "Yellow
  Line"). Riders generally think in terms of where the train is going.
  (`app.js`, `windowAndGroup`)
- **Turning Live off never removes a row, only the live overlay.** Every
  departure — even an "Added" (unscheduled) one — carries a scheduled time
  per the time rules above (worked out from live time minus the reported
  delay when there's no real published match), so Live off just falls back
  to that instead of hiding the row. An earlier version of this app hid
  Added trains entirely when Live was off, which could empty the whole
  screen if the schedule data failed to match anything — fixed after
  hitting exactly that. Cancelled trains stay marked either way, since
  "don't wait for a train that isn't coming" is safety information, not a
  live-only detail. (`app.js`, `renderDepartures`, `renderRow`)
- **A boarding train shows one time (the live one) plus a "Boarding" label**,
  rather than a "scheduled → live" arrow — showing both looked confusing
  once a train is already at the platform. (`app.js`, `renderRow`)
- **The timetable window is "next 90 minutes, or at least 3 trains per
  destination, whichever is more."** Late at night trains can be more than
  90 minutes apart, so the "at least 3" rule keeps the screen from ever
  looking empty. Both numbers are constants in `config.js`
  (`DEPARTURE_WINDOW_MINUTES`, `MIN_PER_DESTINATION`) if you want the list
  longer or shorter.
- **The match tolerance is 12 minutes** (`config.js`,
  `MATCH_TOLERANCE_MINUTES`) — how far apart a live estimate and a scheduled
  time can be and still be treated as the same train. Wider catches more
  genuinely-late trains; narrower reduces the (rare) chance of matching the
  wrong train.
- **I could not test this against BART's live API myself** — the sandbox I
  built this in blocks outbound requests to `api.bart.gov` entirely (even
  for a read-only test), so I built strictly from BART's documented,
  long-stable API schema. Please do a real test run (section 4 above) before
  trusting it for your commute, and let me know if anything looks off — a
  field name mismatch would be the most likely surprise, and is a quick fix.

## Updating the app later (e.g. changing the API key)

1. On GitHub, open the file you want to change (e.g. `config.js`).
2. Click the pencil (✏️) icon to edit.
3. Make your change, then scroll down and click **Commit changes**.
4. GitHub Pages automatically rebuilds — refresh the app on your phone after
   a minute or so (you may need to fully close and reopen it, since it's
   cached like a regular home-screen app).

## Known limitations

- Around midnight Pacific time, right as the calendar date rolls over, the
  schedule briefly refetches for the new day — during that moment the list
  may look momentarily incomplete. Reload if that happens.
- The station list is cached in your browser after the first load (so
  reopening the app doesn't re-download it) — see `bart_stations_cache_v1`
  in your browser's local storage if you ever need to clear it, e.g. after
  BART opens a new station.
- This uses BART's classic JSON API (`api.bart.gov`), which is what all of
  BART's own real-time tools are built on; BART also publishes a separate
  GTFS-realtime feed, which this project doesn't use.
