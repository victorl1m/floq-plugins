import test from "node:test";
import assert from "node:assert/strict";
import { PluginHost } from "../dist/plugins/host.js";
import azure from "../dist/plugins/azure-devops/index.js";
import { BUILTIN_PLUGINS } from "../dist/plugins/index.js";
import { BATCH_MAX, PAGE_SIZE, basicAuth, categoryOf, normalizeOrgUrl, validProject, wiql, fetchBatch } from "../dist/plugins/azure-devops/client.js";
import { parseManifest } from "../dist/plugins/manifest.js";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";

test.after(closeAll);
const PAT = "azpat/Secret+value=12345";
const ORG = "https://dev.azure.com/contoso";

const wi = (id: number, over: Record<string, unknown> = {}) => ({ id, fields: { "System.Id": id, "System.Title": `Item ${id}`, "System.State": "Active", "System.WorkItemType": "Bug", "System.AssignedTo": { displayName: "Ana", uniqueName: "ana@x.test" }, "System.ChangedDate": "2026-02-02T00:00:00Z", "System.CreatedDate": "2026-01-01T00:00:00Z", "Microsoft.VSTS.Common.Priority": 2, "System.Tags": "ui; urgent", ...over } });
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

interface Req { url: URL; method: string; headers: Record<string, string>; body: any }
async function setup(handler: (r: Req) => Response | Promise<Response>, opts: { secret?: boolean; settings?: Record<string, unknown> | null } = {}) {
  const f = await fakePool(); await f.addUser("u1");
  if (opts.secret !== false) await f.db.exec(`INSERT INTO vault_secrets (user_id, name, value_enc) VALUES ('u1', 'AZURE_DEVOPS_PAT', 'enc')`);
  const reqs: Req[] = []; const logs: unknown[] = [];
  const fetchImpl = async (u: URL, init: any) => { const r = { url: new URL(String(u)), method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined }; reqs.push(r); return handler(r); };
  const vault = { async reveal(_u: string, names: string[]) { return opts.secret === false ? {} : Object.fromEntries(names.map((n) => [n, PAT])); } };
  const host = new PluginHost(f.pool as never, { plugins: [azure], vault: vault as never, fetchImpl: fetchImpl as never, sink: (...a: unknown[]) => logs.push(a) });
  await host.load(); await host.enable("azure-devops", "u1");
  const call = (method: string, path: string, body?: unknown) => host.handle({ userId: "u1", method, pathname: new URL("http://x" + path).pathname, query: new URL("http://x" + path).searchParams, readBody: async () => body, requireAdmin: async () => undefined }) as Promise<any>;
  await call("PUT", "/v1/plugins/azure-devops/user", { enabled: true });
  if (opts.settings !== null) await call("PUT", "/v1/plugins/azure-devops/settings", { settings: opts.settings ?? { organizationUrl: ORG, project: "Web App" } });
  return { ...f, host, call, reqs, logs };
}

const standard = (ids: number[], over: Partial<Record<string, (r: Req) => Response>> = {}) => (r: Req) => {
  const p = r.url.pathname;
  if (p.endsWith("/_apis/wit/wiql")) return over.wiql?.(r) ?? json({ workItems: ids.map((id) => ({ id, url: "x" })) });
  if (p.endsWith("/_apis/wit/workitemsbatch")) return over.batch?.(r) ?? json({ count: r.body.ids.length, value: [...r.body.ids].reverse().map((id: number) => wi(id)) });
  if (p.includes("/workitemtypes/")) return over.states?.(r) ?? json({ value: [{ name: "Active", category: "InProgress" }, { name: "New", category: "Proposed" }, { name: "Closed", category: "Completed" }] });
  return new Response("nope", { status: 404 });
};

test("the manifest matches the brief and is registered as a built-in", () => {
  const m = parseManifest(azure.manifest);
  assert.deepEqual(m.secrets.map((s) => s.name), ["AZURE_DEVOPS_PAT"]);
  assert.deepEqual(m.network.allow, ["dev.azure.com", "*.visualstudio.com"]);
  assert.deepEqual(m.settings.map((s) => [s.key, s.type]), [["organizationUrl", "url"], ["project", "text"]]);
  assert.ok(BUILTIN_PLUGINS.includes(azure));
});

