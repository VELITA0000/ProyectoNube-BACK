/**
 * Smoke test GET /health. Set API_BASE_URL to the deployed HTTP API (no trailing slash).
 * Example: API_BASE_URL=https://xxxx.execute-api.us-east-1.amazonaws.com npm run smoke
 * If API_BASE_URL is unset, defaults to http://127.0.0.1:PORT for ad-hoc local use.
 */
const port = process.env.PORT || 4000;
const base = (process.env.API_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/$/, "");
const url = `${base}/health`;
const res = await fetch(url);
const body = await res.text();
if (!res.ok) {
  console.error(res.status, body);
  process.exit(1);
}
console.log(res.status, body);
