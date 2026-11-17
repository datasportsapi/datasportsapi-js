// ES module entry; the code lives in index.cjs.
import cjs from "./index.cjs";

export const { DataSportsAPI, DataSportsAPIError, VERSION } = cjs;
export default DataSportsAPI;
