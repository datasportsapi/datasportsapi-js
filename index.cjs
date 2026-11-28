"use strict";
// datasportsapi: the official TypeScript/JavaScript client for the DataSportsAPI
// sports data API. One method per endpoint (built from operations.cjs, generated
// from the OpenAPI document), retries on 429 rate_limited and 503, page iterators
// and the live WebSocket stream. No dependencies; Node 22+, Deno, Bun, browsers.
// The rules it follows: sdk/notes.md in the source repository ("0.1: the contract").

const { operations: OPERATIONS, ticketPath: TICKET_PATH } = require("./operations.cjs");

const VERSION = "0.2.0";
const DEFAULT_BASE_URL = "https://api.datasportsapi.com";
const KEY_ENV = "DATASPORTSAPI_API_KEY";
const BASE_ENV = "DATASPORTSAPI_BASE_URL";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_RETRY_AFTER = 60; // seconds; a longer wait is returned as the error
const MAX_FRAME = 16 * 1024 * 1024;

const env = (name) => (typeof process !== "undefined" && process.env ? process.env[name] : undefined);
const inBrowser = () => typeof window !== "undefined" && typeof document !== "undefined";

/* ------------------------------------------------------------------ errors */

class DataSportsAPIError extends Error {
  constructor(status, code, message, retryAfter, upgradeUrl, options) {
    super(message, options);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.upgradeUrl = upgradeUrl;
  }
}
class BadRequestError extends DataSportsAPIError {}
class AuthenticationError extends DataSportsAPIError {}
class PermissionDeniedError extends DataSportsAPIError {}
class NotFoundError extends DataSportsAPIError {}
class RateLimitError extends DataSportsAPIError {}
class InternalServerError extends DataSportsAPIError {}
class ServiceUnavailableError extends DataSportsAPIError {}
class APIConnectionError extends DataSportsAPIError {}
const BY_STATUS = {
  400: BadRequestError,
  401: AuthenticationError,
  403: PermissionDeniedError,
  404: NotFoundError,
  429: RateLimitError,
  500: InternalServerError,
  503: ServiceUnavailableError,
};

class StreamError extends Error {
  constructor(code, message, channel, fatal) {
    super(message);
    this.name = "StreamError";
    this.code = code;
    this.channel = channel;
    this.fatal = !!fatal;
  }
}

/** Seconds from a Retry-After header (a number or an HTTP date), or undefined. */
function retryAfterOf(res) {
  const raw = res.headers.get("retry-after");
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (Number.isFinite(n)) return Math.max(0, n);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, (when - Date.now()) / 1000) : undefined;
}

