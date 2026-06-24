// Shared form for a new Workspace: the basics plus an Advanced section for the
// context a worker needs (subpath, secrets, env files, setup). Controlled.

import { Anchor, Collapse, Stack, Textarea, TextInput } from "@mantine/core";
import { useState } from "react";

export interface WorkspaceFieldsValue {
  name: string;
  repoPath: string;
  subpath: string;
  secretsText: string; // KEY=VALUE per line
  envFilesText: string; // one path per line
  setup: string;
}

export const emptyWorkspaceFields: WorkspaceFieldsValue = {
  name: "",
  repoPath: "",
  subpath: "",
  secretsText: "",
  envFilesText: "",
  setup: "",
};

// Parse the Advanced text fields into the Workspace payload shape.
export function parseWorkspaceExtras(v: WorkspaceFieldsValue): {
  subpath?: string;
  secrets?: Record<string, string>;
  envFiles?: string[];
  setup?: string;
} {
  const secrets: Record<string, string> = {};
  for (const line of v.secretsText.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) secrets[m[1]] = m[2].trim();
  }
  const envFiles = v.envFilesText
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    subpath: v.subpath.trim() || undefined,
    secrets: Object.keys(secrets).length ? secrets : undefined,
    envFiles: envFiles.length ? envFiles : undefined,
    setup: v.setup.trim() || undefined,
  };
}

export function WorkspaceFields({
  value,
  onChange,
}: {
  value: WorkspaceFieldsValue;
  onChange: (v: WorkspaceFieldsValue) => void;
}) {
  const [adv, setAdv] = useState(false);
  const set =
    (k: keyof WorkspaceFieldsValue) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange({ ...value, [k]: e.currentTarget.value });

  return (
    <Stack gap="xs">
      <TextInput label="Workspace name" value={value.name} onChange={set("name")} />
      <TextInput
        label="Local repo path"
        placeholder="/Users/you/workspaces/whatever"
        value={value.repoPath}
        onChange={set("repoPath")}
      />
      <Anchor component="button" type="button" size="xs" onClick={() => setAdv((a) => !a)}>
        {adv ? "− Hide" : "+ Advanced"} · subpath, secrets, env files, setup
      </Anchor>
      <Collapse in={adv}>
        <Stack gap="xs">
          <TextInput
            label="Subpath (work inside this dir of the repo)"
            placeholder="apps/web"
            value={value.subpath}
            onChange={set("subpath")}
          />
          <Textarea
            label="Secrets (KEY=VALUE per line)"
            placeholder={"API_TOKEN=...\nDATABASE_URL=..."}
            autosize
            minRows={2}
            value={value.secretsText}
            onChange={set("secretsText")}
          />
          <Textarea
            label="Env files to source (one path per line)"
            placeholder="/Users/you/workspaces/app/.env"
            autosize
            minRows={1}
            value={value.envFilesText}
            onChange={set("envFilesText")}
          />
          <TextInput
            label="Setup shell (runs once on first launch)"
            placeholder="npm install"
            value={value.setup}
            onChange={set("setup")}
          />
        </Stack>
      </Collapse>
    </Stack>
  );
}
