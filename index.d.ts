export interface DataSportsAPIOptions {
  /** Your API key; defaults to the DATASPORTSAPI_API_KEY environment variable. */
  apiKey?: string;
  /** Defaults to DATASPORTSAPI_BASE_URL, then https://api.datasportsapi.com. */
  baseUrl?: string;
  /** A fetch implementation, for runtimes without a global one. */
  fetch?: typeof globalThis.fetch;
}

export type QueryValue = string | number | boolean | null | undefined;

export declare class DataSportsAPI {
  constructor(options?: DataSportsAPIOptions);
  /** GET a path of the API, e.g. get("/v2/livescores", { sport: "football" }). */
  get<T = unknown>(path: string, query?: Record<string, QueryValue>): Promise<T>;
}

export declare class DataSportsAPIError extends Error {
  readonly status: number;
  /** The API's error code ("rate_limited", "not_found", …), or "http_<status>". */
  readonly code: string;
  /** Seconds from Retry-After, when the API sent it. */
  readonly retryAfter: number | undefined;
}

export declare const VERSION: string;
export default DataSportsAPI;
