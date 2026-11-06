import type { ExternalTask, StatusCategory } from "../taskSources.js";
import type { PluginFetchResponse } from "../sdk.js";

export const PAGE_SIZE = 50;
/** `workitemsbatch` accepts at most 200 ids per request. */
export const BATCH_MAX = 200;
export const WIQL_TOP = 1000;
const API = "api-version=7.1";
export const FIELDS = ["System.Id", "System.Title", "System.State", "System.WorkItemType", "System.AssignedTo", "System.ChangedDate", "System.CreatedDate", "Microsoft.VSTS.Common.Priority", "System.Tags"];

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<PluginFetchResponse>;

/** Errors name the HTTP status only: never URLs, headers (the PAT is in one) or upstream bodies. */
export class AzureDevOpsError extends Error {
  constructor(readonly status: number) { super(`Azure DevOps request failed (HTTP ${status})`); this.name = "AzureDevOpsError"; }
}

/** `https://dev.azure.com/org` or `https://org.visualstudio.com`, without a trailing slash. Null for anything else. */
export function normalizeOrgUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase();
    if (host === "dev.azure.com") {
      const org = u.pathname.split("/").filter(Boolean)[0];
      return org && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(org) ? `https://dev.azure.com/${org}` : null;
    }
    return /^[a-z0-9][a-z0-9-]{0,63}\.visualstudio\.com$/.test(host) ? `https://${host}` : null;
  } catch { return null; }
}

export const validProject = (p: unknown): p is string => typeof p === "string" && p.trim().length > 0 && p.length <= 64 && !/[\\/:*?"<>|#$%&+@=\[\]{}\x00-\x1f]/.test(p);

export const basicAuth = (pat: string) => "Basic " + Buffer.from(":" + pat).toString("base64");

const quote = (s: string) => s.replace(/'/g, "''");

/** WIQL for the list. A number means a work item id; text searches titles. Newest change first. */
export function wiql(project: string, query?: string): string {
  const q = (query ?? "").trim().slice(0, 100);
  const where = [`[System.TeamProject] = '${quote(project)}'`, "[System.State] <> 'Removed'"];
  if (/^\d{1,12}$/.test(q)) where.push(`[System.Id] = ${q}`);
  else if (q) where.push(`[System.Title] CONTAINS '${quote(q)}'`);
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(" AND ")} ORDER BY [System.ChangedDate] DESC`;
}

/** Azure DevOps state categories to the host's. Unknown categories read as "todo". */
export function categoryOf(stateCategory: unknown, state: unknown): StatusCategory {
  switch (typeof stateCategory === "string" ? stateCategory : "") {
    case "InProgress": case "Resolved": return "doing";
    case "Completed": case "Removed": return "done";
    case "Proposed": return "todo";
  }
  // Fallback when the state definitions are unavailable: well-known state names of the standard processes.
  const s = typeof state === "string" ? state.toLowerCase() : "";
  if (["active", "committed", "in progress", "doing", "resolved", "in review", "approved"].includes(s)) return s === "approved" ? "todo" : "doing";
  if (["closed", "done", "completed", "removed", "cancelled", "canceled"].includes(s)) return "done";
  return "todo";
}

async function call(fetch: Fetch, pat: string, url: string, body?: unknown): Promise<any> {
  let res: PluginFetchResponse;
  try {
    res = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: { Authorization: basicAuth(pat), Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new AzureDevOpsError(0); }
  if (!res.ok) throw new AzureDevOpsError(res.status);
  try { return res.json(); } catch { throw new AzureDevOpsError(res.status); }
}

/** Ids matching the WIQL, newest change first (at most WIQL_TOP). */
export async function queryIds(fetch: Fetch, pat: string, org: string, project: string, query?: string): Promise<number[]> {
  const data = await call(fetch, pat, `${org}/${encodeURIComponent(project)}/_apis/wit/wiql?$top=${WIQL_TOP}&${API}`, { query: wiql(project, query) });
  return (Array.isArray(data?.workItems) ? data.workItems : []).map((w: any) => Number(w?.id)).filter((n: number) => Number.isInteger(n) && n > 0);
}

/** One batch call (never more than 200 ids). Rows come back in the order of `ids`. */
export async function fetchBatch(fetch: Fetch, pat: string, org: string, ids: number[]): Promise<any[]> {
  if (!ids.length) return [];
  if (ids.length > BATCH_MAX) throw new Error("batch too large");
  const data = await call(fetch, pat, `${org}/_apis/wit/workitemsbatch?${API}`, { ids, fields: FIELDS, errorPolicy: "Omit" });
  const byId = new Map<number, any>((Array.isArray(data?.value) ? data.value : []).filter(Boolean).map((w: any) => [Number(w.id), w]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** State name -> category for a work item type of a project (`/workitemtypes/{type}/states`). */
export async function stateCategories(fetch: Fetch, pat: string, org: string, project: string, type: string): Promise<Map<string, string>> {
  try {
    const data = await call(fetch, pat, `${org}/${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states?${API}`);
    return new Map((Array.isArray(data?.value) ? data.value : []).map((s: any) => [String(s?.name), String(s?.category)]));
  } catch { return new Map(); }
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

export function mapWorkItem(w: any, org: string, project: string, categories: Map<string, Map<string, string>>): (Omit<ExternalTask, "sourceId"> & { sourceId?: string }) | null {
  const f = w?.fields ?? {};
  const id = str(w?.id ?? f["System.Id"]);
  if (!id) return null;
  const type = str(f["System.WorkItemType"]);
  const state = str(f["System.State"]);
  const assigned = f["System.AssignedTo"];
  const tags = str(f["System.Tags"]);
  return {
    externalId: id, title: str(f["System.Title"]) || `Work item ${id}`, status: state,
    statusCategory: categoryOf(categories.get(type)?.get(state), state),
    assignee: typeof assigned === "object" && assigned ? str(assigned.displayName) || undefined : str(assigned) || undefined,
    priority: f["Microsoft.VSTS.Common.Priority"] !== undefined ? `P${str(f["Microsoft.VSTS.Common.Priority"])}` : undefined,
    url: `${org}/${encodeURIComponent(project)}/_workitems/edit/${encodeURIComponent(id)}`,
    updatedAt: str(f["System.ChangedDate"]) || str(f["System.CreatedDate"]),
    fields: [{ label: "Type", value: type }, { label: "Tags", value: tags }, { label: "Created", value: str(f["System.CreatedDate"]) }].filter((x) => x.value),
  };
}
