// First import, before react-dom: the opt-in re-render diagnostic (off unless
// ?scan / localStorage flag is set) must patch React's hook before react-dom
// registers its renderer, or it sees nothing. See react-scan.ts.
import "./react-scan.ts";
import "@mantine/core/styles.css";
import { MantineProvider, createTheme } from "@mantine/core";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";

const theme = createTheme({});

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// No StrictMode: it double-invokes effects in dev, which churns the PTY
// WebSocket (connect → cleanup → reconnect). The terminal owns a live socket,
// so a single, stable mount is what we want.
createRoot(root).render(
  <MantineProvider defaultColorScheme="dark" theme={theme}>
    <App />
  </MantineProvider>,
);
