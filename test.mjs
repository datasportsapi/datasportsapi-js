// Offline tests: a local HTTP + WebSocket server stands in for the API.
// Run: node test.mjs   (Node 22+; no network, no key: the key is the literal below)

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { inspect } from "node:util";
import test from "node:test";
import {
  APIConnectionError,
  AuthenticationError,
  BadRequestError,
  DataSportsAPI,
  DataSportsAPIError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ServiceUnavailableError,
  StreamError,
  VERSION,
} from "./index.mjs";
import cjs from "./index.cjs";

const KEY = "test-key-not-real";

/* ------------------------------------------------------------ test server */

/** A local server; `handle(req, body)` returns { status, json, headers } or a raw string. */
async function serve(handle) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const out = (await handle(req, body, seen.length)) ?? { status: 200, json: { data: null } };
    res.writeHead(out.status ?? 200, { "content-type": "application/json", ...(out.headers ?? {}) });
    res.end(out.raw ?? JSON.stringify(out.json ?? {}));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, seen, server, close: () => new Promise((r) => server.close(r)) };
}

/* A minimal WebSocket server (RFC 6455) on the same HTTP server, for the stream tests. */
function wsAccept(server, onSocket) {
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = {
      url: req.url,
      received: [],
      onFrame: null,
      send(obj) {
        const data = Buffer.from(JSON.stringify(obj));
        let head;
        if (data.length < 126) head = Buffer.from([0x81, data.length]);
        else if (data.length < 65536) {
          head = Buffer.alloc(4);
          head[0] = 0x81;
          head[1] = 126;
          head.writeUInt16BE(data.length, 2);
        } else {
          head = Buffer.alloc(10);
          head[0] = 0x81;
          head[1] = 127;
          head.writeBigUInt64BE(BigInt(data.length), 2);
        }
        socket.write(Buffer.concat([head, data]));
      },
      close(code, reason = "") {
        const r = Buffer.from(reason);
        const payload = Buffer.alloc(2 + r.length);
        payload.writeUInt16BE(code, 0);
        r.copy(payload, 2);
        socket.write(Buffer.concat([Buffer.from([0x88, payload.length]), payload]));
        socket.end();
      },
    };
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const masked = (buf[1] & 0x80) !== 0;
        assert.ok(masked, "client frames must be masked");
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
        buf = buf.subarray(off + 4 + len);
        if (op === 0x1) {
          const frame = JSON.parse(data.toString());
          conn.received.push(frame);
          conn.onFrame?.(frame);
        } else if (op === 0x8) {
          socket.end();
        }
      }
    });
    socket.on("error", () => {});
    onSocket(conn);
  });
}

const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/* ------------------------------------------------------------------ client */

test("exports and version", () => {
  assert.equal(VERSION, "0.1.0");
  assert.equal(cjs.DataSportsAPI, DataSportsAPI);
  assert.equal(cjs.default, DataSportsAPI);
});

test("the key: from the option or the environment, never shown", () => {
  const old = process.env.DATASPORTSAPI_API_KEY;
  delete process.env.DATASPORTSAPI_API_KEY;
  try {
    assert.throws(() => new DataSportsAPI(), /DATASPORTSAPI_API_KEY/);
    process.env.DATASPORTSAPI_API_KEY = KEY;
    const c = new DataSportsAPI();
    for (const shown of [inspect(c, { showHidden: true, depth: 5 }), JSON.stringify(c), String(c), Object.keys(c).join()]) {
      assert.ok(!shown.includes(KEY), `key visible in ${shown}`);
    }
  } finally {
    if (old === undefined) delete process.env.DATASPORTSAPI_API_KEY;
    else process.env.DATASPORTSAPI_API_KEY = old;
  }
});

test("base URL: https only, http just for localhost", () => {
  assert.throws(() => new DataSportsAPI({ apiKey: KEY, baseUrl: "http://api.example.com" }), /https/);
  assert.throws(() => new DataSportsAPI({ apiKey: KEY, baseUrl: "ftp://x" }), /https/);
  assert.throws(() => new DataSportsAPI({ apiKey: KEY, baseUrl: "https://u:p@api.example.com" }), /credentials/);
  new DataSportsAPI({ apiKey: KEY, baseUrl: "https://api.example.com/" });
  new DataSportsAPI({ apiKey: KEY, baseUrl: "http://localhost:8080" });
  new DataSportsAPI({ apiKey: KEY, baseUrl: "http://[::1]:8080" });
});

