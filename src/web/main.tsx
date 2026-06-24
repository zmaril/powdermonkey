import "@mantine/core/styles.css";
import { createTheme, MantineProvider } from "@mantine/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatApp } from "./chat/ChatApp.tsx";
import "./chat/markdown.css";

const theme = createTheme({
  primaryColor: "orange",
  fontFamily:
    "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
  headings: { fontFamily: 'Georgia, "Times New Roman", serif' },
  defaultRadius: "md",
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <ChatApp />
    </MantineProvider>
  </StrictMode>,
);
