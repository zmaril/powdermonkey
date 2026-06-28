import { Text } from "@mantine/core";

// A browser pane: loads a URL in an iframe so you can watch a dev server / local
// preview without leaving the app. Point it at a worker's `bun run dev` (or any
// localhost preview) and see what it built on the same pane of glass as the shell
// and the plan tree.
//
// This is the bare loader — the URL comes in as a dockview panel param. Entering /
// remembering a URL, reload, open-in-real-browser and the iframe-limit handling
// land on top of this (next phase).
export function BrowserPane({ url }: { url: string }) {
  if (!url) {
    return (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#1a1b1e",
        }}
      >
        <Text size="sm" c="dimmed">
          No URL to load.
        </Text>
      </div>
    );
  }
  return (
    <div style={{ height: "100%", width: "100%", background: "#fff" }}>
      <iframe
        src={url}
        title={url}
        style={{ width: "100%", height: "100%", border: "none", display: "block" }}
      />
    </div>
  );
}
