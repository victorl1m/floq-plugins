import { useState } from "react";
import { IconSend } from "@tabler/icons-react";
import { Button, PluginPage, PluginState, toast, usePluginApi, usePluginEvent } from "@/plugins/kit";
import { defineUiPlugin, type PluginViewProps } from "@/plugins/sdk";

/** Dev-only example UI half. Imports only react, tabler icons, the kit and the sdk (scripts/test-plugin-imports.mjs enforces it). */
function ExampleView({ plugin }: PluginViewProps) {
  const api = usePluginApi(plugin.id);
  const [message, setMessage] = useState<string | null>(null);
  const [pings, setPings] = useState<string[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  usePluginEvent<{ at: string }>(plugin.id, "pinged", (data) => setPings((prev) => [data.at, ...prev].slice(0, 5)));

  const hello = async () => {
    try { setFailed(null); setMessage((await api<{ message: string }>("/hello")).message); }
    catch (error) { setFailed(error instanceof Error ? error.message : "Request failed"); }
  };
  return (
    <PluginPage title="Example" description="A view, a setting, a route and an event. Change the greeting in Settings > Plugins."
      actions={<Button size="sm" onClick={() => void hello()}>Say hello</Button>}>
      {failed ? <PluginState state="error" description={failed} onRetry={() => void hello()} />
        : message ? <p className="text-sm">{message}</p>
        : <PluginState state="empty" title="Nothing yet" description="Press “Say hello” to call the plugin's route." />}
      <div className="space-y-2">
        <Button variant="outline" size="sm" onClick={() => void api("/ping", { method: "POST", body: {} }).then(() => toast.success("Pinged"))}><IconSend /> Send a ping event</Button>
        {pings.length > 0 && <ul className="font-mono text-xs text-muted-foreground">{pings.map((at) => <li key={at}>ping at {at}</li>)}</ul>}
      </div>
    </PluginPage>
  );
}

export default defineUiPlugin({ views: { main: ExampleView } });
