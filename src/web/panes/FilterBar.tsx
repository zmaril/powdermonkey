import type { ComboboxData } from "@mantine/core";
import { ActionIcon, Group, Select, TextInput, Tooltip } from "@mantine/core";
import { IconSearch, IconStar, IconStarFilled, IconX } from "@tabler/icons-react";
import { SessionKind } from "../../shared/types.ts";
import { ANY } from "./filters.ts";

// The shared search + filter strip for the Sessions and Tasks panes. Both slice live +
// history the same way — a text search, a status bucket, an environment (local/cloud), a
// goal/milestone scope, and a starred toggle — so the controls live in one component and
// each pane passes its own status options + current values. Everything is a controlled
// input driven by the pane's filter state; the matching itself is in filters.ts.

// Local / Cloud / either — the same for both panes (a session's kind, a task's session's
// kind). Values are the SessionKind enum (not literals) so the typed-string lint stays
// happy; ANY is the "don't filter" wildcard.
const ENV_DATA: ComboboxData = [
  { value: ANY, label: "Any env" },
  { value: SessionKind.Local, label: "Local" },
  { value: SessionKind.Remote, label: "Cloud" },
];

export type FilterBarProps = {
  search: string;
  onSearch: (v: string) => void;
  searchPlaceholder: string;
  statusData: ComboboxData;
  status: string;
  onStatus: (v: string) => void;
  env: string;
  onEnv: (v: string) => void;
  /** Grouped goal/milestone options ("g:<id>" / "m:<id>"), with a leading "Any" entry. */
  scopeData: ComboboxData;
  scope: string;
  onScope: (v: string) => void;
  starred: boolean;
  onStarred: (v: boolean) => void;
  /** Reset everything to the pane's defaults. Shown only when the filter is off-default. */
  onReset: () => void;
  isDefault: boolean;
};

export function FilterBar(props: FilterBarProps) {
  const StarIcon = props.starred ? IconStarFilled : IconStar;
  return (
    <Group gap="xs" wrap="wrap" align="center">
      <TextInput
        size="xs"
        flex="1 1 140px"
        miw={120}
        placeholder={props.searchPlaceholder}
        value={props.search}
        onChange={(e) => props.onSearch(e.currentTarget.value)}
        leftSection={<IconSearch size={13} />}
        aria-label="Search"
      />
      <Select
        size="xs"
        w={130}
        data={props.statusData}
        value={props.status}
        onChange={(v) => props.onStatus(v ?? ANY)}
        aria-label="Status filter"
        allowDeselect={false}
      />
      <Select
        size="xs"
        w={110}
        data={ENV_DATA}
        value={props.env}
        onChange={(v) => props.onEnv(v ?? ANY)}
        aria-label="Environment filter"
        allowDeselect={false}
      />
      <Select
        size="xs"
        w={170}
        data={props.scopeData}
        value={props.scope}
        onChange={(v) => props.onScope(v ?? ANY)}
        aria-label="Goal / milestone filter"
        allowDeselect={false}
        searchable
      />
      <Tooltip label={props.starred ? "Showing starred only" : "Starred only"} withArrow>
        <ActionIcon
          size="md"
          variant={props.starred ? "filled" : "default"}
          color="yellow"
          onClick={() => props.onStarred(!props.starred)}
          aria-label="Toggle starred only"
        >
          <StarIcon size={14} />
        </ActionIcon>
      </Tooltip>
      {!props.isDefault && (
        <Tooltip label="Reset filters" withArrow>
          <ActionIcon
            size="md"
            variant="subtle"
            color="gray"
            onClick={props.onReset}
            aria-label="Reset filters"
          >
            <IconX size={14} />
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  );
}
