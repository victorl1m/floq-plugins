import { definePlugin, type PluginContext } from "../../../shared/sdk";
import manifest from "../plugin.json" with { type: "json" };
import { PAGE_SIZE, filterFor, getJson, mapTicket, ticketsUrl } from "./client.js";

/** Movidesk tickets as a read-only Tasks source. The token comes from the user's vault (`MOVIDESK_TOKEN`), never from settings. */
export default definePlugin({
  manifest,
  start(ctx: PluginContext) {
    const token = async (userId: string) => {
      const t = await ctx.secrets.get(userId, "MOVIDESK_TOKEN");
      if (!t) throw ctx.httpError(409, "not_configured", "Add the MOVIDESK_TOKEN secret first.");
      return t;
    };
    const portal = async (userId: string) => {
      const v = (await ctx.settings.get(userId)).portalUrl;
      return typeof v === "string" ? v : undefined;
    };

    ctx.taskSources.register({
      id: "tickets",
      provider: {
        async list(userId, { query, cursor }) {
          const settings = await ctx.settings.get(userId);
          const text = query?.trim() || (typeof settings.defaultQuery === "string" ? settings.defaultQuery : "");
          const skip = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0);
          const rows = await getJson(ctx.fetch, ticketsUrl(await token(userId), { filter: filterFor(text), skip }));
          const list = Array.isArray(rows) ? rows : [];
          const portalUrl = typeof settings.portalUrl === "string" ? settings.portalUrl : undefined;
          const items = list.flatMap((r) => mapTicket(r, portalUrl) ?? []);
          return { items, nextCursor: list.length >= PAGE_SIZE ? String(skip + list.length) : undefined };
        },
        async get(userId, externalId) {
          if (!/^\d{1,12}$/.test(externalId)) return null;
          const row = await getJson(ctx.fetch, ticketsUrl(await token(userId), { id: externalId }));
          const one = Array.isArray(row) ? row[0] : row;
          return mapTicket(one, await portal(userId));
        },
      },
    });
  },
});
