// Builds every package and validates it with the Floq runtime's own parser (vendored in vendor/floq/). No network, no real credentials.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { buildAll } from "../scripts/build.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let tmp, built, floq;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "floq-plugins-test-"));
  ({ built } = await buildAll(join(tmp, "dist")));
  // The vendored parsers are TypeScript with .js import specifiers: bundle them once into a temp ESM file.
  const entry = join(tmp, "floq-entry.ts");
  writeFileSync(entry, `export { parsePackage, compareVersions, sha256Hex } from ${JSON.stringify(join(ROOT, "vendor/floq/package.ts"))};\nexport { parseCatalog, packageUrlAllowed } from ${JSON.stringify(join(ROOT, "vendor/floq/catalog.ts"))};\n`);
  const out = join(tmp, "floq.mjs");
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  floq = await import(pathToFileURL(out).href);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const entryOf = (id) => JSON.parse(readFileSync(join(tmp, "dist", "index.json"), "utf8")).plugins.find((p) => p.id === id);
const bytesOf = (id) => built.find((b) => b.entry.id === id).bytes;
const parse = (id, over = {}) => floq.parsePackage(over.bytes ?? bytesOf(id), { id, version: entryOf(id).version, sha256: entryOf(id).sha256, ...over.expected }, { builtinIds: over.builtinIds ?? [] });

test("three packages are built and each passes the Floq package parser", () => {
  assert.deepEqual(built.map((b) => b.entry.id), ["azure-devops", "movidesk", "waha"]);
  for (const b of built) {
    const pkg = parse(b.entry.id);
    assert.equal(pkg.manifest.id, b.entry.id);
    assert.equal(pkg.sha256, b.sha256);
    assert.ok(pkg.size < 5 * 1024 * 1024);
  }
});

test("only plugins that contribute views carry a UI bundle; waha ships its skill", () => {
  assert.equal(parse("movidesk").ui, null);
  assert.equal(parse("azure-devops").ui, null);
  const waha = parse("waha");
  assert.ok(waha.ui && waha.ui.length > 100);
  assert.ok("SKILL.md" in waha.skills.waha);
});

test("the catalog is accepted whole by the Floq catalog parser and matches the packages", () => {
  const entries = floq.parseCatalog(readFileSync(join(tmp, "dist", "index.json")));
  assert.deepEqual(entries.map((e) => e.id), ["azure-devops", "movidesk", "waha"]);
  for (const e of entries) {
    assert.ok(floq.packageUrlAllowed(e.package), e.package);
    assert.match(e.package, new RegExp(`/releases/download/${e.id}-v${e.version.replace(/\./g, "\\.")}/${e.id}-${e.version.replace(/\./g, "\\.")}\\.floqpkg\\.json$`));
    assert.equal(e.sha256, built.find((b) => b.entry.id === e.id).sha256);
  }
  const movidesk = entries.find((e) => e.id === "movidesk");
  assert.deepEqual(movidesk.secrets, ["MOVIDESK_TOKEN"]);
  assert.deepEqual(movidesk.network, ["api.movidesk.com"]);
});

test("the committed index.json is what the build produces (release bytes match the catalog)", () => {
  assert.equal(readFileSync(join(ROOT, "index.json"), "utf8"), readFileSync(join(tmp, "dist", "index.json"), "utf8"));
});

test("the build is reproducible", async () => {
  const second = await buildAll(join(tmp, "dist2"));
  assert.deepEqual(second.built.map((b) => b.sha256), built.map((b) => b.sha256));
});

test("tampering is refused: changed bytes, wrong id or version, built-in id clash", () => {
  const tampered = Buffer.concat([bytesOf("movidesk"), Buffer.from(" ")]);
  assert.throws(() => parse("movidesk", { bytes: tampered }), /sha256/);
  assert.throws(() => parse("movidesk", { expected: { id: "azure-devops" } }), /id does not match/);
  assert.throws(() => parse("movidesk", { expected: { version: "9.9.9" } }), /version does not match/);
  assert.throws(() => parse("movidesk", { builtinIds: ["movidesk"] }), /built-in/);
});