function errorFrom(res, text) {
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  const e = (body && typeof body === "object" && body.error) || {};
  const status = res.status;
  const Cls = BY_STATUS[status] ?? DataSportsAPIError;
  const message = typeof e.message === "string" && e.message ? e.message : res.statusText || `HTTP ${status}`;
  return new Cls(status, typeof e.code === "string" && e.code ? e.code : `http_${status}`, message, retryAfterOf(res), typeof e.upgradeUrl === "string" ? e.upgradeUrl : undefined);
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/* ------------------------------------------------------------------ client */

const send = Symbol("send");
const ticket = Symbol("ticket");
const wsCtor = Symbol("WebSocket");
const isLocal = Symbol("isLocal");

class DataSportsAPI {
  #apiKey;
  #baseUrl;
  #fetch;
  #timeout;
  #maxRetries;

  constructor(options = {}) {
    const apiKey = options.apiKey ?? env(KEY_ENV);
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error(`DataSportsAPI: pass { apiKey } or set ${KEY_ENV}`);
    if (/\s/.test(apiKey.trim())) throw new Error("DataSportsAPI: the API key contains whitespace");
    if (inBrowser() && apiKey.startsWith("sk_") && options.dangerouslyAllowBrowser !== true) {
      throw new Error(
        "DataSportsAPI: a secret API key in a web page can be read by anyone who opens it. Call the API from your server instead (or pass dangerouslyAllowBrowser: true if you really mean it).",
      );
    }
    const base = String(options.baseUrl ?? env(BASE_ENV) ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    let url;
    try {
      url = new URL(base);
    } catch {
      throw new Error("DataSportsAPI: baseUrl is not a valid URL");
    }
    const local = LOCAL_HOSTS.has(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      throw new Error("DataSportsAPI: baseUrl must use https:// (http:// is allowed only for localhost)");
    }
    if (url.username || url.password || url.search || url.hash) throw new Error("DataSportsAPI: baseUrl must not carry credentials, a query or a fragment");
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new Error("DataSportsAPI: no fetch in this runtime; pass { fetch }");
    const timeout = options.timeout ?? 30_000;
    if (!(Number.isFinite(timeout) && timeout > 0)) throw new Error("DataSportsAPI: timeout must be a positive number of milliseconds");
    const maxRetries = options.maxRetries ?? 2;
    if (!(Number.isInteger(maxRetries) && maxRetries >= 0)) throw new Error("DataSportsAPI: maxRetries must be a whole number, 0 or more");

    this.#apiKey = apiKey.trim();
    this.#baseUrl = base;
    // Called through a wrapper: browsers reject fetch called with another `this`.
    this.#fetch = (...args) => f(...args);
    this.#timeout = timeout;
    this.#maxRetries = maxRetries;
    Object.defineProperty(this, wsCtor, { value: options.WebSocket });
    Object.defineProperty(this, isLocal, { value: local });

    for (const op of OPERATIONS) {
      const group = this[op.group] ?? Object.defineProperty(this, op.group, { value: {}, enumerable: true })[op.group];
      // A bad argument rejects the promise (or the first next() of a page iterator), never throws on the spot.
      group[op.name] = (...args) => {
        try {
          return this.#call(op, args, false);
        } catch (e) {
          return Promise.reject(e);
        }
      };
      if (op.paged) {
        const self = this;
        group[`${op.name}Pages`] = async function* (...args) {
          yield* self.#call(op, args, true);
        };
      }
    }
  }

  /** The base URL only: the key never shows in logs or JSON. */
  toJSON() {
    return { baseUrl: this.#baseUrl };
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `DataSportsAPI { baseUrl: '${this.#baseUrl}' }`;
  }

  /** GET any path of the API, e.g. get("/v2/livescores", { sport: "football" }). */
  get(path, query = {}, options = {}) {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) throw new Error("DataSportsAPI: get() takes a path that starts with one /");
    return this[send]("GET", path, query, undefined, options);
  }

  stream(channels, options = {}) {
    // eslint-disable-next-line no-use-before-define
    return new Stream(this, channels, options);
  }

  #call(op, args, pages) {
    const n = op.pathParams.length;
    if (args.length < n) throw new TypeError(`${op.group}.${op.name}() takes ${op.pathParams.join(", ")} first`);
    let path = op.path;
    op.pathParams.forEach((name, i) => {
      const v = args[i];
      if ((typeof v !== "number" && typeof v !== "string") || v === "" || (typeof v === "number" && !Number.isFinite(v))) {
        throw new TypeError(`${op.group}.${op.name}(): ${name} must be a number or a non-empty string`);
      }
      path = path.replace(`{${name}}`, encodeURIComponent(String(v)));
    });
    const takesParams = op.query.length > 0 || op.body;
    const params = takesParams ? (args[n] ?? {}) : {};
    const options = (takesParams ? args[n + 1] : args[n]) ?? {};
    if (typeof params !== "object" || Array.isArray(params)) throw new TypeError(`${op.group}.${op.name}(): params must be an object`);
    if (op.body) return this[send](op.method, path, {}, params, options);
    const query = {};
    for (const k of op.query) if (params[k] !== undefined) query[k] = params[k];
    if (pages) return this.#pages(op, path, query, options);
    return this[send](op.method, path, query, undefined, options);
  }

  async *#pages(op, path, query, options) {
    const max = options.maxPages ?? Infinity;
    let q = { ...query };
    for (let n = 0; n < max; n++) {
      const res = await this[send](op.method, path, q, undefined, options);
      yield res;
      const meta = (res && res.meta) || {};
      if (op.paged.cursor && typeof meta.nextCursor === "string" && meta.nextCursor) {
        const { page: _page, ...rest } = q;
        q = { ...rest, cursor: meta.nextCursor };
      } else if (meta.hasNextPage === true) {
        const at = Number.isInteger(meta.page) ? meta.page : Number.isInteger(Number(q.page)) ? Number(q.page) : 0;
        q = { ...q, page: at + 1 };
      } else return;
    }
  }

  async [send](method, path, query, body, options = {}) {
    const url = new URL(this.#baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, typeof v === "boolean" ? (v ? "true" : "false") : String(v));
    }
    const headers = { Authorization: `Bearer ${this.#apiKey}`, Accept: "application/json" };
    if (!inBrowser()) headers["User-Agent"] = `datasportsapi-js/${VERSION}`;
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const timeout = options.timeout ?? this.#timeout;
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, timeout);
      const onAbort = () => ctl.abort(options.signal.reason);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      let res;
      let text;
      try {
        if (options.signal?.aborted) throw options.signal.reason;
        // redirect "manual": a 3xx is never followed, so the key cannot travel to another host.
        res = await this.#fetch(url, { method, headers, body: payload, signal: ctl.signal, redirect: "manual" });
        text = await res.text();
      } catch (e) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (timedOut) throw new APIConnectionError(0, "timeout", `No answer within ${timeout} ms`, undefined, undefined);
        throw new APIConnectionError(0, "connection_error", `Could not reach the API: ${e && e.message ? e.message : e}`, undefined, undefined, { cause: e });
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      }
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        throw new DataSportsAPIError(res.status, "redirect", "The API answered with a redirect, which the client does not follow", undefined, undefined);
      }
      if (res.status >= 200 && res.status < 300) {
        if (!text) return undefined;
        try {
          return JSON.parse(text);
        } catch {
          throw new DataSportsAPIError(res.status, "invalid_json", "The API's answer was not valid JSON", undefined, undefined);
        }
      }
      const err = errorFrom(res, text);
      const retryable = (err.status === 429 && err.code === "rate_limited") || err.status === 503;
      if (!retryable || attempt >= this.#maxRetries) throw err;
      if (err.retryAfter !== undefined && err.retryAfter > MAX_RETRY_AFTER) throw err;
      const wait = err.retryAfter !== undefined ? err.retryAfter : Math.min(2 ** attempt, 8);
      await sleep(wait * 1000, options.signal);
    }
  }

  async [ticket]() {
    const res = await this[send]("POST", TICKET_PATH, {}, undefined, {});
    const d = res && res.data;
    if (!d || typeof d.ticket !== "string" || typeof d.url !== "string") throw new StreamError("bad_ticket", "The ticket answer had no ticket or url", undefined, true);
    return d;
  }
}

