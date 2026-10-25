const { readdirSync } = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}
for (const file of [...files(path.join(__dirname)), ...files(path.join(__dirname, "../scripts"))]) {
  // k6 modules use its own runtime; each executable scenario is parsed by k6 inspect/run.
  if (file.includes(`${path.sep}k6${path.sep}`)) continue;
  if (file.endsWith(".js")) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (file.endsWith(".sh")) execFileSync("bash", ["-n", file], { stdio: "inherit" });
}
console.log("JavaScript and shell syntax checks passed.");
