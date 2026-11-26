// ES module entry; the code lives in index.cjs.
import cjs from "./index.cjs";

export const {
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
} = cjs;
export default DataSportsAPI;
