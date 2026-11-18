# datasportsapi

The official JavaScript and TypeScript client for [DataSportsAPI](https://datasportsapi.com),
a sports data API: live scores, fixtures, lineups, statistics and standings for 24 sports.

> **Live API, minimal client.** The API answers today (free key: https://datasportsapi.com/signup/).
> This 0.0.x release is a minimal client: one authenticated `get()` with typed errors.
> The full SDK (a typed method for every endpoint, paging, retries and the WebSocket
> stream) arrives with 0.1. Docs: <https://datasportsapi.com/docs/sdks/>

```bash
npm install datasportsapi
```

```ts
import { DataSportsAPI, DataSportsAPIError } from "datasportsapi";

const client = new DataSportsAPI({ apiKey: process.env.DATASPORTSAPI_API_KEY });

try {
  const { data } = await client.get("/v2/livescores", { sport: "football" });
  console.log(data);
} catch (e) {
  if (e instanceof DataSportsAPIError) console.error(e.status, e.code, e.retryAfter);
  else throw e;
}
```

- `apiKey` defaults to `DATASPORTSAPI_API_KEY`; `baseUrl` to `DATASPORTSAPI_BASE_URL`, then
  `https://api.datasportsapi.com`.
- Works in Node 18+, Deno, Bun, browsers and edge runtimes (anything with `fetch`), as an
  ES module or with `require`.
- Get a key at <https://datasportsapi.com/signup/>.

MIT licensed. © Noventra Software Ltd.
