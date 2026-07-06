import { NumberInput, SegmentedControl, Stack, Switch, Text, TextInput } from "@mantine/core";
import { DispatchBackend } from "../../../shared/types.ts";
import { useStore } from "../../store.ts";

// Cloud-dispatch settings: what "Dispatch remote" launches, and how the exe.dev VM
// backend is configured. Persisted server-side (via setDispatchSettings → POST
// /settings). Text/number fields are uncontrolled — `defaultValue` seeds them and a
// `key` bound to the server value remounts (re-seeds) them on load / revert, so they
// commit on blur without a local-state effect; the toggle/switch commit immediately.
export function DispatchControl() {
  const backend = useStore((s) => s.dispatchBackend);
  const template = useStore((s) => s.exeTemplate);
  const ttydPort = useStore((s) => s.exeTtydPort);
  const claudeFlags = useStore((s) => s.exeClaudeFlags);
  const autoTeardown = useStore((s) => s.exeAutoTeardown);
  const save = useStore((s) => s.setDispatchSettings);

  const isExe = backend === DispatchBackend.ExeDev;

  return (
    <Stack gap="snug">
      <Text size="sm" fw={600}>
        Cloud dispatch
      </Text>
      <Text size="xs" c="dimmed">
        What "Dispatch remote" launches. <b>exe.dev VM</b> provisions a throwaway VM per task
        (copied from an authed template, running claude in tmux, exposed over ttyd) and tears it
        down when the task ends. <b>claude --remote</b> runs the session in Anthropic's cloud.
      </Text>

      <SegmentedControl
        size="xs"
        value={backend}
        onChange={(v) => save({ dispatchBackend: v as DispatchBackend })}
        data={[
          { label: "exe.dev VM", value: DispatchBackend.ExeDev },
          { label: "claude --remote", value: DispatchBackend.ClaudeRemote },
        ]}
      />

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
