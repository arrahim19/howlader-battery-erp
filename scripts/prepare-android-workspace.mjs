import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(process.argv[2] ?? "C:/hb-build/erp");
if (source === target || target.startsWith(source + path.sep))
  throw new Error("Use a separate local Android build directory.");
const marker = path.join(target, ".hawlader-build-workspace.json");
if (
  fs.existsSync(target) &&
  !fs.existsSync(marker) &&
  fs.readdirSync(target).length
)
  throw new Error(
    "The build directory is not an existing Hawlader build workspace.",
  );
fs.mkdirSync(target, { recursive: true });
const previous = fs.existsSync(marker)
  ? JSON.parse(fs.readFileSync(marker, "utf8"))
  : { source, files: [] };
if (previous.source !== source)
  throw new Error("This build directory belongs to another source checkout.");
const listed = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: source, windowsHide: true },
)
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const files = [...new Set(listed)].filter((name) => {
  if (
    /(^|\/)(node_modules|\.local|\.tmp|\.expo|\.next|dist|credentials)(\/|$)/.test(
      name,
    )
  )
    return false;
  if (/^apps\/mobile\/(android|ios)\//.test(name)) return false;
  if (
    /(^|\/)\.env($|\.)/.test(name) ||
    /\.(jks|keystore|pem|key|p12)$/.test(name) ||
    /(^|\/)credentials\.json$/.test(name)
  )
    return false;
  if (/^(output|tmp|test-results|playwright-report)\//.test(name)) return false;
  return (
    fs.existsSync(path.join(source, name)) &&
    fs.statSync(path.join(source, name)).isFile()
  );
});
for (const name of files) {
  const destination = path.resolve(target, name);
  if (!destination.startsWith(target + path.sep))
    throw new Error("Invalid source file path.");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const original = fs.statSync(path.join(source, name));
  const existing = fs.existsSync(destination) ? fs.statSync(destination) : null;
  if (
    !existing ||
    original.size !== existing.size ||
    Math.abs(original.mtimeMs - existing.mtimeMs) > 2
  ) {
    fs.copyFileSync(path.join(source, name), destination);
    fs.utimesSync(destination, original.atime, original.mtime);
  }
}
// Only remove stale source files listed by this tool's previous snapshot; native outputs and caches stay.
for (const name of previous.files) {
  if (files.includes(name)) continue;
  const stale = path.resolve(target, name);
  if (!stale.startsWith(target + path.sep))
    throw new Error("Invalid previous snapshot path.");
  if (fs.existsSync(stale) && fs.statSync(stale).isFile()) fs.unlinkSync(stale);
}
fs.writeFileSync(marker, JSON.stringify({ source, files }, null, 2));
console.log(`Prepared ${files.length} source files in ${target}`);