test("organization URLs and projects are validated", () => {
  assert.equal(normalizeOrgUrl("https://dev.azure.com/contoso/"), ORG);
  assert.equal(normalizeOrgUrl("https://dev.azure.com/contoso/Web%20App/_boards"), ORG);
  assert.equal(normalizeOrgUrl("https://contoso.visualstudio.com/DefaultCollection"), "https://contoso.visualstudio.com");
  for (const bad of ["http://dev.azure.com/contoso", "https://evil.test/contoso", "https://dev.azure.com/", "https://x.visualstudio.com.evil.test", "ftp://dev.azure.com/c", 5, null]) assert.equal(normalizeOrgUrl(bad), null, String(bad));
  assert.ok(validProject("Web App")); for (const bad of ["", "a/b", "a\\b", "x".repeat(65), 5]) assert.ok(!validProject(bad), String(bad));
});

test("WIQL targets the project, escapes quotes and searches titles or ids", () => {
  assert.match(wiql("Web App"), /\[System\.TeamProject\] = 'Web App'.*ORDER BY \[System\.ChangedDate\] DESC$/);
  assert.match(wiql("O'Brien", "it's"), /TeamProject\] = 'O''Brien'.*Title\] CONTAINS 'it''s'/);
  assert.match(wiql("P", "1042"), /\[System\.Id\] = 1042/);
  assert.doesNotMatch(wiql("P", "1042"), /CONTAINS/);
});

test("state categories map to the status category, with a name fallback", () => {
  for (const [c, s, want] of [["Proposed", "New", "todo"], ["InProgress", "Active", "doing"], ["Resolved", "Resolved", "doing"], ["Completed", "Closed", "done"], ["Removed", "Removed", "done"], [undefined, "Active", "doing"], [undefined, "Closed", "done"], [undefined, "Whatever", "todo"]] as const) assert.equal(categoryOf(c, s), want, `${c}/${s}`);
});

test("listing runs a WIQL query then one batch fetch, in WIQL order, with mapped categories", async () => {
  const { call, reqs } = await setup(standard([30, 20, 10], { batch: (r) => json({ value: [wi(10, { "System.State": "Closed" }), wi(30), wi(20, { "System.State": "New" })] }) }));
  const r = await call("GET", "/v1/task-sources/azure-devops/items/items?query=login");
  assert.deepEqual(r.body.items.map((i: any) => i.externalId), ["30", "20", "10"]);
  assert.deepEqual(r.body.items.map((i: any) => i.statusCategory), ["doing", "todo", "done"]);
  assert.equal(r.body.items[0].assignee, "Ana"); assert.equal(r.body.items[0].priority, "P2");
  assert.equal(r.body.items[0].url, `${ORG}/Web%20App/_workitems/edit/30`);
  assert.equal(r.body.nextCursor, undefined);
  const wiqlReq = reqs.find((q) => q.url.pathname.endsWith("/wiql"))!;
  assert.equal(wiqlReq.method, "POST");
  assert.match(wiqlReq.body.query, /CONTAINS 'login'/);
  assert.equal(wiqlReq.url.hostname, "dev.azure.com");
  assert.equal(reqs.filter((q) => q.url.pathname.endsWith("/workitemsbatch")).length, 1);
});

test("the batch is at most 200 ids and pages are 50; cursors walk the id list", async () => {
  assert.ok(PAGE_SIZE <= BATCH_MAX && BATCH_MAX === 200);
  const ids = Array.from({ length: 120 }, (_, i) => 1000 - i);
  const { call, reqs } = await setup(standard(ids));
  const first = await call("GET", "/v1/task-sources/azure-devops/items/items");
  assert.equal(first.body.items.length, PAGE_SIZE);
  assert.equal(first.body.nextCursor, String(PAGE_SIZE));
  const second = await call("GET", `/v1/task-sources/azure-devops/items/items?cursor=${PAGE_SIZE}`);
  assert.equal(second.body.items[0].externalId, String(1000 - PAGE_SIZE));
  const last = await call("GET", "/v1/task-sources/azure-devops/items/items?cursor=100");
  assert.equal(last.body.items.length, 20); assert.equal(last.body.nextCursor, undefined);
  for (const b of reqs.filter((q) => q.url.pathname.endsWith("/workitemsbatch"))) assert.ok(b.body.ids.length <= BATCH_MAX);
  await assert.rejects(fetchBatch((async () => { throw new Error("must not be called"); }) as never, "p", ORG, Array.from({ length: BATCH_MAX + 1 }, (_, i) => i + 1)), /batch too large/);
});

