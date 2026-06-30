// PowderMonkey desktop — a native window over the web UI. No app logic lives here;
// the window loads the bundled frontend (../public) and everything else is the same
// TypeScript that runs in the browser. Which supervisor it talks to is chosen in the
// UI (Settings → Server) and persisted in the webview's localStorage.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the PowderMonkey desktop app");
}
