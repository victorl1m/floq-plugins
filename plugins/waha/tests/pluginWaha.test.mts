import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PluginHost } from "../dist/plugins/host.js";
import waha from "../dist/plugins/waha/index.js";
import { BUILTIN_PLUGINS } from "../dist/plugins/index.js";
import { parseManifest } from "../dist/plugins/manifest.js";
import { normalizeBase, parseWebhook, sendText, sessionName, verifyHmac } from "../dist/plugins/waha/client.js";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";

test.after(closeAll);
const KEY = "waha/api+KEY=999";
const HMAC = "hmac-secret-key-123";
const BASE = "http://waha.local:3000";

const sign = (raw: string, key = HMAC) => createHmac("sha512", key).update(raw).digest("hex");
const evt = (over: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => ({ id: "evt1", event: "message", session: "default", engine: "WEBJS", payload: { id: "true_1@c.us_A", timestamp: 1_767_000_000, from: "5511111111111@c.us", fromMe: false, to: "5522222222222@c.us", body: "Olá!", hasMedia: false, ...payload }, ...over });

interface Req { url: URL; method: string; headers: Record<string, string>; body: any }
async function setup(opts: { hmac?: boolean; handler?: (r: Req) => Response | Promise<Response> } = {}) {
  const f = await fakePool(); await f.addUser("admin"); await f.addUser("member");
  await f.db.exec(`INSERT INTO vault_secrets (user_id, name, value_enc) VALUES ('admin','WAHA_API_KEY','e')${opts.hmac === false ? "" : ", ('admin','WAHA_WEBHOOK_HMAC','e')"}`);
  const reqs: Req[] = []; const logs: unknown[] = [];
  const fetchImpl = async (u: URL, init: any) => { const r = { url: new URL(String(u)), method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined }; reqs.push(r); return (opts.handler ?? (() => new Response(JSON.stringify({ id: { _serialized: "true_5511@c.us_OUT1" } }), { status: 201 })))(r); };
  const secrets: Record<string, string> = { WAHA_API_KEY: KEY, ...(opts.hmac === false ? {} : { WAHA_WEBHOOK_HMAC: HMAC }) };
  const vault = { async reveal(_u: string, names: string[]) { return Object.fromEntries(names.filter((n) => n in secrets).map((n) => [n, secrets[n]])); } };
  const host = new PluginHost(f.pool as never, { plugins: [waha], vault: vault as never, fetchImpl: fetchImpl as never, sink: (...a: unknown[]) => logs.push(a) });
  await host.load();
  const call = (userId: string, method: string, path: string, body?: unknown) => host.handle({ userId, method, pathname: new URL("http://x" + path).pathname, query: new URL("http://x" + path).searchParams, readBody: async () => body, requireAdmin: async () => undefined }) as Promise<any>;
  await host.enable("waha", "admin");
  await call("admin", "PUT", "/v1/plugins/waha/settings", { settings: { baseUrl: BASE } });
  const { token } = await host.rotateWebhookToken("waha");
  const hook = (raw: string, headers: Record<string, string> = {}) => host.handleWebhook({ pluginId: "waha", name: "events", token, ip: "1.2.3.4", query: new URLSearchParams(), headers, readRaw: async () => Buffer.from(raw) });
  const signed = (obj: unknown) => { const raw = JSON.stringify(obj); return hook(raw, { "x-webhook-hmac": sign(raw), "x-webhook-hmac-algorithm": "sha512" }); };
  const frames: any[] = []; host.events.subscribe("admin", (fr) => frames.push(fr));
  const other: any[] = []; host.events.subscribe("member", (fr) => other.push(fr));
  return { ...f, host, call, hook, signed, reqs, logs, frames, other };
}

test("manifest, registration, schema and skill", async () => {
  const m = parseManifest(waha.manifest);
  assert.equal(m.scope, "install");
  assert.deepEqual(m.secrets.map((s) => [s.name, s.required]), [["WAHA_API_KEY", true], ["WAHA_WEBHOOK_HMAC", false]]);
  assert.deepEqual([m.settings[0].key, m.settings[0].type], ["baseUrl", "url"]);
  assert.deepEqual(m.contributes.webhooks, ["events"]);
  assert.ok(m.contributes.internalRoutes && m.contributes.migrations);
  assert.ok(BUILTIN_PLUGINS.includes(waha));
  const { db } = await setup();
  const cols = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='plugin_waha' AND table_name='messages'")).rows.map((r: any) => r.column_name);
  assert.ok(cols.includes("user_id") && cols.includes("chat_id") && cols.includes("body"));
  // the skill ships with the plugin and documents the CLI
  const dir = waha.dir!;
  assert.ok(existsSync(join(dir, "skills", "waha", "SKILL.md")));
  const md = readFileSync(join(dir, "skills", "waha", "SKILL.md"), "utf8");
  assert.match(md, /^---\nname: waha\n/);
  for (const cmd of ["floq plugin call waha chats", "floq plugin call waha messages", "floq plugin call waha send", "floq plugin list"]) assert.ok(md.includes(cmd), cmd);
  assert.match(md, /approval|approves|approved/i);
});

test("the plugin publishes its skill folder through the host", async () => {
  const f = await fakePool(); await f.addUser("admin");
  const published: any[] = [];
  const host = new PluginHost(f.pool as never, { plugins: [waha], vault: { async reveal() { return {}; } } as never, sink: () => undefined });
  host.setSkills({ setPluginSkills: (...a: unknown[]) => published.push(a) } as never);
  await host.load(); await host.enable("waha", "admin");
  assert.deepEqual(published[0], ["waha", join(waha.dir!, "skills"), ["waha"]]);
});

test("pure helpers: base URL, session, webhook parsing and HMAC", () => {
  assert.equal(normalizeBase("http://waha.local:3000/"), "http://waha.local:3000");
  assert.equal(normalizeBase("https://h.test/waha///"), "https://h.test/waha");
  for (const bad of ["ftp://h", "https://u:p@h.test", "not a url", 5]) assert.equal(normalizeBase(bad), null);
  assert.equal(sessionName(" my-session "), "my-session"); assert.equal(sessionName("bad name!"), "default"); assert.equal(sessionName(undefined), "default");
  const m = parseWebhook(evt())!;
  assert.deepEqual([m.chatId, m.msgId, m.fromMe, m.sender, m.body, m.sentAt.toISOString()], ["5511111111111@c.us", "true_1@c.us_A", false, "5511111111111@c.us", "Olá!", "2025-12-29T09:20:00.000Z"]);
  const mine = parseWebhook(evt({ event: "message.any" }, { fromMe: true }))!;
  assert.deepEqual([mine.chatId, mine.sender], ["5522222222222@c.us", "me"]);
  assert.equal(parseWebhook(evt({ event: "session.status" })), null);
  assert.equal(parseWebhook(evt({}, { id: "" })), null);
  assert.equal(parseWebhook(evt({}, { from: "bad id with spaces" })), null);
  assert.equal(parseWebhook(null), null);
  const raw = Buffer.from('{"a":1}');
  const good = sign(raw.toString());
  assert.ok(verifyHmac(raw, { "x-webhook-hmac": good, "x-webhook-hmac-algorithm": "sha512" }, HMAC));
  assert.ok(verifyHmac(raw, { "x-webhook-hmac": good.toUpperCase() }, HMAC)); // algorithm header defaults to sha512; hex case is ignored
  assert.ok(!verifyHmac(raw, { "x-webhook-hmac": good }, "other-key"));
  assert.ok(!verifyHmac(raw, { "x-webhook-hmac": good, "x-webhook-hmac-algorithm": "sha256" }, HMAC));
  assert.ok(!verifyHmac(Buffer.from('{"a":2}'), { "x-webhook-hmac": good }, HMAC));
  assert.ok(!verifyHmac(raw, {}, HMAC)); assert.ok(!verifyHmac(raw, { "x-webhook-hmac": "abc" }, HMAC));
});

test("inbound webhook: stored, announced to the owner only (event + toast), duplicates and own messages are quiet", async () => {
  const t = await setup();
  await t.signed(evt());
  assert.deepEqual(t.frames.map((f) => f.name), ["message", "toast"]);
  assert.equal(t.frames[0].data.chatId, "5511111111111@c.us");
  assert.equal(t.frames[1].data.title, "WhatsApp: 5511111111111@c.us");
  assert.deepEqual(t.other, []);
  assert.equal((await t.db.query("SELECT user_id FROM plugin_waha.messages")).rows[0].user_id, "admin");
  await t.signed(evt()); // same message id: stored once, not announced again
  assert.equal(t.frames.length, 2);
  assert.equal((await t.db.query("SELECT 1 FROM plugin_waha.messages")).rows.length, 1);
  await t.signed(evt({ event: "message.any" }, { id: "own1", fromMe: true, to: "5533333333333@c.us" })); // sent from the phone: stored, no toast
  assert.equal(t.frames.length, 2);
  assert.equal((await t.db.query("SELECT 1 FROM plugin_waha.messages")).rows.length, 2);
  assert.deepEqual(await t.signed(evt({ event: "session.status" })), { ok: true });
  assert.deepEqual(await t.signed(evt({ session: "other" }, { id: "x1" })), { ok: true, ignored: true });
  assert.equal((await t.db.query("SELECT 1 FROM plugin_waha.messages")).rows.length, 2);
});

test("HMAC: with WAHA_WEBHOOK_HMAC set, unsigned or badly signed events are refused; without it the token alone is the credential", async () => {
  const t = await setup();
  const raw = JSON.stringify(evt());
  for (const headers of [{}, { "x-webhook-hmac": "deadbeef" }, { "x-webhook-hmac": sign(raw, "wrong") }, { "x-webhook-hmac": sign(raw), "x-webhook-hmac-algorithm": "sha1" }]) {
    await assert.rejects(t.hook(raw, headers), (e: any) => e.status === 401 && e.code === "invalid_signature", JSON.stringify(headers));
  }
  assert.equal(t.frames.length, 0);
  await t.hook(raw, { "x-webhook-hmac": sign(raw), "x-webhook-hmac-algorithm": "sha512" });
  assert.equal(t.frames.length, 2);
  const open = await setup({ hmac: false });
  await open.hook(raw);
  assert.equal(open.frames.length, 2);
});

test("the inbox belongs to the enabling admin: chats and messages for them, 403 for everyone else", async () => {
  const t = await setup();
  await t.signed(evt({}, { id: "m1", body: "first", timestamp: 1_767_000_000 }));
  await t.signed(evt({}, { id: "m2", body: "second", timestamp: 1_767_000_100 }));
  await t.signed(evt({}, { id: "m3", from: "5544444444444@c.us", body: "other chat", timestamp: 1_767_000_200 }));
  const chats = (await t.call("admin", "GET", "/v1/plugins/waha/api/chats")).body.chats;
  assert.deepEqual(chats.map((c: any) => [c.chatId, c.lastBody, c.total]), [["5544444444444@c.us", "other chat", 1], ["5511111111111@c.us", "second", 2]]);
  const msgs = (await t.call("admin", "GET", "/v1/plugins/waha/api/messages?chatId=5511111111111@c.us")).body.messages;
  assert.deepEqual(msgs.map((m: any) => m.body), ["first", "second"]);
  assert.deepEqual((await t.call("admin", "GET", "/v1/plugins/waha/api/messages?chatId=5511111111111@c.us&limit=1")).body.messages.map((m: any) => m.body), ["second"]);
  await assert.rejects(t.call("admin", "GET", "/v1/plugins/waha/api/messages?chatId=bad%20id"), (e: any) => e.status === 400);
  const status = (await t.call("admin", "GET", "/v1/plugins/waha/api/status")).body;
  assert.deepEqual([status.configured, status.missingSettings, status.missingSecrets, status.session], [true, [], [], "default"]);
  // owner-only plugin (access: "owner"): for everyone else it is simply not there
  for (const path of ["status", "chats", "messages?chatId=5511111111111@c.us"]) await assert.rejects(t.call("member", "GET", "/v1/plugins/waha/api/" + path), (e: any) => e.status === 404 && e.code === "plugin_disabled");
});

test("sending from the UI (the user's click) goes to the configured WAHA only, with the API key header, and is recorded", async () => {
  const t = await setup();
  const r = await t.call("admin", "POST", "/v1/plugins/waha/api/send", { chatId: "5511111111111@c.us", text: "Oi!" });
  assert.deepEqual([r.body.status, r.body.id], ["sent", "true_5511@c.us_OUT1"]);
  const req = t.reqs[0];
  assert.deepEqual([req.method, req.url.origin, req.url.pathname, req.headers["X-Api-Key"], req.body], ["POST", BASE, "/api/sendText", KEY, { session: "default", chatId: "5511111111111@c.us", text: "Oi!" }]);
  const stored = (await t.db.query("SELECT from_me, body, user_id FROM plugin_waha.messages")).rows;
  assert.deepEqual(stored, [{ from_me: true, body: "Oi!", user_id: "admin" }]);
  assert.equal(t.frames.at(-1).name, "message");
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/waha/api/send", { chatId: "5511111111111@c.us", text: "" }), (e: any) => e.status === 400);
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/waha/api/send", { chatId: "5511111111111@c.us", text: "x".repeat(4097) }), (e: any) => e.status === 400);
  await assert.rejects(t.call("member", "POST", "/v1/plugins/waha/api/send", { chatId: "5511111111111@c.us", text: "hi" }), (e: any) => e.status === 404);
  assert.equal(t.reqs.length, 1);
});

test("agent send needs the user's approval: approved sends, denied and expired do not", async () => {
  for (const [decision, sent] of [["approved", true], ["denied", false], ["expired", false]] as const) {
    const t = await setup();
    const asked: any[] = [];
    t.host.setApprovals({ askAsPlugin: async (u: string, plugin: any, input: any) => { asked.push([u, plugin, input]); return decision; } } as never);
    const out = await t.host.handleInternal({ userId: "admin", sessionId: "s1", pluginId: "waha", path: "send", body: { chatId: "5511111111111@c.us", text: "Report ready" } }) as any;
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].slice(0, 2), ["admin", { id: "waha", name: "WhatsApp (WAHA)" }]);
    assert.equal(asked[0][2].action, "Send WhatsApp message to 5511111111111@c.us");
    assert.equal(asked[0][2].detail, "Report ready");
    assert.equal(out.status, sent ? "sent" : decision);
    assert.equal(t.reqs.length, sent ? 1 : 0, decision);
  }
  const t = await setup();
  t.host.setApprovals({ askAsPlugin: async () => { throw new Error("must not ask a non-owner"); } } as never);
  await assert.rejects(t.host.handleInternal({ userId: "member", sessionId: "s", pluginId: "waha", path: "send", body: { chatId: "5511111111111@c.us", text: "x" } }), (e: any) => e.status === 404);
});

