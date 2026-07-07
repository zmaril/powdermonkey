import { Badge, Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import {
  defaultOrigin,
  getSavedServers,
  getServerBase,
  isDesktop,
  normalizeServerBase,
  probeServer,
  type SavedServer,
  setSavedServers,
  setServerBase,
} from "../../server.ts";

// Pick which supervisor this client talks to. Only meaningful for a desktop /
// remote client (the bundle the supervisor serves to itself is always same-origin);
// for that web case "This device" is the active server and there's nothing to add.
// In the desktop shell "This device" resolves to the local supervisor (localhost:4500)
// rather than the tauri:// asset origin, so it connects out of the box (server.ts).
//
// Switching writes the new base (server.ts) and reloads: the Eden treaty and the
// sync sockets are module-level singletons built once at import against the base,
// so a reload is how they re-point cleanly — same mechanism useConnectionWatch
// already uses to recover. The server's permissive CORS lets these cross-origin
// calls through; access is gated at the network layer (Tailscale), not by auth.

function switchTo(base: string): void {
  setServerBase(base);
  window.location.reload();
}

export function ServerControl() {
  const active = getServerBase(); // "" = same origin (this device)
  const [servers, setServers] = useState<SavedServer[]>(getSavedServers);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  // In a browser "This device" is literally the same origin; in the desktop shell
  // there is no same-origin server, so it resolves to the local supervisor — show
  // that address so the row is honest about where "Connect" points.
  const localLabel = isDesktop() ? `This device (${defaultOrigin()})` : "This device (same origin)";

  const persist = (list: SavedServer[]) => {
    setSavedServers(list);
    setServers(list);
  };

  const add = async () => {
    setError(null);
    const origin = normalizeServerBase(url);
    if (!origin) return setError("That doesn't look like a valid URL.");
    setTesting(true);
    const reachable = await probeServer(origin);
    setTesting(false);
    if (!reachable) {
      return setError(
        `Couldn't reach ${origin}/health — is the supervisor up and on your tailnet?`,
      );
    }
    const label = name.trim() || origin;
    // De-dupe by origin; refresh the name if it changed.
    const next = [...servers.filter((s) => s.url !== origin), { name: label, url: origin }];
    persist(next);
    setName("");
    setUrl("");
  };

  const remove = (origin: string) => persist(servers.filter((s) => s.url !== origin));

  return (
    <Stack gap="snug">
      <Text size="sm" fw={600}>
        Server
      </Text>
      <Text size="xs" c="dimmed">
        Which PowderMonkey supervisor this client connects to. Point a desktop client at a
        supervisor running on another machine (e.g. over Tailscale); switching reconnects with a
        reload.
      </Text>

      <Group gap="xs" align="center">
        <Text size="xs" c="dimmed">
          Connected to:
        </Text>
        <Badge size="sm" variant="light">
          {active || localLabel}
        </Badge>
      </Group>

      {/* "This device" — the supervisor serving this bundle in a browser (same origin),
          or the local supervisor (localhost:4500) in the desktop shell, which has no
          same-origin server of its own. */}
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm">{localLabel}</Text>
        {active === "" ? (
          <Badge size="sm" color="green" variant="light">
            active
          </Badge>
        ) : (
          <Button size="compact-xs" variant="default" onClick={() => switchTo("")}>
            Connect
          </Button>
        )}
      </Group>

      {servers.map((s) => (
        <Group key={s.url} justify="space-between" wrap="nowrap">
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text size="sm" truncate>
              {s.name}
            </Text>
            <Text size="xs" c="dimmed" truncate>
              {s.url}
            </Text>
          </Stack>
          <Group gap="xs" wrap="nowrap">
            {active === s.url ? (
              <Badge size="sm" color="green" variant="light">
                active
              </Badge>
            ) : (
              <Button size="compact-xs" variant="default" onClick={() => switchTo(s.url)}>
                Connect
              </Button>
            )}
            <Button size="compact-xs" variant="subtle" color="red" onClick={() => remove(s.url)}>
              Remove
            </Button>
          </Group>
        </Group>
      ))}

      <Group gap="xs" align="flex-end" wrap="nowrap">
        <TextInput
          size="xs"
          label="Name"
          placeholder="cloud box"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          style={{ flex: "0 0 8rem" }}
        />
        <TextInput
          size="xs"
          label="URL"
          placeholder="pm.my-tailnet.ts.net:4500"
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          style={{ flex: 1 }}
        />
        <Button size="xs" variant="light" loading={testing} onClick={add}>
          Test &amp; add
        </Button>
      </Group>
      {error && (
        <Text size="xs" c="red">
          {error}
        </Text>
      )}
    </Stack>
  );
}
