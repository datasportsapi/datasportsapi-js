# datasportsapi

The official TypeScript and JavaScript client for [DataSportsAPI](https://datasportsapi.com),
a real-time sports data API: live scores, fixtures, lineups, statistics, standings, odds
and more for 25 sports, over REST and a WebSocket stream.

- A typed method for every endpoint, named after its URL (`client.leagues.standings(…)`).
- Typed answers: every object of the API has a type your editor completes.
- Retries on `429 rate_limited` and `503`, after the `Retry-After` the API sends.
- Page iterators for the paged lists.
- The live stream with tickets, reconnects, replay and merged fixture state built in.
- No runtime dependencies. ESM and CommonJS. Node 22+, Deno, Bun and edge runtimes.

Docs: <https://datasportsapi.com/sdks/typescript/> · API reference: <https://datasportsapi.com/docs/>

## Install

```bash
npm install datasportsapi
```

## Pass the key

```ts
import { DataSportsAPI } from "datasportsapi";

const client = new DataSportsAPI({ apiKey: process.env.DATASPORTSAPI_API_KEY });
// with no apiKey, the client reads DATASPORTSAPI_API_KEY
```

Get a key (the Free plan needs no card) at <https://datasportsapi.com/signup/>.

## Make a request

Path values come first, in the order the URL has them; query parameters follow in one
object, under the names the REST docs use. Every method resolves to the API's
`{ data, meta }` envelope.

```ts
const { data: live } = await client.livescores.list({ sport: "football" });
const { data: table, meta } = await client.leagues.standings(17, { season: 61627 });
const { data: lineups } = await client.fixtures.lineups(211521);
```

`client.get("/v2/…", query)` reaches any path directly, for an endpoint newer than your
installed version.

## Errors

Each HTTP status has its own error class; all extend `DataSportsAPIError` and carry
`status`, `code` (the API's error code: branch on this, not on the message), `message`,
`retryAfter` (seconds) and, on plan limits, `upgradeUrl`.

```ts
import { NotFoundError, PermissionDeniedError } from "datasportsapi";

try {
  await client.fixtures.momentum(211521);
} catch (e) {
  if (e instanceof PermissionDeniedError) console.error(e.code); // endpoint_not_in_plan, …
  if (e instanceof NotFoundError) console.error(e.code); // not_found | no_data | not_supported
}
```

| Status | Class | Codes |
|---|---|---|
| 400 | `BadRequestError` | `bad_request` |
| 401 | `AuthenticationError` | `unauthorized` |
| 403 | `PermissionDeniedError` | `endpoint_not_in_plan`, `history_not_in_plan`, `ws_not_available`, … |
| 404 | `NotFoundError` | `not_found`, `no_data`, `not_supported` |
| 429 | `RateLimitError` | `rate_limited`, `quota_exceeded`, `export_limit` |
| 500 | `InternalServerError` | `internal_error` |
| 503 | `ServiceUnavailableError` | `upstream_unavailable` |
| — | `APIConnectionError` | `connection_error`, `timeout` (no answer arrived) |

## Retries and settings

`429 rate_limited` and `503` are tried again after their `Retry-After`, twice by default.
`429 quota_exceeded` never is: the quota does not refill within seconds. A `Retry-After`
longer than 60 seconds is handed to you as the error instead of being waited out.

```ts
new DataSportsAPI({
  apiKey,            // or DATASPORTSAPI_API_KEY
  baseUrl,           // or DATASPORTSAPI_BASE_URL
  timeout: 30_000,   // milliseconds, for each attempt
  maxRetries: 2,
});
```

Every method also takes `{ signal, timeout }` as its last argument.

## Paging

A paged endpoint has an iterator named after its method with a `Pages` suffix. It yields
one envelope per page and stops when the list ends, or after `maxPages`.

```ts
for await (const page of client.teams.fixturesPages(42, { type: "recent" }, { maxPages: 5 })) {
  console.log(page.meta?.page, page.data.length);
}
```

## Live stream (Business and up)

```ts
const stream = client.stream(["livescores", "fixture:211521"]);

stream.on("delta", (frame) => console.log(frame.id, frame.changes));
stream.on("error", (err) => console.error(err));

// the stream's own copy of every fixture, deltas applied
console.log(stream.fixtures("livescores").length, "live");

stream.close();
```

The stream mints a single-use ticket for each connection, subscribes, and after a dropped
socket reconnects and replays the frames it missed (or resyncs). A server restart (close
code 1012) is met with an immediate reconnect. On the fixture channels (`livescores`,
`sport:*`, `league:*`, `team:*`, `fixture:*`) it keeps a merged copy of every fixture and
drops finished ones from the lists. Events: `open`, `frame`, every frame type (`delta`,
`snapshot`, `odds`, …), `error`, `reconnect`, `close`. In Node it uses the built-in
`WebSocket` (Node 22+); elsewhere pass `{ WebSocket }`.

## Security

- Your secret key goes only in the `Authorization` header, only to the API's address. It is
  never put in a URL (the stream uses a single-use ticket instead) and never shown when you
  log or serialise the client.
- The base URL must be `https://` (plain `http://` only for `localhost`).
- Redirects are not followed, so the key cannot be carried to another host.
- A secret key (`sk_…`) in a web page can be read by anyone who opens it: in a browser the
  client refuses one unless you pass `dangerouslyAllowBrowser: true`. Call the API from your
  server and keep the key in an environment variable or a secret manager.

MIT licensed. © DataSportsAPI.
