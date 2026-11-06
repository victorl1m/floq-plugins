import { HttpError } from "../../errors.js";
import { definePlugin, type PluginContext } from "../sdk.js";
import manifest from "./plugin.json" with { type: "json" };
import { PAGE_SIZE, fetchBatch, mapWorkItem, normalizeOrgUrl, queryIds, stateCategories, validProject } from "./client.js";

const STATE_TTL_MS = 10 * 60_000;

/** Azure DevOps work items as a read-only Tasks source. The PAT comes from the user's vault (`AZURE_DEVOPS_PAT`). */
export default definePlugin({
  manifest,
  start(ctx: PluginContext) {
    // State definitions rarely change: cache them per organization, project and type.
    const cache = new Map<string, { at: number; value: Map<string, string> }>();

    async function config(userId: string) {
      const pat = await ctx.secrets.get(userId, "AZURE_DEVOPS_PAT");
      const settings = await ctx.settings.get(userId);
      const org = normalizeOrgUrl(settings.organizationUrl);
      const project = settings.project;
      if (!pat) throw new HttpError(409, "not_configured", "Add the AZURE_DEVOPS_PAT secret first.");
      if (!org || !validProject(project)) throw new HttpError(409, "not_configured", "Set the organization URL and the project in Settings > Plugins.");
      return { pat, org, project: project.trim() };
    }

    async function categoriesFor(c: { pat: string; org: string; project: string }, types: string[]) {
      const out = new Map<string, Map<string, string>>();
      for (const type of new Set(types.filter(Boolean))) {
        const key = `${c.org}|${c.project}|${type}`;
        let hit = cache.get(key);
        if (!hit || Date.now() - hit.at > STATE_TTL_MS) { hit = { at: Date.now(), value: await stateCategories(ctx.fetch, c.pat, c.org, c.project, type) }; cache.set(key, hit); }
        out.set(type, hit.value);
      }
      return out;
    }

    ctx.taskSources.register({
      id: "items",
      provider: {
        async list(userId, { query, cursor }) {
          const c = await config(userId);
          const offset = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0);
          const all = await queryIds(ctx.fetch, c.pat, c.org, c.project, query);
          const ids = all.slice(offset, offset + PAGE_SIZE);
          const rows = await fetchBatch(ctx.fetch, c.pat, c.org, ids);
          const cats = await categoriesFor(c, rows.map((r) => String(r?.fields?.["System.WorkItemType"] ?? "")));
          const items = rows.flatMap((r) => mapWorkItem(r, c.org, c.project, cats) ?? []);
          return { items, nextCursor: offset + PAGE_SIZE < all.length ? String(offset + PAGE_SIZE) : undefined };
        },
        async get(userId, externalId) {
          if (!/^\d{1,12}$/.test(externalId)) return null;
          const c = await config(userId);
          const [row] = await fetchBatch(ctx.fetch, c.pat, c.org, [Number(externalId)]);
          if (!row) return null;
          const cats = await categoriesFor(c, [String(row?.fields?.["System.WorkItemType"] ?? "")]);
          return mapWorkItem(row, c.org, c.project, cats);
        },
      },
    });
  },
});
