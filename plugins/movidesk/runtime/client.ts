import type { ExternalTask, StatusCategory } from "../taskSources.js";
import type { PluginFetchResponse } from "../sdk.js";

export const PAGE_SIZE = 25;
export const DEFAULT_PORTAL = "https://app.movidesk.com";

/** `fetch` as the plugin gets it from `ctx.fetch` (allow-listed, https only). */
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<PluginFetchResponse>;

/** Movidesk `baseStatus` to the host's status categories. Unknown values read as "todo". */
export function statusCategory(baseStatus: unknown): StatusCategory {
  switch (typeof baseStatus === "string" ? baseStatus.toLowerCase() : "") {
    case "inattendance": case "stopped": return "doing";
    case "resolved": case "closed": case "canceled": case "cancelled": return "done";
    default: return "todo";
  }
}

const quote = (s: string) => s.replace(/'/g, "''");

/** OData `$filter` for a search text: a ticket number, or the subject containing the text. Empty text means no filter. */
export function filterFor(query: string | undefined): string | undefined {
  const q = (query ?? "").trim().slice(0, 100);
  if (!q) return undefined;
  if (/^\d{1,12}$/.test(q)) return `id eq ${q}`;
  return `contains(subject,'${quote(q)}')`;
}

const SELECT = "id,subject,status,baseStatus,urgency,category,createdDate,lastUpdate";
const EXPAND = "owner($select=businessName),clients($select=businessName)";

/** The token travels in the query string (Movidesk's API requires it): never log or surface this URL. */
export function ticketsUrl(token: string, opts: { filter?: string; skip?: number; id?: string }): string {
  const p = new URLSearchParams({ token });
  if (opts.id) p.set("id", opts.id);
  else {
    p.set("$select", SELECT);
    p.set("$expand", EXPAND);
    p.set("$orderby", "lastUpdate desc");
    p.set("$top", String(PAGE_SIZE));
    if (opts.skip) p.set("$skip", String(opts.skip));
    if (opts.filter) p.set("$filter", opts.filter);
  }
  return `https://api.movidesk.com/public/v1/tickets?${p.toString()}`;
}

/** Errors name the HTTP status only: never the URL (it contains the token) or the upstream body. */
export class MovideskError extends Error {
  constructor(readonly status: number) { super(`Movidesk request failed (HTTP ${status})`); this.name = "MovideskError"; }
}

export async function getJson(fetch: Fetch, url: string): Promise<unknown> {
  let res: PluginFetchResponse;
  try { res = await fetch(url, { headers: { Accept: "application/json" } }); }
  catch { throw new MovideskError(0); }
  if (!res.ok) throw new MovideskError(res.status);
  try { return res.json(); } catch { throw new MovideskError(res.status); }
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

export function ticketUrl(portalUrl: string | undefined, id: string): string {
  let base = DEFAULT_PORTAL;
  try { if (portalUrl) { const u = new URL(portalUrl); if (u.protocol === "https:" || u.protocol === "http:") base = u.origin; } } catch { /* default */ }
  return `${base}/Ticket/Edit/${encodeURIComponent(id)}`;
}

/** Raw Movidesk ticket to the loose shape the host normalizes. Returns null for rows without an id. */
export function mapTicket(raw: unknown, portalUrl: string | undefined): (Omit<ExternalTask, "sourceId"> & { sourceId?: string }) | null {
  const t = raw as Record<string, any> | null;
  const id = str(t?.id);
  if (!t || !id) return null;
  const clients: string[] = Array.isArray(t.clients) ? t.clients.map((c: any) => str(c?.businessName)).filter(Boolean) : [];
  const fields = [
    { label: "Category", value: str(t.category) },
    { label: "Client", value: clients.join(", ") },
    { label: "Created", value: str(t.createdDate) },
  ].filter((f) => f.value);
  return {
    externalId: id, title: str(t.subject) || `Ticket ${id}`, status: str(t.status), statusCategory: statusCategory(t.baseStatus),
    assignee: str(t.owner?.businessName) || undefined, priority: str(t.urgency) || undefined,
    url: ticketUrl(portalUrl, id), updatedAt: str(t.lastUpdate) || str(t.createdDate), fields,
  };
}
