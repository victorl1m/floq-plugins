// Downloads every package listed in index.json and checks the bytes against the catalog: sha256, id and version.
// Run after releasing a plugin (and on a schedule) so the catalog never lists a package that 404s or was replaced.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(join(ROOT, "index.json"), "utf8"));
let failed = 0;
for (const entry of catalog.plugins) {
  const label = `${entry.id}@${entry.version}`;
  try {
    const res = await fetch(entry.package, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${entry.package}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== entry.sha256) throw new Error(`sha256 mismatch: catalog ${entry.sha256}, release ${sha}`);
    const pkg = JSON.parse(bytes.toString("utf8"));
    const manifest = pkg.manifest ?? pkg;
    if (manifest.id !== entry.id || manifest.version !== entry.version) throw new Error(`package is ${manifest.id}@${manifest.version}`);
    console.log(`ok   ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${label}: ${error instanceof Error ? error.message : error}`);
  }
}
process.exit(failed ? 1 : 0);
