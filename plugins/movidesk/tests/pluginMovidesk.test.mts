import test from "node:test";
import assert from "node:assert/strict";
import { PluginHost } from "../dist/plugins/host.js";
import movidesk from "../dist/plugins/movidesk/index.js";
import { BUILTIN_PLUGINS } from "../dist/plugins/index.js";
import { filterFor, mapTicket, statusCategory, ticketsUrl, PAGE_SIZE } from "../dist/plugins/movidesk/client.js";
import { parseManifest } from "../dist/plugins/manifest.js";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";

test.after(closeAll);
const TOKEN = "md_tok/ABC+123=secret";

const ticket = (id: number, over: Record<string, unknown> = {}) => ({ id: String(id), subject: `Subject ${id}`, status: "Em atendimento", baseStatus: "InAttendance", urgency: "Alta", category: "Suporte", createdDate: "2026-01-01T10:00:00Z", lastUpdate: "2026-01-02T10:00:00Z", owner: { businessName: "Ana" }, clients: [{ businessName: "Acme" }], ...over });

async function setup(handler: (url: URL) => Response | Promise<Response>, opts: { secret?: boolean } = {}) {
  const f = await fakePool(); await f.addUser("u1");
  // presence is read from the vault table (never the value); the value itself comes from the stubbed vault.reveal
  if (opts.secret !== false) await f.db.exec(`INSERT INTO vault_secrets (user_id, name, value_enc) VALUES ('u1', 'MOVIDESK_TOKEN', 'enc')`);
  const urls: URL[] = [];
  const logs: unknown[] = [];
  const fetchImpl = async (u: URL) => { urls.push(new URL(String(u))); return handler(new URL(String(u))); };
  const vault = { async reveal(_u: string, names: string[]) { return opts.secret === false ? {} : Object.fromEntries(names.map((n) => [n, TOKEN])); } };
  const host = new PluginHost(f.pool as never, { plugins: [movidesk], vault: vault as never, fetchImpl: fetchImpl as never, sink: (...a: unknown[]) => logs.push(a) });
  await host.load(); await host.enable("movidesk", "u1");
  const call = (method: string, path: string, body?: unknown) => host.handle({ userId: "u1", method, pathname: new URL("http://x" + path).pathname, query: new URL("http://x" + path).searchParams, readBody: async () => body, requireAdmin: async () => undefined }) as Promise<any>;
  await call("PUT", "/v1/plugins/movidesk/user", { enabled: true });
  return { ...f, host, call, urls, logs };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

test("the manifest matches the brief and is registered as a built-in", () => {
  const m = parseManifest(movidesk.manifest);
  assert.deepEqual(m.secrets.map((s) => [s.name, s.required]), [["MOVIDESK_TOKEN", true]]);
  assert.deepEqual(m.network.allow, ["api.movidesk.com"]);
  assert.ok(m.settings.some((s) => s.key === "defaultQuery"));
  assert.deepEqual(m.contributes.taskSources, [{ id: "tickets", label: "Movidesk", view: "generic" }]);
  assert.ok(BUILTIN_PLUGINS.includes(movidesk));
});

test("ticket status maps to the status category", () => {
  for (const [s, c] of [["New", "todo"], ["InAttendance", "doing"], ["Stopped", "doing"], ["Resolved", "done"], ["Closed", "done"], ["Canceled", "done"], ["weird", "todo"], [undefined, "todo"]] as const) assert.equal(statusCategory(s), c, String(s));
});

test("filters: a number means ticket id, text means subject contains, quotes are escaped", () => {
  assert.equal(filterFor(""), undefined);
  assert.equal(filterFor("  "), undefined);
  assert.equal(filterFor("1042"), "id eq 1042");
  assert.equal(filterFor("login's bug"), "contains(subject,'login''s bug')");
  const url = new URL(ticketsUrl("T", { filter: "id eq 1", skip: 50 }));
  assert.deepEqual([url.hostname, url.pathname, url.searchParams.get("$top"), url.searchParams.get("$skip"), url.searchParams.get("$orderby")], ["api.movidesk.com", "/public/v1/tickets", String(PAGE_SIZE), "50", "lastUpdate desc"]);
});

test("mapTicket builds the loose ExternalTask shape and drops id-less rows", () => {
  const t = mapTicket(ticket(7), "https://acme.movidesk.com/x")!;
  assert.deepEqual([t.externalId, t.title, t.status, t.statusCategory, t.assignee, t.priority, t.url, t.updatedAt], ["7", "Subject 7", "Em atendimento", "doing", "Ana", "Alta", "https://acme.movidesk.com/Ticket/Edit/7", "2026-01-02T10:00:00Z"]);
  assert.deepEqual(t.fields.map((f) => f.label), ["Category", "Client", "Created"]);
  assert.equal(mapTicket(ticket(8), undefined)!.url, "https://app.movidesk.com/Ticket/Edit/8");
  assert.equal(mapTicket(ticket(9), "javascript:alert(1)")!.url, "https://app.movidesk.com/Ticket/Edit/9");
  assert.equal(mapTicket({ subject: "x" }, undefined), null);
});

test("listing sends the token over https to api.movidesk.com, normalizes tickets and paginates", async () => {
  const page = Array.from({ length: PAGE_SIZE }, (_, i) => ticket(100 + i, { baseStatus: i === 0 ? "Resolved" : "New" }));
  const { call, urls } = await setup(() => json(page));
  const r = await call("GET", "/v1/task-sources/movidesk/tickets/items?query=login");
  assert.equal(r.body.items.length, PAGE_SIZE);
  assert.equal(r.body.items[0].statusCategory, "done");
  assert.equal(r.body.items[1].sourceId, "movidesk/tickets");
  assert.equal(r.body.nextCursor, String(PAGE_SIZE));
  const u = urls[0];
  assert.deepEqual([u.protocol, u.hostname, u.searchParams.get("token"), u.searchParams.get("$filter")], ["https:", "api.movidesk.com", TOKEN, "contains(subject,'login')"]);
  await call("GET", `/v1/task-sources/movidesk/tickets/items?query=login&cursor=${PAGE_SIZE}`);
  assert.equal(urls[1].searchParams.get("$skip"), String(PAGE_SIZE));
  const short = await setup(() => json([ticket(1)]));
  assert.equal((await short.call("GET", "/v1/task-sources/movidesk/tickets/items")).body.nextCursor, undefined);
});

test("an empty search uses the saved default search", async () => {
  const { call, urls } = await setup(() => json([]));
  await call("PUT", "/v1/plugins/movidesk/settings", { settings: { defaultQuery: "vpn" } });
  await call("GET", "/v1/task-sources/movidesk/tickets/items");
  assert.equal(urls.at(-1)!.searchParams.get("$filter"), "contains(subject,'vpn')");
  await call("GET", "/v1/task-sources/movidesk/tickets/items?query=2041");
  assert.equal(urls.at(-1)!.searchParams.get("$filter"), "id eq 2041");
});

test("detail loads one ticket by id; non-numeric ids are not forwarded", async () => {
  const { call, urls } = await setup((u) => json(u.searchParams.get("id") === "55" ? ticket(55) : []));
  const r = await call("GET", "/v1/task-sources/movidesk/tickets/items/55");
  assert.equal(r.body.item.externalId, "55");
  assert.equal(urls[0].searchParams.get("id"), "55");
  await assert.rejects(call("GET", "/v1/task-sources/movidesk/tickets/items/1%20or%201"), (e: any) => e.status === 404);
  assert.equal(urls.length, 1);
});

test("the token never appears in errors, responses or logs", async () => {
  const { call, logs } = await setup(() => new Response(`oops ${TOKEN} ?token=${encodeURIComponent(TOKEN)}`, { status: 500 }));
  for (const path of ["/v1/task-sources/movidesk/tickets/items", "/v1/task-sources/movidesk/tickets/items/9"]) {
    await assert.rejects(call("GET", path), (e: any) => e.status === 502 && e.code === "source_unavailable" && !e.message.includes("tok/") && !e.message.includes("ABC"));
  }
  const network = await setup(() => { throw new Error(`connect failed https://api.movidesk.com/?token=${TOKEN}`); });
  await assert.rejects(network.call("GET", "/v1/task-sources/movidesk/tickets/items"), (e: any) => e.status === 502);
  for (const all of [logs, network.logs]) {
    const text = JSON.stringify(all);
    for (const form of [TOKEN, encodeURIComponent(TOKEN), JSON.stringify(TOKEN).slice(1, -1)]) assert.ok(!text.includes(form), form);
  }
});

test("without the secret the source is not configured and nothing is requested", async () => {
  const { call, urls } = await setup(() => json([]), { secret: false });
  // the host reports presence from the vault table, which is empty here: the missing-secret state, before any provider call
  const list = await call("GET", "/v1/task-sources");
  assert.deepEqual(list.body.sources[0].missingSecrets, ["MOVIDESK_TOKEN"]);
  await assert.rejects(call("GET", "/v1/task-sources/movidesk/tickets/items"), (e: any) => e.status === 409 && e.code === "not_configured");
  assert.equal(urls.length, 0);
});
