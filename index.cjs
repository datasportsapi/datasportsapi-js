"use strict";
// datasportsapi 0.0.x: a minimal client for the DataSportsAPI REST API.
// One authenticated GET that returns the parsed JSON envelope and throws a
// DataSportsAPIError for any non-2xx answer. The full SDK (a typed method per
// endpoint, paging, retries, the WebSocket stream) arrives with 0.1.

const DEFAULT_BASE_URL = "https://api.datasportsapi.com";
const VERSION = "0.0.2";

function fromEnv(name) {
  return typeof process !== "undefined" && process.env ? process.env[name] : undefined;
}

class DataSportsAPIError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code the API's error code (e.g. "rate_limited"), or "http_<status>"
   * @param {string} message
   * @param {number | undefined} retryAfter seconds from Retry-After, when sent
   */
  constructor(status, code, message, retryAfter) {
    super(message);
    this.name = "DataSportsAPIError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

class DataSportsAPI {
  #apiKey;
  #baseUrl;
  #fetch;

  constructor(options = {}) {
    const apiKey = options.apiKey ?? fromEnv("DATASPORTSAPI_API_KEY");
    if (!apiKey) throw new Error("DataSportsAPI: pass { apiKey } or set DATASPORTSAPI_API_KEY");
    this.#apiKey = apiKey;
    this.#baseUrl = String(options.baseUrl ?? fromEnv("DATASPORTSAPI_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new Error("DataSportsAPI: no fetch in this runtime; pass { fetch }");
    // Called through a wrapper: browsers reject fetch called with another `this`.
    this.#fetch = (...args) => f(...args);
  }

  /**
   * GET a path of the API, e.g. get("/v2/livescores", { sport: "football" }).
   * Resolves to the parsed body ({ data, meta? }); rejects with DataSportsAPIError.
   */
  async get(path, query = {}) {
    const url = new URL(this.#baseUrl + (path.startsWith("/") ? path : `/${path}`));
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const headers = { Authorization: `Bearer ${this.#apiKey}`, Accept: "application/json" };
    if (typeof window === "undefined") headers["User-Agent"] = `datasportsapi-js/${VERSION}`;
    const res = await this.#fetch(url, { headers });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const err = (body && body.error) || {};
      const ra = Number(res.headers.get("retry-after"));
      throw new DataSportsAPIError(
        res.status,
        err.code || `http_${res.status}`,
        err.message || text.slice(0, 200) || res.statusText || `HTTP ${res.status}`,
        res.headers.has("retry-after") && Number.isFinite(ra) ? ra : undefined,
      );
    }
    return body;
  }
}

module.exports = { DataSportsAPI, DataSportsAPIError, VERSION, default: DataSportsAPI };
