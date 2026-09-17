// =====================================================================
// OPTIONAL Cloudflare Worker — CORS proxy for the BART API.
//
// Only deploy this if you tested the app with API_BASE pointing
// directly at https://api.bart.gov/api and saw a CORS error in your
// browser's console. See README.md > "If direct requests don't work"
// for the full step-by-step.
//
// What it does: forwards every request it gets straight through to
// api.bart.gov, keeping the path and query string, then adds the
// "allow cross-origin requests" header that BART's API itself doesn't
// send. It doesn't store anything or add your API key — your key
// still travels in the URL from the browser, same as a direct call.
// =====================================================================

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    const target = new URL(`https://api.bart.gov/api${incoming.pathname}${incoming.search}`);

    const upstream = await fetch(target.toString(), {
      headers: { Accept: 'application/json' },
    });
    const body = await upstream.text();

    return new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });
  },
};
