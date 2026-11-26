/** Stamp dist/sw.js with the hashed assets from dist/index.html.
 *
 * Without this the worker installs with an empty asset cache: the first visit happens before
 * the worker controls the page, so nothing gets cached, and an offline reload renders a blank
 * document (index.html from cache, its script and stylesheet missing).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dist = process.argv[2] || "dist";
const htmlPath = join(dist, "index.html");
const swPath = join(dist, "sw.js");
if (!existsSync(htmlPath) || !existsSync(swPath)) {
  console.error("stamp-sw: need both " + htmlPath + " and " + swPath);
  process.exit(1);
}

const html = readFileSync(htmlPath, "utf8");
const assets = [...html.matchAll(/(?:src|href)="(\.?\/?assets\/[^"]+)"/g)].map((m) => m[1].replace(/^\.\//, "./"));
const unique = [...new Set(assets)].sort();
if (unique.length === 0) {
  console.error("stamp-sw: no /assets/ references found in index.html");
  process.exit(1);
}

const version = createHash("sha256").update(unique.join("|")).digest("hex").slice(0, 8);
let sw = readFileSync(swPath, "utf8");
sw = sw.replace("/*__ASSETS__*/ []", JSON.stringify(unique));
sw = sw.replace("/*__VERSION__*/v1", version);
if (sw.includes("__ASSETS__") || sw.includes("__VERSION__")) {
  console.error("stamp-sw: placeholders survived; is public/sw.js in the expected shape?");
  process.exit(1);
}
writeFileSync(swPath, sw);
console.log("stamp-sw: cached " + unique.length + " asset(s), version " + version);
