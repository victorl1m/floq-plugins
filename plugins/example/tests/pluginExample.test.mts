import test from "node:test";
import assert from "node:assert/strict";
import { PluginHost } from "../dist/plugins/host.js";
import example from "../dist/plugins/example/index.js";
import { BUILTIN_PLUGINS } from "../dist/plugins/index.js";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";

test.after(closeAll);

test("the example is only registered with FLOQ_DEV_PLUGINS=1", () => {
  assert.equal(BUILTIN_PLUGINS.includes(example), process.env.FLOQ_DEV_PLUGINS === "1");
});

test("the example shows a view, a setting, a route and an event", async () => {
  const f = await fakePool(); await f.addUser("u1");
  const host = new PluginHost(f.pool as never, { plugins: [example], vault: { async reveal() { return {}; } } as never, sink: () => undefined });
  await host.load(); await host.enable("example", "u1");
  const call = (method: string, path: string, body?: unknown) => host.handle({ userId: "u1", method, pathname: "/v1/plugins/example/" + path, query: new URLSearchParams(), readBody: async () => body, requireAdmin: async () => undefined }) as Promise<any>;
  const list = (await call("GET", "").catch(() => null)) ?? (await host.handle({ userId: "u1", method: "GET", pathname: "/v1/plugins", query: new URLSearchParams(), readBody: async () => undefined, requireAdmin: async () => undefined }) as any);
  const info = list.body.plugins.find((p: any) => p.id === "example");
  assert.deepEqual(info.contributes.views.map((v: any) => v.id), ["main"]);
  assert.deepEqual(info.settings.map((s: any) => s.key), ["greeting"]);
  await call("PUT", "user", { enabled: true });
  assert.equal((await call("GET", "api/hello")).body.message, "Hello from the example plugin");
  await call("PUT", "settings", { settings: { greeting: "Olá" } });
  assert.equal((await call("GET", "api/hello")).body.message, "Olá");
  const frames: any[] = [];
  host.events.subscribe("u1", (fr) => frames.push(fr));
  host.events.subscribe("other", (fr) => frames.push(["leak", fr]));
  assert.deepEqual((await call("POST", "api/ping", { a: 1 })).body, { ok: true });
  assert.equal(frames.length, 1);
  assert.deepEqual([frames[0].type, frames[0].pluginId, frames[0].name, frames[0].data.body], ["plugin", "example", "pinged", { a: 1 }]);
});