test("runtime bundles are standalone: they import with no repository files around them and expose start()", async () => {
  for (const b of built) {
    const pkg = parse(b.entry.id);
    const file = join(tmp, `${b.entry.id}.runtime.mjs`);
    writeFileSync(file, pkg.runtime);
    const mod = await import(pathToFileURL(file).href);
    assert.equal(typeof mod.default.start, "function", b.entry.id);
    assert.doesNotMatch(pkg.runtime, /\bfrom\s+["'](?!node:)/, `${b.entry.id} has a non-node import`);
  }
});

/** A fake PluginContext: records registrations, serves settings/secrets from memory, fetches through a mock (never the network). */
function fakeCtx({ secrets = {}, settings = {}, fetchImpl }) {
  const registered = { taskSources: [] };
  const calls = [];
  const ctx = {
    httpError: (status, code, message) => Object.assign(new Error(message), { status, code }),
    secrets: { get: async (_u, name) => secrets[name] },
    settings: { get: async () => settings },
    taskSources: { register: (s) => registered.taskSources.push(s) },
    fetch: async (url, init) => { calls.push(url); return fetchImpl(url, init); },
    log: { info() {}, warn() {}, error() {} },
  };
  return { ctx, registered, calls };
}
const response = (status, body) => ({ status, ok: status < 400, headers: { "content-type": "application/json" }, bytes: Buffer.from(JSON.stringify(body)), text: () => JSON.stringify(body), json: () => body });

async function loadRuntime(id) {
  const file = join(tmp, `${id}.runtime.mjs`);
  writeFileSync(file, parse(id).runtime);
  return (await import(pathToFileURL(file).href + "?" + Math.random())).default;
}

test("movidesk (built package, mocked fetch): lists tickets with the vault token and maps them", async () => {
  const def = await loadRuntime("movidesk");
  const f = fakeCtx({ secrets: { MOVIDESK_TOKEN: "tok_123" }, fetchImpl: async () => response(200, [{ id: "42", subject: "Printer", baseStatus: "InAttendance", status: "Em atendimento", lastUpdate: "2026-01-02T10:00:00Z", createdDate: "2026-01-01T10:00:00Z" }]) });
  def.start(f.ctx);
  const [{ id, provider }] = f.registered.taskSources;
  assert.equal(id, "tickets");
  const page = await provider.list("u1", {});
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].externalId, "42");
  assert.equal(page.items[0].statusCategory, "doing");
  assert.equal(new URL(f.calls[0]).hostname, "api.movidesk.com");
  assert.equal(new URL(f.calls[0]).searchParams.get("token"), "tok_123");
});

test("movidesk (built package): a missing token is a 409 not_configured and nothing is fetched", async () => {
  const def = await loadRuntime("movidesk");
  const f = fakeCtx({ fetchImpl: async () => { throw new Error("must not be called"); } });
  def.start(f.ctx);
  await assert.rejects(() => f.registered.taskSources[0].provider.list("u1", {}), (e) => e.status === 409 && e.code === "not_configured");
  assert.equal(f.calls.length, 0);
});

test("azure-devops (built package): the PAT is only sent as Basic auth, a missing PAT is 409", async () => {
  const def = await loadRuntime("azure-devops");
  const missing = fakeCtx({ settings: { organizationUrl: "https://dev.azure.com/acme", project: "Core" }, fetchImpl: async () => { throw new Error("must not be called"); } });
  def.start(missing.ctx);
  await assert.rejects(() => missing.registered.taskSources[0].provider.list("u1", {}), (e) => e.status === 409 && e.code === "not_configured");
  const headers = [];
  const f = fakeCtx({
    secrets: { AZURE_DEVOPS_PAT: "pat_secret" }, settings: { organizationUrl: "https://dev.azure.com/acme", project: "Core" },
    fetchImpl: async (url, init) => { headers.push(init?.headers ?? {}); return response(200, String(url).includes("wiql") ? { workItems: [] } : { value: [] }); },
  });
  def.start(f.ctx);
  const page = await f.registered.taskSources[0].provider.list("u1", {});
  assert.deepEqual(page.items, []);
  assert.ok(headers.length > 0);
  for (const h of headers) assert.equal(h.Authorization, "Basic " + Buffer.from(":pat_secret").toString("base64"));
  assert.ok(f.calls.every((u) => !u.includes("pat_secret")));
});

test("waha UI bundle takes React, the kit and the SDK from the host global and brings no imports of its own", async () => {
  const ui = parse("waha").ui;
  assert.doesNotMatch(ui, /^\s*import\s/m);
  assert.doesNotMatch(ui, /tabler/i);
  const used = new Set();
  const proxy = (path) => new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : (used.add(`${path}.${String(k)}`), proxy(`${path}.${String(k)}`))), apply: () => proxy(path + "()") });
  const rt = { react: proxy("react"), jsx: proxy("jsx"), kit: { ...Object.fromEntries(["Badge", "Button", "PluginPage", "PluginState", "Textarea", "cn", "toast", "usePluginApi", "usePluginEvent"].map((n) => [n, () => null])), resolvePluginIcon: () => () => null }, sdk: { defineUiPlugin: (d) => d } };
  globalThis.__FLOQ_PLUGIN_RT__ = rt;
  try {
    const mod = await import("data:text/javascript;base64," + Buffer.from(ui).toString("base64"));
    assert.equal(typeof mod.default.views.inbox, "function");
  } finally { delete globalThis.__FLOQ_PLUGIN_RT__; }
});
