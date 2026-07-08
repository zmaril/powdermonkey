import {
  Badge,
  Group,
  NumberInput,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { DispatchBackend, type EnvCapability, type Offering } from "../../../shared/types.ts";
import { useStore } from "../../store.ts";

// Cloud-dispatch settings: what "Dispatch remote" launches, and how the exe.dev VM
// backend is configured. The backend picker is driven by pm's runtime registry —
// disponent's offerings table (env × agent × model), fetched into the store from
// /offerings — instead of a hardcoded list of backends. Persisted server-side (via
// setDispatchSettings → POST /settings). Text/number fields are uncontrolled —
// `defaultValue` seeds them and a `key` bound to the server value remounts (re-seeds)
// them on load / revert, so they commit on blur without a local-state effect; the
// toggle/switch commit immediately.

// Slice-1 bridge from disponent's offering envs onto pm's two existing dispatch
// backends: the `exe-dev` env is the exe.dev VM backend; every other env (today only
// `local`) maps to the `claude --remote` path. This keeps dispatch.ts (which branches
// on DispatchBackend) untouched while the picker is registry-sourced. Widening
// DispatchBackend to the full env × agent × model registry — and routing the other
// envs through disponent — is a later slice (see docs/agents-and-models.md).
function backendForEnv(envSlug: string): DispatchBackend {
  return envSlug === DispatchBackend.ExeDev ? DispatchBackend.ExeDev : DispatchBackend.ClaudeRemote;
}

// Human names for the two backends the picker maps onto. The *set* of options and the
// models under each come from the offerings registry; this is just display naming.
const BACKEND_LABEL: Record<DispatchBackend, string> = {
  [DispatchBackend.ExeDev]: "exe.dev VM",
  [DispatchBackend.ClaudeRemote]: "claude --remote",
};

// The env's offerings folded onto the backend they map to: the picker's options and,
// per option, the agent + models disponent offers there. Falls back to the two known
// backends (empty models) when the registry hasn't loaded, so the control is never
// blank. Insertion order is preserved so the picker is stable.
function backendsFromOfferings(
  offerings: Offering[],
): Map<DispatchBackend, { models: Offering[] }> {
  const byBackend = new Map<DispatchBackend, { models: Offering[] }>();
  for (const o of offerings) {
    const backend = backendForEnv(o.envSlug);
    const entry = byBackend.get(backend) ?? { models: [] };
    entry.models.push(o);
    byBackend.set(backend, entry);
  }
  if (byBackend.size === 0) {
    byBackend.set(DispatchBackend.ExeDev, { models: [] });
    byBackend.set(DispatchBackend.ClaudeRemote, { models: [] });
  }
  return byBackend;
}

// The per-env capabilities folded onto the backend they map to (same slice-1
// bridge as the models). Each backend gets the deduped set of capability tokens
// disponent advertises for its env(s), in first-seen order so the badges are
// stable. Empty when the registry hasn't loaded — the picker then omits the caps
// line rather than implying a backend can do nothing.
function capabilitiesByBackend(caps: EnvCapability[]): Map<DispatchBackend, string[]> {
  const byBackend = new Map<DispatchBackend, string[]>();
  for (const c of caps) {
    const backend = backendForEnv(c.envSlug);
    const list = byBackend.get(backend) ?? [];
    if (!list.includes(c.capability)) list.push(c.capability);
    byBackend.set(backend, list);
  }
  return byBackend;
}

export function DispatchControl() {
  const backend = useStore((s) => s.dispatchBackend);
  const template = useStore((s) => s.exeTemplate);
  const ttydPort = useStore((s) => s.exeTtydPort);
  const claudeFlags = useStore((s) => s.exeClaudeFlags);
  const autoTeardown = useStore((s) => s.exeAutoTeardown);
  const offerings = useStore((s) => s.offerings);
  const capabilities = useStore((s) => s.capabilities);
  const save = useStore((s) => s.setDispatchSettings);

  const isExe = backend === DispatchBackend.ExeDev;
  const byBackend = backendsFromOfferings(offerings);
  const data = [...byBackend.keys()].map((b) => ({ label: BACKEND_LABEL[b], value: b }));
  const models = byBackend.get(backend)?.models ?? [];
  const caps = capabilitiesByBackend(capabilities).get(backend) ?? [];

  return (
    <Stack gap="snug">
      <Text size="sm" fw={600}>
        Cloud dispatch
      </Text>
      <Text size="xs" c="dimmed">
        What "Dispatch remote" launches, from the dispatch runtime registry (disponent's offerings).{" "}
        <b>exe.dev VM</b> provisions a throwaway VM per task (copied from an authed template,
        running claude in tmux, exposed over ttyd) and tears it down when the task ends.
        <b> claude --remote</b> runs the session in Anthropic's cloud.
      </Text>

      <SegmentedControl
        size="xs"
        value={backend}
        onChange={(v) => save({ dispatchBackend: v as DispatchBackend })}
        data={data}
      />

      {/* The env × agent × model this backend offers, straight from the registry — the
          default model marked. Model selection isn't persisted yet (a later slice); this
          surfaces what's available. Hidden until the registry loads. */}
      {models.length > 0 && (
        <Text size="xs" c="dimmed">
          {models[0].agentName} ·{" "}
          {models.map((m) => (m.isDefault ? `${m.modelId} (default)` : m.modelId)).join(", ")}
        </Text>
      )}

      {/* What this backend's environment can do, straight from disponent's
          env_capabilities edge (GET /capabilities) — honest display, only what
          disponent advertises. One badge per capability token. Hidden until the
          registry loads. */}
      {caps.length > 0 && (
        <Stack gap="tight">
          <Text size="xs" c="dimmed">
            Capabilities
          </Text>
          <Group gap="hair">
            {caps.map((c) => (
              <Badge key={c} size="xs" variant="light" radius="sm" tt="none" fw={500}>
                {c}
              </Badge>
            ))}
          </Group>
        </Stack>
      )}

      {isExe && (
        <Stack gap="xs">
          <TextInput
            key={template}
            size="xs"
            label="Template VM"
            description="An already-authed exe.dev VM (claude + gh) copied for each worker."
            defaultValue={template}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              if (v && v !== template) save({ exeTemplate: v });
            }}
          />
          <TextInput
            key={claudeFlags}
            size="xs"
            label="Claude flags"
            description="Passed to claude on the worker. Skip-permissions runs the task unattended."
            defaultValue={claudeFlags}
            onBlur={(e) => {
              const v = e.currentTarget.value;
              if (v !== claudeFlags) save({ exeClaudeFlags: v });
            }}
          />
          <NumberInput
            key={ttydPort}
            size="xs"
            label="ttyd port"
            description="Port the worker's terminal is served on — becomes the session URL."
            min={1}
            max={65535}
            allowDecimal={false}
            defaultValue={ttydPort}
            onBlur={(e) => {
              const n = Number(e.currentTarget.value);
              if (Number.isInteger(n) && n >= 1 && n <= 65535 && n !== ttydPort) {
                save({ exeTtydPort: n });
              }
            }}
          />
          <Switch
            size="sm"
            label="Auto-teardown"
            description="Delete a worker VM when its task lands or is cancelled, or its session is stopped."
            checked={autoTeardown}
            onChange={(e) => save({ exeAutoTeardown: e.currentTarget.checked })}
          />
        </Stack>
      )}
    </Stack>
  );
}
