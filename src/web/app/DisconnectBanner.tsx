export function DisconnectBanner() {
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 10000,
        background: "#b54708", // lint-allow-color: fixed alert color — a disconnect warning must read the same in every theme
        color: "#fff", // lint-allow-color: text on the fixed alert background
        textAlign: "center",
        padding: "5px 10px",
        fontSize: "0.8125rem",
        fontFamily: "var(--mantine-font-family-monospace)",
      }}
    >
      Disconnected from the supervisor — reconnecting, will refresh when it's back…
    </div>
  );
}