test("agents read chats and messages through the internal routes", async () => {
  const t = await setup();
  await t.signed(evt({}, { id: "m1", body: "hello agent" }));
  const chats = await t.host.handleInternal({ userId: "admin", sessionId: "s", pluginId: "waha", path: "chats", body: {} }) as any;
  assert.equal(chats.chats[0].chatId, "5511111111111@c.us");
  const msgs = await t.host.handleInternal({ userId: "admin", sessionId: "s", pluginId: "waha", path: "messages", body: { chatId: "5511111111111@c.us", limit: 5 } }) as any;
  assert.equal(msgs.messages[0].body, "hello agent");
  await assert.rejects(t.host.handleInternal({ userId: "admin", sessionId: "s", pluginId: "waha", path: "messages", body: {} }), (e: any) => e.status === 400);
});

test("the API key and HMAC key never appear in errors, responses or logs", async () => {
  const t = await setup({ handler: () => new Response(`denied ${KEY} ${encodeURIComponent(KEY)}`, { status: 500 }) });
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/waha/api/send", { chatId: "5511111111111@c.us", text: "hi" }), (e: any) => e.status === 502 && e.code === "waha_unavailable" && !e.message.includes("KEY"));
  const net = await setup({ handler: () => { throw new Error(`ECONNREFUSED with ${KEY}`); } });
  await assert.rejects(net.call("admin", "POST", "/v1/plugins/waha/api/send", { chatId: "5511111111111@c.us", text: "hi" }), (e: any) => e.status === 502);
  const bad = await setup();
  await assert.rejects(bad.hook(JSON.stringify(evt()), { "x-webhook-hmac": "nope" }));
  for (const all of [t.logs, net.logs, bad.logs]) for (const secret of [KEY, encodeURIComponent(KEY), HMAC]) assert.ok(!JSON.stringify(all).includes(secret), secret);
  assert.equal((await t.db.query("SELECT 1 FROM plugin_waha.messages")).rows.length, 0); // a failed send is not recorded
});

