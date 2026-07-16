// Copies the single-source-of-truth engine + content into functions/ so the
// deployed bundle is self-contained. src/engine and content/ stay canonical at the
// repo root; the copies here are generated — never edit functions/engine or
// functions/content by hand. Runs automatically before every deploy (firebase.json
// predeploy) and before the local emulator (npm run serve).
import { cpSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

for (const [from, to] of [
  [join(repo, "src", "engine"), join(here, "engine")],
  [join(repo, "content"), join(here, "content")],
]) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`synced ${from} -> ${to}`);
}