test("a secret key is refused in a browser unless allowed", () => {
  globalThis.window = {};
  globalThis.document = {};
  try {
    assert.throws(() => new DataSportsAPI({ apiKey: "sk_live_…" }), /web page/);
    new DataSportsAPI({ apiKey: "sk_live_…", dangerouslyAllowBrowser: true });
    new DataSportsAPI({ apiKey: "pk_live_…" });
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
});

test("a request: path, query, headers and the envelope", async () => {
  const s = await serve(() => ({ json: { data: [{ id: 1 }], meta: { page: 0 } } }));
  try {
    const c = new DataSportsAPI({ apiKey: KEY, baseUrl: s.base });
    const res = await c.teams.fixtures("a/b c", { type: "recent", page: 0, discipline: undefined });
    assert.deepEqual(res, { data: [{ id: 1 }], meta: { page: 0 } });
    await c.livescores.list({ sport: "football", finished: true });
    await c.fixtures.heatmap(5, 7);
    await c.sports.list();
    const [a, b, h, l] = s.seen;
    assert.equal(a.method, "GET");
    assert.equal(a.url, "/v2/teams/a%2Fb%20c/fixtures?type=recent&page=0");
    assert.equal(a.headers.authorization, `Bearer ${KEY}`);
    assert.equal(a.headers.accept, "application/json");
    assert.equal(a.headers["user-agent"], `datasportsapi-js/${VERSION}`);
    assert.equal(b.url, "/v2/livescores?sport=football&finished=true");
    assert.equal(h.url, "/v2/fixtures/5/heatmap/7");
    assert.equal(l.url, "/v2/sports");
    assert.ok(!s.seen.some((r) => r.url.includes(KEY)), "the key never goes in a URL");
    await assert.rejects(c.teams.get(), TypeError);
    await assert.rejects(c.teams.get(""), TypeError);
    await assert.rejects(c.teams.fixturesPages().next(), TypeError);
  } finally {
    await s.close();
  }
});

test("exports.create sends a JSON body", async () => {
  const s = await serve(() => ({ status: 202, json: { data: { id: 9, status: "queued" } } }));
  try {
    const c = new DataSportsAPI({ apiKey: KEY, baseUrl: s.base });
    const res = await c.exports.create({ league: 17, season: 61627, format: "csv" });
    assert.equal(res.data.id, 9);
    assert.equal(s.seen[0].method, "POST");
    assert.equal(s.seen[0].url, "/v2/exports");
    assert.equal(s.seen[0].headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(s.seen[0].body), { league: 17, season: 61627, format: "csv" });
  } finally {
    await s.close();
  }
});

test("one error class per status, with code, message, Retry-After and upgradeUrl", async () => {
  const cases = [
    [400, BadRequestError, "bad_request"],
    [401, AuthenticationError, "unauthorized"],
    [403, PermissionDeniedError, "endpoint_not_in_plan"],
    [404, NotFoundError, "not_found"],
    [429, RateLimitError, "quota_exceeded"],
    [500, InternalServerError, "internal_error"],
    [503, ServiceUnavailableError, "upstream_unavailable"],
    [418, DataSportsAPIError, "teapot"],
  ];
  let i = 0;
  const s = await serve(() => {
    const [status, , code] = cases[i++];
    return { status, json: { error: { code, message: `msg ${code}`, upgradeUrl: "https://datasportsapi.com/pricing/" } }, headers: { "retry-after": "70" } };
  });
  try {
    const c = new DataSportsAPI({ apiKey: KEY, baseUrl: s.base, maxRetries: 0 });
    for (const [status, Cls, code] of cases) {
      const err = await c.sports.list().then(
        () => null,
        (e) => e,
      );
      assert.ok(err instanceof Cls, `${status} → ${err && err.name}`);
      assert.ok(err instanceof DataSportsAPIError);
      assert.equal(err.status, status);
      assert.equal(err.code, code);
      assert.equal(err.message, `msg ${code}`);
      assert.equal(err.retryAfter, 70);
      assert.equal(err.upgradeUrl, "https://datasportsapi.com/pricing/");
      assert.ok(!String(err.stack).includes(KEY));
    }
  } finally {
    await s.close();
  }
  const raw = await serve(() => ({ status: 502, raw: "<html>bad gateway</html>", headers: { "content-type": "text/html" } }));
  try {
    const err = await new DataSportsAPI({ apiKey: KEY, baseUrl: raw.base }).sports.list().catch((e) => e);
    assert.equal(err.code, "http_502");
    assert.equal(err.constructor, DataSportsAPIError);
  } finally {
    await raw.close();
  }
});

test("retries: 429 rate_limited and 503 after Retry-After; never quota_exceeded", async () => {
  let n = 0;
  const s = await serve(() => {
    n++;
    if (n === 1) return { status: 429, json: { error: { code: "rate_limited", message: "slow down" } }, headers: { "retry-after": "0.05" } };
    if (n === 2) return { status: 503, json: { error: { code: "upstream_unavailable", message: "later" } }, headers: { "retry-after": "0" } };
    return { json: { data: "ok" } };
  });
  try {
    const c = new DataSportsAPI({ apiKey: KEY, baseUrl: s.base });
    const t0 = Date.now();
    assert.deepEqual(await c.sports.list(), { data: "ok" });
    assert.equal(n, 3);
    assert.ok(Date.now() - t0 >= 40, "waited for Retry-After");
  } finally {
    await s.close();
  }

  let q = 0;
  const quota = await serve(() => {
    q++;
    return { status: 429, json: { error: { code: "quota_exceeded", message: "used up" } }, headers: { "retry-after": "0" } };
  });
  try {
    const err = await new DataSportsAPI({ apiKey: KEY, baseUrl: quota.base }).sports.list().catch((e) => e);
    assert.equal(err.code, "quota_exceeded");
    assert.equal(q, 1, "quota_exceeded is not retried");
  } finally {
    await quota.close();
  }

  let m = 0;
  const always = await serve(() => {
    m++;
    return { status: 503, json: { error: { code: "upstream_unavailable", message: "down" } }, headers: { "retry-after": "0" } };
  });
  try {
    await assert.rejects(new DataSportsAPI({ apiKey: KEY, baseUrl: always.base, maxRetries: 2 }).sports.list(), ServiceUnavailableError);
    assert.equal(m, 3, "one try and two retries");
  } finally {
    await always.close();
  }

  let k = 0;
  const long = await serve(() => {
    k++;
    return { status: 429, json: { error: { code: "rate_limited", message: "wait" } }, headers: { "retry-after": "120" } };
  });
  try {
    const t0 = Date.now();
    const err = await new DataSportsAPI({ apiKey: KEY, baseUrl: long.base }).sports.list().catch((e) => e);
    assert.equal(err.retryAfter, 120);
    assert.equal(k, 1, "a Retry-After over 60 s is not waited for");
    assert.ok(Date.now() - t0 < 1000);
  } finally {
    await long.close();
  }
});

test("redirects are never followed: the key stays home", async () => {
  const other = await serve(() => ({ json: { data: "stolen" } }));
  const s = await serve(() => ({ status: 302, headers: { location: `${other.base}/v2/sports` }, json: {} }));
  try {
    const err = await new DataSportsAPI({ apiKey: KEY, baseUrl: s.base }).sports.list().catch((e) => e);
    assert.ok(err instanceof DataSportsAPIError);
    assert.equal(err.code, "redirect");
    assert.equal(other.seen.length, 0, "the redirect target got no request");
  } finally {
    await s.close();
    await other.close();
  }
});

test("connection errors and timeouts", async () => {
  const s = await serve(() => new Promise((r) => setTimeout(() => r({ json: { data: 1 } }), 300)));
  try {
    const err = await new DataSportsAPI({ apiKey: KEY, baseUrl: s.base, timeout: 50 }).sports.list().catch((e) => e);
    assert.ok(err instanceof APIConnectionError);
    assert.equal(err.code, "timeout");
    const ctl = new AbortController();
    const p = new DataSportsAPI({ apiKey: KEY, baseUrl: s.base }).sports.list({ signal: ctl.signal });
    ctl.abort(new Error("stop"));
    await assert.rejects(p, /stop/);
  } finally {
    await s.close();
  }
  const err = await new DataSportsAPI({ apiKey: KEY, baseUrl: "http://127.0.0.1:1" }).sports.list().catch((e) => e);
  assert.ok(err instanceof APIConnectionError);
  assert.equal(err.code, "connection_error");
});

test("pages: by page number, by cursor, capped by maxPages", async () => {
  const s = await serve((req) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/v2/teams/42/fixtures") {
      const page = Number(u.searchParams.get("page") ?? 0);
      return { json: { data: [page], meta: { page, hasNextPage: page < 2 } } };
    }
    if (u.pathname === "/v2/fixtures") {
      const cursor = u.searchParams.get("cursor");
      if (!cursor) return { json: { data: ["p0"], meta: { page: 0, hasNextPage: true, nextCursor: "c1" } } };
      if (cursor === "c1") return { json: { data: ["p1"], meta: { hasNextPage: true, nextCursor: "c2" } } };
      return { json: { data: ["p2"], meta: { hasNextPage: false, nextCursor: null } } };
    }
    return { status: 404, json: { error: { code: "not_found", message: "?" } } };
  });
  try {
    const c = new DataSportsAPI({ apiKey: KEY, baseUrl: s.base });
    const pages = [];
    for await (const p of c.teams.fixturesPages(42, { type: "recent" })) pages.push(p.data[0]);
    assert.deepEqual(pages, [0, 1, 2]);
    assert.ok(s.seen.every((r) => !r.url.startsWith("/v2/teams") || r.url.includes("type=recent")));

    const capped = [];
    for await (const p of c.teams.fixturesPages(42, {}, { maxPages: 2 })) capped.push(p.data[0]);
    assert.deepEqual(capped, [0, 1]);

    s.seen.length = 0;
    const cur = [];
    for await (const p of c.fixtures.listPages({ sport: "football", page: 0 })) cur.push(p.data[0]);
    assert.deepEqual(cur, ["p0", "p1", "p2"]);
    assert.equal(s.seen[1].url, "/v2/fixtures?sport=football&cursor=c1", "page is dropped once a cursor is used");
    assert.equal(s.seen[2].url, "/v2/fixtures?sport=football&cursor=c2");
  } finally {
    await s.close();
  }
});

