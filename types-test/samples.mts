// Compile-only check: the samples on https://datasportsapi.com/sdks/typescript/ (src/data/sdks.ts)
// must type-check against index.d.mts (the import resolves to this package by its own name).
// Run: npx tsc -p sdk/js/types-test
import DataSportsAPIDefault, { DataSportsAPI, NotFoundError, PermissionDeniedError, type Fixture } from "datasportsapi";

declare const apiKey: string;
declare const baseUrl: string;

async function main() {
  const client = new DataSportsAPI({ apiKey: process.env.DATASPORTSAPI_API_KEY });
  const { data: live } = await client.livescores.list({ sport: "football" });
  const { data: table, meta } = await client.leagues.standings(17, { season: 61627 });
  const { data: lineups } = await client.fixtures.lineups(211521);
  const first: Fixture | undefined = live[0];
  console.log(first?.home?.name, table, meta, lineups);

  try {
    await client.fixtures.momentum(211521);
  } catch (e) {
    if (e instanceof PermissionDeniedError) console.error(e.code);
    if (e instanceof NotFoundError) console.error(e.code);
  }

  new DataSportsAPI({ apiKey, baseUrl, timeout: 30_000, maxRetries: 2 });

  for await (const page of client.teams.fixturesPages(42, { type: "recent" }, { maxPages: 5 })) {
    console.log(page.meta?.page, page.data.length);
  }

  const stream = client.stream(["livescores", "fixture:211521"]);
  stream.on("delta", (frame) => console.log(frame.id, frame.changes));
  stream.on("error", (err) => console.error(err));
  console.log(stream.fixtures("livescores").length, "live");
  stream.close();

  // Every endpoint line style: no params, path + query, body.
  await client.sports.list();
  await client.search.query({ q: "messi" });
  await client.exports.create({ league: 17, season: 61627 });
  await client.rankings.get("fifa-men");
  await client.fixtures.heatmap(1, 2);
  const raw = await client.get<{ data: unknown }>("/v2/sports");
  console.log(raw.data, new DataSportsAPIDefault());
}
void main;
