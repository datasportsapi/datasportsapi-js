// Live smoke test against the real API. Runs only when DATASPORTSAPI_API_KEY is set
// (never in CI): walks real ids and checks every answer is a { data } envelope.
//   DATASPORTSAPI_API_KEY=… node live.mjs
// Prints what it called, never the key.

import { DataSportsAPI, DataSportsAPIError } from "./index.mjs";

if (!process.env.DATASPORTSAPI_API_KEY) {
  console.log("live.mjs: DATASPORTSAPI_API_KEY is not set; skipped");
  process.exit(0);
}
const client = new DataSportsAPI();
let ok = 0;
const failed = [];
const call = async (label, fn) => {
  try {
    const res = await fn();
    if (!res || typeof res !== "object" || !("data" in res)) throw new Error("no data in the answer");
    ok++;
    return res;
  } catch (e) {
    // 404 no_data / not_supported and 403 not-in-plan are answers, not client failures.
    if (e instanceof DataSportsAPIError && (e.status === 404 || e.status === 403)) {
      ok++;
      return null;
    }
    failed.push(`${label}: ${e && e.message}`);
    return null;
  }
};

const today = new Date().toISOString().slice(0, 10);
await call("sports.list", () => client.sports.list());
const live = await call("livescores.list", () => client.livescores.list({ sport: "football" }));
const list = await call("fixtures.list", () => client.fixtures.list({ date: today, sport: "football" }));
const fixture = live?.data?.[0] ?? list?.data?.[0];
if (fixture) {
  const id = fixture.id;
  for (const m of ["get", "lineups", "statistics", "events", "h2h", "form", "momentum", "odds"]) await call(`fixtures.${m}`, () => client.fixtures[m](id));
  if (fixture.home?.id) {
    await call("teams.get", () => client.teams.get(fixture.home.id));
    let pages = 0;
    for await (const p of client.teams.fixturesPages(fixture.home.id, { type: "recent" }, { maxPages: 2 })) {
      if (!Array.isArray(p.data)) failed.push("teams.fixturesPages: data is not a list");
      pages++;
    }
    if (pages) ok++;
    await call("teams.squad", () => client.teams.squad(fixture.home.id));
  }
  if (fixture.league?.id) {
    const seasons = await call("leagues.seasons", () => client.leagues.seasons(fixture.league.id));
    const season = seasons?.data?.[0]?.id;
    await call("leagues.get", () => client.leagues.get(fixture.league.id));
    if (season) await call("leagues.standings", () => client.leagues.standings(fixture.league.id, { season }));
  }
}
const found = await call("search.query", () => client.search.query({ q: "messi" }));
const player = found?.data?.find?.((r) => r.type === "player");
if (player?.id) await call("players.get", () => client.players.get(player.id));
await call("leagues.popular", () => client.leagues.popular({ sport: "football" }));
await call("get()", () => client.get("/v2/sports"));

console.log(`live.mjs: ${ok} answers decoded${failed.length ? `, ${failed.length} failed:\n  ${failed.join("\n  ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
