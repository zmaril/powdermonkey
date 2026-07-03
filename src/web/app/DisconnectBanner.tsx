export function DisconnectBanner() {
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 10000,
        background: "var(--pm-alert-bg)",
        color: "var(--pm-alert-text)",
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
