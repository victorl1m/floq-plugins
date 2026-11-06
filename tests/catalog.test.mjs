// The catalog must be accepted entry for entry by the Floq runtime's own parser (vendored in vendor/floq/).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "floq-catalog-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
const entry = join(tmp, "e.ts");
writeFileSync(entry, `export { parseCatalog, packageUrlAllowed } from ${JSON.stringify(join(ROOT, "vendor/floq/catalog.ts"))};`);
await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: join(tmp, "floq.mjs"), logLevel: "silent" });
const { parseCatalog, packageUrlAllowed } = await import(pathToFileURL(join(tmp, "floq.mjs")).href);
const raw = readFileSync(join(ROOT, "index.json"));

test("Floq's catalog parser accepts every entry in index.json", () => {
  const listed = JSON.parse(raw).plugins.map((p) => p.id);
  assert.deepEqual(parseCatalog(raw).map((e) => e.id), listed);
});

test("each entry points at its own plugin repo's release for the same version", () => {
  for (const e of JSON.parse(raw).plugins) {
    assert.equal(e.package, `https://github.com/victorl1m/floq-plugin-${e.id}/releases/download/v${e.version}/${e.id}-${e.version}.floqpkg.json`);
    assert.ok(packageUrlAllowed(e.package), e.package);
    assert.match(e.sha256, /^[0-9a-f]{64}$/);
  }
});

test("only floq-plugins and floq-plugin-<id> repos of the same owner are accepted; look-alikes and other owners are not", () => {
  const u = (path) => `https://github.com${path}/releases/download/v1.0.0/x.floqpkg.json`;
  for (const ok of ["/victorl1m/floq-plugin-movidesk", "/victorl1m/floq-plugin-azure-devops", "/victorl1m/floq-plugins"]) assert.ok(packageUrlAllowed(u(ok)), ok);
  for (const bad of ["/evil/floq-plugin-movidesk", "/victorl1m2/floq-plugin-movidesk", "/victorl1m/floq-plugin-", "/victorl1m/floq-plugin", "/victorl1m/floq-plugin-Movidesk", "/victorl1m/floq-plugin-a/b", "/victorl1m/floq-pluginx", "/victorl1m/xfloq-plugin-a"]) assert.ok(!packageUrlAllowed(u(bad)), bad);
  for (const bad of ["http://github.com/victorl1m/floq-plugin-movidesk/releases/download/v1/x", "https://evil.test/victorl1m/floq-plugin-movidesk/releases/download/v1/x",
    "https://github.com/victorl1m/floq-plugin-movidesk/archive/main.zip", "https://github.com/victorl1m/floq-plugin-movidesk/releases/download/../../x"]) assert.ok(!packageUrlAllowed(bad), bad);
});