/* ------------------------------------------------------------------ stream */

const LIST_CHANNEL = /^(livescores|sport:[^:]+|league:\d+|team:\d+)$/;
const FIXTURE_CHANNEL = /^fixture:\d+$/;
const GONE = new Set(["finished", "canceled", "postponed"]);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Objects merge key by key; every other value, null included, overwrites. */
function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (isObj(v) && isObj(target[k])) deepMerge(target[k], v);
    else target[k] = isObj(v) || Array.isArray(v) ? structuredClone(v) : v;
  }
  return target;
}

class Stream {
  #client;
  #options;
  #channels = new Set();
  #lastSeq = new Map();
  #state = new Map(); // list channel → Map(id → fixture); fixture channel → { one: fixture | null }
  #listeners = new Map();
  #ws = null;
  #welcomed = false;
  #replay = false;
  #closed = false;
  #backoff = 1000;
  #heartbeat = null;
  #retryTimer = null;
  #lastRx = 0;

  constructor(client, channels, options) {
    if (!Array.isArray(channels) || !channels.length || channels.some((c) => typeof c !== "string" || !c)) {
      throw new TypeError("stream() takes a non-empty array of channel names");
    }
    this.#client = client;
    this.#options = options ?? {};
    for (const c of channels) this.#channels.add(c);
    // Connect on the next tick, so listeners added right after stream() see every event.
    setTimeout(() => this.#connect(), 0);
  }

  get channels() {
    return [...this.#channels];
  }

  on(event, listener) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(listener);
    return this;
  }

  off(event, listener) {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  #emit(event, ...args) {
    for (const fn of [...(this.#listeners.get(event) ?? [])]) {
      try {
        fn(...args);
      } catch (e) {
        // A listener's own bug must not stop the stream; report it out of band.
        setTimeout(() => {
          throw e;
        }, 0);
      }
    }
  }

  fixtures(channel) {
    const s = this.#state.get(channel);
    if (!s) return [];
    if (s instanceof Map) return [...s.values()].map((f) => structuredClone(f));
    return s.one ? [structuredClone(s.one)] : [];
  }

  subscribe(channel) {
    if (typeof channel !== "string" || !channel) throw new TypeError("subscribe() takes a channel name");
    if (this.#channels.has(channel)) return;
    this.#channels.add(channel);
    if (this.#welcomed) this.#send({ type: "subscribe", channel });
  }

  unsubscribe(channel) {
    if (!this.#channels.delete(channel)) return;
    this.#lastSeq.delete(channel);
    this.#state.delete(channel);
    if (this.#welcomed) this.#send({ type: "unsubscribe", channel });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopTimers();
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      try {
        ws.close(1000, "client closed");
      } catch {
        /* already closing */
      }
    }
    this.#emit("close");
  }

  #fatal(err) {
    if (this.#closed) return;
    this.#emit("error", err);
    this.close();
  }

  #stopTimers() {
    clearInterval(this.#heartbeat);
    clearTimeout(this.#retryTimer);
    this.#heartbeat = null;
    this.#retryTimer = null;
  }

  #send(frame) {
    const ws = this.#ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(frame));
  }

  #reconnect(code, reason, delay) {
    if (this.#closed) return;
    this.#stopTimers();
    this.#emit("reconnect", { code, reason, delay });
    this.#retryTimer = setTimeout(() => this.#connect(), delay);
  }

  #backoffDelay() {
    const d = Math.min(this.#backoff, 30_000);
    this.#backoff = Math.min(this.#backoff * 2, 30_000);
    return Math.round(d / 2 + Math.random() * (d / 2));
  }

  async #connect() {
    if (this.#closed) return;
    this.#welcomed = false;
    let t;
    try {
      t = await this.#client[ticket]();
    } catch (e) {
      if (this.#closed) return;
      if (e instanceof StreamError || (e instanceof DataSportsAPIError && (e.status === 401 || e.status === 403 || e.status === 404 || e.status === 400))) return this.#fatal(e);
      return this.#reconnect(0, e && e.message ? e.message : "ticket request failed", this.#backoffDelay());
    }
    if (this.#closed) return;
    let url;
    try {
      url = new URL(t.url);
    } catch {
      return this.#fatal(new StreamError("bad_ticket", "The ticket's url is not a valid URL", undefined, true));
    }
    if (!(url.protocol === "wss:" || (url.protocol === "ws:" && this.#client[isLocal]))) {
      return this.#fatal(new StreamError("bad_ticket", "The ticket's url is not a wss:// address", undefined, true));
    }
    if (!url.searchParams.has("ticket")) url.searchParams.set("ticket", t.ticket);
    const WS = this.#options.WebSocket ?? this.#client[wsCtor] ?? globalThis.WebSocket;
    if (typeof WS !== "function") return this.#fatal(new StreamError("no_websocket", "No WebSocket in this runtime; pass { WebSocket }", undefined, true));
    let ws;
    try {
      ws = new WS(url.toString());
    } catch (e) {
      return this.#reconnect(0, e && e.message ? e.message : "connect failed", this.#backoffDelay());
    }
    this.#ws = ws;
    this.#lastRx = Date.now();
    ws.onmessage = (ev) => {
      if (this.#ws !== ws) return;
      this.#lastRx = Date.now();
      const data = typeof ev.data === "string" ? ev.data : null;
      if (data === null) return; // the server sends text frames only
      if (data.length > MAX_FRAME) {
        ws.close(1009, "frame too large");
        return;
      }
      let frame;
      try {
        frame = JSON.parse(data);
      } catch {
        return;
      }
      if (isObj(frame) && typeof frame.type === "string") this.#handle(frame);
    };
    ws.onerror = () => {
      /* the close event follows */
    };
    ws.onclose = (ev) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#welcomed = false;
      this.#onClose(ev.code ?? 1006, ev.reason ?? "");
    };
  }

  #onClose(code, reason) {
    if (this.#closed) return;
    this.#stopTimers();
    if (code === 1012) return this.#reconnect(code, reason, 0);
    if (code === 1008) {
      if (/reconnect/i.test(reason)) return this.#reconnect(code, reason, 0);
      return this.#fatal(new StreamError("policy_violation", `The server closed the stream: ${reason || "ticket rejected or key revoked"}`, undefined, true));
    }
    if (code === 1013) return this.#fatal(new StreamError("too_many_connections", "Your plan's limit on open stream connections is reached", undefined, true));
    return this.#reconnect(code, reason, this.#backoffDelay());
  }

  #startHeartbeat(ms) {
    clearInterval(this.#heartbeat);
    this.#heartbeat = setInterval(() => {
      const ws = this.#ws;
      if (!ws) return;
      if (Date.now() - this.#lastRx > 2 * ms + 5000) {
        // Silent socket: drop it; onclose reconnects.
        try {
          ws.close(4000, "heartbeat timeout");
        } catch {
          /* ignore */
        }
        if (this.#ws === ws) {
          this.#ws = null;
          this.#onClose(4000, "heartbeat timeout");
        }
        return;
      }
      this.#send({ type: "ping" });
    }, ms);
  }

  #seq(frame) {
    if (typeof frame.seq !== "number" || typeof frame.channel !== "string") return;
    const last = this.#lastSeq.get(frame.channel);
    if (last !== undefined && frame.seq > last + 1) this.#send({ type: "resync", channel: frame.channel });
    this.#lastSeq.set(frame.channel, frame.seq);
  }

  #handle(frame) {
    const ch = frame.channel;
    switch (frame.type) {
      case "welcome": {
        this.#welcomed = true;
        this.#replay = frame.replay === true;
        this.#backoff = 1000;
        this.#startHeartbeat(Number.isFinite(frame.heartbeatMs) && frame.heartbeatMs > 0 ? frame.heartbeatMs : 30_000);
        for (const c of this.#channels) {
          const sub = { type: "subscribe", channel: c };
          if (this.#replay && this.#lastSeq.has(c)) sub.lastSeq = this.#lastSeq.get(c);
          this.#send(sub);
        }
        this.#emit("open", frame);
        break;
      }
      case "snapshot": {
        if (typeof frame.seq === "number" && typeof ch === "string") this.#lastSeq.set(ch, frame.seq);
        if (!this.#channels.has(ch)) break;
        if (LIST_CHANNEL.test(ch)) {
          const m = new Map();
          if (Array.isArray(frame.data)) for (const f of frame.data) if (isObj(f) && f.id != null) m.set(f.id, structuredClone(f));
          this.#state.set(ch, m);
        } else if (FIXTURE_CHANNEL.test(ch)) {
          this.#state.set(ch, { one: isObj(frame.data) ? structuredClone(frame.data) : null });
        }
        break;
      }
      case "subscribed":
        if (typeof frame.seq === "number" && typeof ch === "string") this.#lastSeq.set(ch, frame.seq);
        break;
      case "fixture": {
        this.#seq(frame);
        const s = this.#state.get(ch);
        if (s instanceof Map && isObj(frame.data)) s.set(frame.id, structuredClone(frame.data));
        break;
      }
      case "delta": {
        this.#seq(frame);
        const s = this.#state.get(ch);
        if (!isObj(frame.changes)) break;
        if (s instanceof Map) {
          const f = s.get(frame.id);
          if (f) {
            deepMerge(f, frame.changes);
            if (GONE.has(f.status && f.status.type)) s.delete(frame.id);
          }
        } else if (s && s.one && s.one.id === frame.id) {
          deepMerge(s.one, frame.changes);
        }
        break;
      }
      case "unsubscribed":
      case "pong":
        break;
      case "error":
        this.#emit("error", new StreamError(String(frame.code ?? "error"), String(frame.message ?? "stream error"), ch, false));
        this.#emit("frame", frame);
        return;
      default:
        this.#seq(frame);
    }
    this.#emit("frame", frame);
    this.#emit(frame.type, frame);
  }
}

module.exports = {
  DataSportsAPI,
  DataSportsAPIError,
  BadRequestError,
  AuthenticationError,
  PermissionDeniedError,
  NotFoundError,
  RateLimitError,
  InternalServerError,
  ServiceUnavailableError,
  APIConnectionError,
  StreamError,
  Stream,
  VERSION,
  default: DataSportsAPI,
};