test("not configured: no base URL or key means no request and a clear state", async () => {
  const f = await fakePool(); await f.addUser("admin");
  const reqs: unknown[] = [];
  const host = new PluginHost(f.pool as never, { plugins: [waha], vault: { async reveal() { return {}; } } as never, fetchImpl: (async (u: URL) => { reqs.push(u); return new Response("{}"); }) as never, sink: () => undefined });
  await host.load(); await host.enable("waha", "admin");
  const call = (method: string, path: string, body?: unknown) => host.handle({ userId: "admin", method, pathname: path, query: new URLSearchParams(), readBody: async () => body, requireAdmin: async () => undefined }) as Promise<any>;
  const status = (await call("GET", "/v1/plugins/waha/api/status")).body;
  assert.deepEqual([status.configured, status.missingSettings, status.missingSecrets], [false, ["baseUrl"], ["WAHA_API_KEY"]]);
  await assert.rejects(call("POST", "/v1/plugins/waha/api/send", { chatId: "5511111111111@c.us", text: "hi" }), (e: any) => e.status === 409 && e.code === "not_configured");
  assert.deepEqual(reqs, []);
});

test("sendText returns WAHA's id in either shape and fails with the status only", async () => {
  const mk = (status: number, text: string) => (async () => ({ ok: status < 300, status, headers: {}, bytes: new Uint8Array(), text: () => text, json: () => JSON.parse(text) })) as never;
  const go = (f: never) => sendText(f, "u", BASE, "k", "default", "5511@c.us", "x");
  assert.equal(await go(mk(201, JSON.stringify({ id: "plain" }))), "plain");
  assert.equal(await go(mk(201, JSON.stringify({ id: { id: "inner" } }))), "inner");
  assert.equal(await go(mk(201, JSON.stringify({ id: { _serialized: "ser" } }))), "ser");
  assert.equal(await go(mk(201, "not json")), null);
  await assert.rejects(go(mk(401, "body with k")), (e: any) => e.message === "WAHA request failed (HTTP 401)");
});

