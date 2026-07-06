import { NumberInput, SegmentedControl, Stack, Switch, Text, TextInput } from "@mantine/core";
import { useEffect, useState } from "react";
import { DispatchBackend } from "../../../shared/types.ts";
import { useStore } from "../../store.ts";

// Cloud-dispatch settings: what "Dispatch remote" launches, and how the exe.dev VM
// backend is configured. Persisted server-side (via setDispatchSettings → POST
// /settings); text/number fields buffer locally and commit on blur so we don't POST
// per keystroke, while the toggle/segmented commit immediately (mirrors the
// autoRebase Switch idiom).
export function DispatchControl() {
  const backend = useStore((s) => s.dispatchBackend);
  const template = useStore((s) => s.exeTemplate);
  const ttydPort = useStore((s) => s.exeTtydPort);
  const claudeFlags = useStore((s) => s.exeClaudeFlags);
  const autoTeardown = useStore((s) => s.exeAutoTeardown);
  const save = useStore((s) => s.setDispatchSettings);

  const [tpl, setTpl] = useState(template);
  const [flags, setFlags] = useState(claudeFlags);
  const [port, setPort] = useState<number | string>(ttydPort);
  // Re-seed the buffers when the server truth changes (initial load / revert-on-error).
  useEffect(() => setTpl(template), [template]);
  useEffect(() => setFlags(claudeFlags), [claudeFlags]);
  useEffect(() => setPort(ttydPort), [ttydPort]);

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
            size="xs"
            label="Template VM"
            description="An already-authed exe.dev VM (claude + gh) copied for each worker."
            value={tpl}
            onChange={(e) => setTpl(e.currentTarget.value)}
            onBlur={() => {
              const v = tpl.trim();
              if (v && v !== template) save({ exeTemplate: v });
            }}
          />
          <TextInput
            size="xs"
            label="Claude flags"
            description="Passed to claude on the worker. Skip-permissions runs the task unattended."
            value={flags}
            onChange={(e) => setFlags(e.currentTarget.value)}
            onBlur={() => flags !== claudeFlags && save({ exeClaudeFlags: flags })}
          />
          <NumberInput
            size="xs"
            label="ttyd port"
            description="Port the worker's terminal is served on — becomes the session URL."
            min={1}
            max={65535}
            allowDecimal={false}
            value={port}
            onChange={setPort}
            onBlur={() => {
              const n = Number(port);
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
