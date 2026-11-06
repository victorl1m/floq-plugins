import { definePlugin } from "../../../shared/sdk";

/** Dev-only example (registered when FLOQ_DEV_PLUGINS=1). Copy it as the starting point for a real plugin. */
export const exampleManifest = {
  id: "example",
  name: "Example",
  version: "1.0.0",
  apiVersion: 1,
  tier: "core",
  description: "Shows a view, a setting, a route and an event. Dev only.",
  icon: "IconPlug",
  scope: "user",
  settings: [{ key: "greeting", type: "text", label: "Greeting", description: "Used by the hello route.", required: false }],
  contributes: { views: [{ id: "main", label: "Example", icon: "IconPlug" }], routes: true },
};

export default definePlugin({
  manifest: exampleManifest,
  start(ctx) {
    // A route: GET /v1/plugins/example/api/hello. Runs as the calling user; the return value is the JSON body.
    ctx.routes.get("/hello", async ({ userId }) => {
      const { greeting } = await ctx.settings.get(userId);
      return { message: typeof greeting === "string" && greeting ? greeting : "Hello from the example plugin" };
    });
    // An event: the UI half listens with usePluginEvent("example", "pinged", ...). Data is JSON, at most 64 KiB.
    ctx.routes.post("/ping", async ({ userId, body }) => {
      ctx.events.publish(userId, "pinged", { at: new Date().toISOString(), body: body ?? null });
      return { ok: true };
    });
  },
});