/* ------------------------------------------------------------------ stream */

/** A local API with ticket minting and a WebSocket endpoint; `script(conn, n)` drives connection n. */
async function streamServer(script, ticketStatus = 200) {
  let tickets = 0;
  const conns = [];
  const s = await serve((req) => {
    if (req.url === "/v2/stream/ticket" && req.method === "POST") {
      tickets++;
      if (ticketStatus !== 200) return { status: ticketStatus, json: { error: { code: "ws_not_available", message: "Business and up" } } };
      return { json: { data: { ticket: `t${tickets}`, url: `ws://127.0.0.1:${s.server.address().port}/?ticket=t${tickets}`, expiresInSeconds: 30 } } };
    }
    return { status: 404, json: { error: { code: "not_found", message: "?" } } };
  });
  wsAccept(s.server, (conn) => {
    conns.push(conn);
    script(conn, conns.length);
  });
  return { ...s, conns, tickets: () => tickets };
}

const welcome = { type: "welcome", protocol: 5, heartbeatMs: 30000, maxChannels: 50, replay: true };
const fx = (id, extra = {}) => ({ id, sport: "football", status: { type: "inprogress", phase: "inprogress" }, homeScore: { current: 0, period1: 0 }, ...extra });

test("stream: ticket, subscribe, snapshot, merged deltas, gap → resync", async () => {
  const s = await streamServer((conn) => {
    conn.onFrame = (f) => {
      if (f.type === "subscribe" && f.channel === "livescores") {
        conn.send({ type: "snapshot", channel: "livescores", seq: 10, ts: 1, data: [fx(1), fx(2)] });
        conn.send({ type: "delta", channel: "livescores", seq: 11, ts: 2, id: 1, sport: "football", changes: { homeScore: { current: 1 }, clock: null } });
        conn.send({ type: "fixture", channel: "livescores", seq: 12, ts: 3, id: 3, sport: "football", data: fx(3) });
        conn.send({ type: "delta", channel: "livescores", seq: 13, ts: 4, id: 2, sport: "football", changes: { status: { type: "finished", phase: "finished" } } });
        conn.send({ type: "delta", channel: "livescores", seq: 15, ts: 5, id: 3, sport: "football", changes: { homeScore: { current: 2 } } });
      }
      if (f.type === "subscribe" && f.channel === "fixture:7") {
        conn.send({ type: "snapshot", channel: "fixture:7", seq: 1, ts: 1, data: fx(7) });
        conn.send({ type: "delta", channel: "fixture:7", seq: 2, ts: 2, id: 7, sport: "football", changes: { homeScore: { current: 3 } } });
        conn.send({ type: "error", code: "unknown_channel", message: "nope", channel: "sport:nope", ts: 3 });
      }
    };
    conn.send(welcome);
  });
  const c = new DataSportsAPI({ apiKey: KEY, baseUrl: s.base });
  const stream = c.stream(["livescores", "fixture:7"]);
  const deltas = [];
  const errors = [];
  stream.on("delta", (d) => deltas.push(d.id));
  stream.on("error", (e) => errors.push(e));
  try {
    await until(() => deltas.length === 4 && errors.length === 1);
    const conn = s.conns[0];
    assert.equal(conn.url, "/?ticket=t1", "only the ticket in the socket URL");
    assert.ok(!conn.url.includes(KEY));
    assert.deepEqual(
      conn.received.filter((f) => f.type === "subscribe").map((f) => f.channel),
      ["livescores", "fixture:7"],
    );
    await until(() => conn.received.some((f) => f.type === "resync"));
    assert.deepEqual(conn.received.find((f) => f.type === "resync"), { type: "resync", channel: "livescores" });
    const live = stream.fixtures("livescores");
    assert.deepEqual(
      live.map((f) => f.id),
      [1, 3],
      "the finished fixture left the list",
    );
    assert.deepEqual(live[0].homeScore, { current: 1, period1: 0 }, "objects merge key by key");
    assert.equal(live[0].clock, null, "null overwrites");
    assert.equal(live[1].homeScore.current, 2);
    live[0].homeScore.current = 99;
    assert.equal(stream.fixtures("livescores")[0].homeScore.current, 1, "fixtures() returns copies");
    assert.equal(stream.fixtures("fixture:7")[0].homeScore.current, 3);
    assert.ok(errors[0] instanceof StreamError);
    assert.equal(errors[0].code, "unknown_channel");
    assert.equal(errors[0].fatal, false);

    stream.unsubscribe("fixture:7");
    assert.deepEqual(stream.fixtures("fixture:7"), []);
    await until(() => conn.received.some((f) => f.type === "unsubscribe"));
  } finally {
    stream.close();
    await s.close();
  }
});

