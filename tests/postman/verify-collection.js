const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const os = require("node:os");
const { createFixture } = require("../helpers/reservation-fixture");
const execute = promisify(execFile);

async function main() {
  const fixture = await createFixture();
  try {
    const args = ["--yes", "--cache", process.env.NPM_CONFIG_CACHE || path.join(os.tmpdir(), "tixgo-npm-cache"),
      "--package=newman@6.2.1", "--", "newman", "run", path.join(__dirname, "booking-reservations.postman_collection.json"),
      "--env-var", `base_url=${fixture.baseUrl}`, "--env-var", `organizer_token=${fixture.organizer.token}`,
      "--env-var", `buyer_email=${randomUUID()}@postman.test`, "--env-var", "buyer_password=Postman-test-password",
      "--reporters", "cli", "--timeout-request", "10000"];
    const result = await execute("npx", args, { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    console.log(result.stdout);
  } finally { await fixture.close(); }
}
main().catch((error) => { console.error(error.stdout || "Postman runner failed before producing a report"); process.exitCode = 1; });
