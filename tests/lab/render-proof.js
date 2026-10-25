const { existsSync } = require("node:fs");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const os = require("node:os");
const execute = promisify(execFile);

async function renderProof(directory) {
  const chrome = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find((candidate) => candidate && existsSync(candidate));
  if (!chrome) return { screenshot: null, reason: "Set CHROME_BIN to a Chromium browser binary to capture before-after.png" };
  const profile = await mkdtemp(path.join(os.tmpdir(), "booking-proof-"));
  try {
    const output = path.join(directory, "before-after.png");
    const args = ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", `--user-data-dir=${profile}`, `--screenshot=${output}`, "--window-size=1040,430", pathToFileURL(path.join(directory, "before-after.svg")).href];
    const result = await execute(chrome, args, { timeout: 30000, maxBuffer: 1024 * 1024 });
    await writeFile(path.join(directory, "screenshot-render.log"), result.stdout + result.stderr);
    return { screenshot: output, renderer: chrome, viewport: { width: 1040, height: 430 } };
  } finally { await rm(profile, { recursive: true, force: true }); }
}

module.exports = { renderProof };
if (require.main === module) renderProof(path.resolve(process.argv[2] || ".")).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