test("F-2: an agent send waits less than the CLI timeout and is withdrawn when the agent goes away", async () => {
  const { SEND_APPROVAL_WAIT_MS } = await import("../dist/plugins/waha/index.js");
  assert.ok(SEND_APPROVAL_WAIT_MS < 290_000);
  const t = await setup();
  let seen: any;
  t.host.setApprovals({ askAsPlugin: (_u: string, _p: unknown, _i: unknown, signal: AbortSignal, timeoutMs: number) => new Promise((resolve) => { seen = { timeoutMs }; signal.addEventListener("abort", () => resolve("expired")); setTimeout(() => resolve("approved"), 150); }) } as never);
  const gone = new AbortController();
  const pending = t.host.handleInternal({ userId: "admin", sessionId: "s", pluginId: "waha", path: "send", body: { chatId: "5511111111111@c.us", text: "hi" }, signal: gone.signal });
  setTimeout(() => gone.abort(), 30);
  assert.deepEqual(await pending, { status: "expired" });
  assert.equal(seen.timeoutMs, SEND_APPROVAL_WAIT_MS);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(t.reqs.length, 0, "nothing was sent, even though the approval would have resolved later");
  // even an approval that races the abort never sends once the agent is gone
  const raced = new AbortController(); raced.abort();
  t.host.setApprovals({ askAsPlugin: async () => "approved" } as never);
  assert.deepEqual(await t.host.handleInternal({ userId: "admin", sessionId: "s", pluginId: "waha", path: "send", body: { chatId: "5511111111111@c.us", text: "hi" }, signal: raced.signal }), { status: "expired" });
  assert.equal(t.reqs.length, 0);
  assert.match(readFileSync(join(waha.dir!, "skills", "waha", "SKILL.md"), "utf8"), /withdrawn too/);
});

test("access owner: the plugin is off (no nav, no routes, no agent calls) for every user except the admin who set it up", async () => {
  const t = await setup();
  const listFor = async (userId: string) => (await t.call(userId, "GET", "/v1/plugins")).body.plugins.find((p: any) => p.id === "waha");
  const owner = await listFor("admin"), other = await listFor("member");
  assert.deepEqual([owner.enabled, owner.userEnabled], [true, true]);
  assert.deepEqual([other.enabled, other.userEnabled], [true, false]); // enabled on the runtime, but not for this user: the UI contributes nothing
  await assert.rejects(t.call("member", "GET", "/v1/plugins/waha/api/chats"), (e: any) => e.status === 404 && e.code === "plugin_disabled");
  await assert.rejects(t.host.handleInternal({ userId: "member", sessionId: "s", pluginId: "waha", path: "chats", body: {} }), (e: any) => e.status === 404);
  assert.deepEqual((await t.host.listInternal("member")).map((p) => p.id), []);
  assert.deepEqual((await t.host.listInternal("admin")).map((p) => p.id), ["waha"]);
  assert.deepEqual((await t.call("member", "GET", "/v1/task-sources")).body, { sources: [] });
});