test("stream: 1012 reconnects at once with a new ticket and lastSeq", async () => {
  const s = await streamServer((conn, n) => {
    conn.onFrame = (f) => {
      if (f.type !== "subscribe") return;
      if (n === 1) {
        conn.send({ type: "snapshot", channel: "livescores", seq: 40, ts: 1, data: [fx(1)] });
        conn.send({ type: "delta", channel: "livescores", seq: 41, ts: 2, id: 1, sport: "football", changes: { homeScore: { current: 1 } } });
        setTimeout(() => conn.close(1012, "server restarting; reconnect"), 20);
      } else {
        conn.send({ type: "delta", channel: "livescores", seq: 42, ts: 3, id: 1, sport: "football", changes: { homeScore: { current: 2 } } });
        conn.send({ type: "subscribed", channel: "livescores", seq: 42, ts: 3, replayed: 1 });
      }
    };
    conn.send(welcome);
  });
  const c = new DataSportsAPI({ apiKey: KEY, baseUrl: s.base });
  const stream = c.stream(["livescores"]);
  const reconnects = [];
  stream.on("reconnect", (r) => reconnects.push(r));
  try {
    await until(() => stream.fixtures("livescores")[0]?.homeScore.current === 2);
    assert.equal(s.tickets(), 2, "a new ticket for the new connection");
    assert.equal(s.conns[1].url, "/?ticket=t2");
    assert.deepEqual(s.conns[1].received.find((f) => f.type === "subscribe"), { type: "subscribe", channel: "livescores", lastSeq: 41 });
    assert.equal(reconnects[0].code, 1012);
    assert.equal(reconnects[0].delay, 0);
  } finally {
    stream.close();
    await s.close();
  }
});

