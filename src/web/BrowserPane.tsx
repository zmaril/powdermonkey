import { ActionIcon, Button, Group, Text, TextInput, Tooltip } from "@mantine/core";
import { IconExternalLink, IconRefresh } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { normalizeUrl } from "./browser-url.ts";

// A browser pane: loads a URL in an iframe so you can watch a dev server / local
// preview without leaving the app. Point it at a worker's `bun run dev` (or any
// localhost preview) and see what it built on the same pane of glass as the shell
// and the plan tree.
//
// The toolbar is the whole interaction: type a URL and hit enter to load it,
// reload, or pop it open in a real browser tab. `url` is the remembered address
// (persisted by the caller into the dockview panel params, so it survives a reload
// and the disconnect→refresh recovery); `onNavigate` is how a new address is
// handed back to be remembered.
//
// Iframe caveat: many sites refuse to be embedded (X-Frame-Options / CSP
// frame-ancestors) and will show up blank or as a browser error — there's no
// reliable cross-origin way to detect that from here, so we surface a dismissable
// hint and always keep an "Open" (new-tab) button handy. localhost dev servers
// almost always embed fine, which is the case this pane is for.
export function BrowserPane({
  url,
  onNavigate,
}: {
  url: string;
  onNavigate: (url: string) => void;
}) {
  // `draft` is the editable text in the bar; `current` is what the iframe loads.
  // They diverge while the operator is typing and re-converge on submit.
  const [draft, setDraft] = useState(url);
  const [current, setCurrent] = useState(url);
  // Bumped to force the iframe to reload — re-setting src to the same value won't
  // re-fetch, and a cross-origin frame can't be reloaded via contentWindow, so we
  // remount the element by changing its React key.
  const [nonce, setNonce] = useState(0);
  const [showHint, setShowHint] = useState(true);

  // Adopt an externally-changed url prop (e.g. a layout restore seeding the pane)
  // without clobbering an in-progress edit on every render.
  const lastProp = useRef(url);
  useEffect(() => {
    if (url !== lastProp.current) {
      lastProp.current = url;
      setDraft(url);
      setCurrent(url);
    }
  }, [url]);

  const go = (raw: string) => {
    const next = normalizeUrl(raw);
    setDraft(next);
    setCurrent(next);
    setNonce((n) => n + 1);
    if (next !== url) onNavigate(next);
  };

  return (
    <div style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column" }}>
      <Group
        gap="snug"
        wrap="nowrap"
        px="xs"
        py="snug"
        style={{ flex: "0 0 auto", background: "var(--pm-pane-bg)" }}
      >
        <Tooltip label="Reload" withArrow openDelay={400}>
          <ActionIcon
            variant="default"
            size="md"
            aria-label="Reload"
            onClick={() => setNonce((n) => n + 1)}
            disabled={!current}
          >
            <IconRefresh size={16} />
          </ActionIcon>
        </Tooltip>
        <form
          style={{ flex: 1, minWidth: 0 }}
          onSubmit={(e) => {
            e.preventDefault();
            go(draft);
          }}
        >
          <TextInput
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            placeholder="localhost:3000"
            size="xs"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
          />
        </form>
        <Button
          size="compact-xs"
          variant="default"
          component="a"
          href={current || undefined}
          target="_blank"
          rel="noopener noreferrer"
          disabled={!current}
          rightSection={<IconExternalLink size={13} />}
        >
          Open
        </Button>
      </Group>
      {showHint && (
        <Group
          gap="snug"
          wrap="nowrap"
          px="xs"
          py="tight"
          style={{
            flex: "0 0 auto",
            background: "var(--pm-surface)",
            borderTop: "1px solid var(--pm-hairline)",
          }}
        >
          <Text size="xs" c="dimmed" style={{ flex: 1 }}>
            Some sites block embedding (X-Frame-Options / CSP) and show up blank — use the Open
            button. localhost dev servers usually work.
          </Text>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            onClick={() => setShowHint(false)}
          >
            Dismiss
          </Button>
        </Group>
      )}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          background: "#fff", // lint-allow-color: neutral white backdrop behind an arbitrary embedded page, not app chrome
        }}
      >
        {current ? (
          <iframe
            key={`${current}#${nonce}`}
            src={current}
            title={current}
            style={{ width: "100%", height: "100%", border: "none", display: "block" }}
          />
        ) : (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--pm-pane-bg)",
            }}
          >
            <Text size="sm" c="dimmed">
              Enter a URL above to load a preview.
            </Text>
          </div>
        )}
      </div>
    </div>
  );
}
