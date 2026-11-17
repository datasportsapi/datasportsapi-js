// node test.mjs — checks both entry points against a local fake API.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import esm, { DataSportsAPI, DataSportsAPIError } from "./index.mjs";

const require = createRequire(import.meta.url);
const cjs = require("./index.cjs");

const seen = [];
const server = createServer((req, res) => {
  seen.push({ url: req.url, auth: req.headers.authorization });
  if (req.url.startsWith("/v2/sports")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: 1, slug: "football" }] }));
  } else if (req.url.startsWith("/v2/limited")) {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
    res.end(JSON.stringify({ error: { code: "rate_limited", message: "Too many requests" } }));
  } else {
    res.writeHead(502, { "content-type": "text/html" });
    res.end("<html>bad gateway</html>");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;

try {
  assert.equal(esm, DataSportsAPI);
  assert.equal(cjs.DataSportsAPI, DataSportsAPI);

  const client = new DataSportsAPI({ apiKey: "dsa_live_test", baseUrl });
  const body = await client.get("/v2/sports", { sport: "football", live: true, skip: undefined });
  assert.deepEqual(body, { data: [{ id: 1, slug: "football" }] });
  assert.equal(seen.at(-1).auth, "Bearer dsa_live_test");
  assert.equal(seen.at(-1).url, "/v2/sports?sport=football&live=true");

  await assert.rejects(client.get("v2/limited"), (e) => {
    assert.ok(e instanceof DataSportsAPIError);
    assert.equal(e.status, 429);
    assert.equal(e.code, "rate_limited");
    assert.equal(e.retryAfter, 7);
    return true;
  });
  await assert.rejects(client.get("/v2/other"), (e) => e instanceof DataSportsAPIError && e.code === "http_502" && e.retryAfter === undefined);

  delete process.env.DATASPORTSAPI_API_KEY;
  assert.throws(() => new DataSportsAPI(), /DATASPORTSAPI_API_KEY/);
  process.env.DATASPORTSAPI_API_KEY = "dsa_live_env";
  process.env.DATASPORTSAPI_BASE_URL = baseUrl;
  await new cjs.DataSportsAPI().get("/v2/sports");
  assert.equal(seen.at(-1).auth, "Bearer dsa_live_env");

  console.log("datasportsapi js: all checks passed");
} finally {
  server.close();
}