test("stream: 1008 ends it with one fatal error; so does a refused ticket", async () => {
  const s = await streamServer((conn) => {
    conn.send(welcome);
    setTimeout(() => conn.close(1008, "api key revoked"), 20);
  });
  const stream = new DataSportsAPI({ apiKey: KEY, baseUrl: s.base }).stream(["livescores"]);
  const errors = [];
  let closed = 0;
  stream.on("error", (e) => errors.push(e));
  stream.on("close", () => closed++);
  try {
    await until(() => closed === 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].fatal, true);
    assert.equal(s.tickets(), 1, "no reconnect after 1008");
  } finally {
    stream.close();
    await s.close();
  }

  const refused = await streamServer(() => {}, 403);
  const s2 = new DataSportsAPI({ apiKey: KEY, baseUrl: refused.base }).stream(["livescores"]);
  const errs = [];
  s2.on("error", (e) => errs.push(e));
  try {
    await until(() => errs.length === 1);
    assert.ok(errs[0] instanceof PermissionDeniedError);
    assert.equal(errs[0].code, "ws_not_available");
  } finally {
    s2.close();
    await refused.close();
  }
});

test("stream: a ticket url that is not wss is refused", async () => {
  const s = await serve(() => ({ json: { data: { ticket: "t", url: "http://evil.example/?ticket=t", expiresInSeconds: 30 } } }));
  const stream = new DataSportsAPI({ apiKey: KEY, baseUrl: s.base }).stream(["livescores"]);
  const errs = [];
  stream.on("error", (e) => errs.push(e));
  try {
    await until(() => errs.length === 1);
    assert.equal(errs[0].code, "bad_ticket");
  } finally {
    stream.close();
    await s.close();
  }
});