test("state definitions are fetched once per type and reused", async () => {
  const { call, reqs } = await setup(standard([1, 2]));
  await call("GET", "/v1/task-sources/azure-devops/items/items?query=a");
  await call("GET", "/v1/task-sources/azure-devops/items/items?query=b");
  assert.equal(reqs.filter((q) => q.url.pathname.includes("/workitemtypes/")).length, 1);
});

test("detail loads one work item", async () => {
  const { call, reqs } = await setup(standard([]));
  const r = await call("GET", "/v1/task-sources/azure-devops/items/items/42");
  assert.equal(r.body.item.externalId, "42");
  assert.deepEqual(reqs.find((q) => q.url.pathname.endsWith("/workitemsbatch"))!.body.ids, [42]);
  await assert.rejects(call("GET", "/v1/task-sources/azure-devops/items/items/4x2"), (e: any) => e.status === 404);
});

test("the PAT is sent only as Basic auth and never appears in errors, responses or logs", async () => {
  const { call, reqs, logs } = await setup(standard([1]));
  await call("GET", "/v1/task-sources/azure-devops/items/items");
  const auth = reqs[0].headers.Authorization;
  assert.equal(auth, basicAuth(PAT));
  assert.ok(![...reqs].some((q) => q.url.href.includes("azpat")));
  const failing = await setup(() => new Response(`bad ${PAT} ${Buffer.from(":" + PAT).toString("base64")}`, { status: 401 }));
  await assert.rejects(failing.call("GET", "/v1/task-sources/azure-devops/items/items"), (e: any) => e.status === 502 && e.code === "source_unavailable" && !/azpat|Secret/.test(e.message));
  const net = await setup(() => { throw new Error(`socket ${PAT}`); });
  await assert.rejects(net.call("GET", "/v1/task-sources/azure-devops/items/items"), (e: any) => e.status === 502);
  const forms = [PAT, encodeURIComponent(PAT), Buffer.from(PAT).toString("base64"), Buffer.from(":" + PAT).toString("base64")];
  for (const all of [logs, failing.logs, net.logs]) for (const f of forms) assert.ok(!JSON.stringify(all).includes(f), f);
});

test("missing secret or settings answer not_configured without any request", async () => {
  const noSecret = await setup(standard([1]), { secret: false });
  assert.deepEqual((await noSecret.call("GET", "/v1/task-sources")).body.sources[0].missingSecrets, ["AZURE_DEVOPS_PAT"]);
  await assert.rejects(noSecret.call("GET", "/v1/task-sources/azure-devops/items/items"), (e: any) => e.code === "not_configured");
  assert.equal(noSecret.reqs.length, 0);
  // settings are required by the manifest, so they cannot even be saved empty
  const noSettings = await setup(standard([1]), { settings: null });
  await assert.rejects(noSettings.call("GET", "/v1/task-sources/azure-devops/items/items"), (e: any) => e.status === 409 && e.code === "not_configured" && /organization URL/.test(e.message));
  assert.equal(noSettings.reqs.length, 0);
  const badSave = await setup(standard([1]), { settings: null });
  await assert.rejects(badSave.call("PUT", "/v1/plugins/azure-devops/settings", { settings: { organizationUrl: "https://dev.azure.com/c" } }), (e: any) => e.status === 400);
  // a syntactically valid but foreign host passes the settings form and is refused by the plugin (and by the allow-list)
  const foreign = await setup(standard([1]), { settings: { organizationUrl: "https://evil.test/org", project: "P" } });
  await assert.rejects(foreign.call("GET", "/v1/task-sources/azure-devops/items/items"), (e: any) => e.code === "not_configured");
  assert.equal(foreign.reqs.length, 0);
});
