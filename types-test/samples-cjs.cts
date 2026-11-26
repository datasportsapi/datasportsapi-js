// The same client through require (CommonJS).
import sdk = require("datasportsapi");
const client = new sdk.DataSportsAPI({ apiKey: "x" });
async function run() {
  const res = await client.teams.get(42);
  const name: string = res.data.name;
  const D = sdk.default;
  return [name, new D()];
}
void run;
