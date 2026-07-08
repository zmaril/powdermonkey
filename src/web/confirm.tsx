import { Button, Group, Modal, Text } from "@mantine/core";
import { create } from "zustand";

// A cross-environment replacement for window.confirm().
//
// window.confirm() (and alert/prompt) is a no-op in the Tauri desktop webview:
// WKWebView refuses the native dialog and returns false immediately, so a click
// guarded by `if (window.confirm(...))` silently does nothing on the desktop app
// while working fine in a browser. WONTDO and Stop both rode on window.confirm and
// so looked dead on the desktop.
//
// This renders the confirmation as an in-app Mantine modal instead, driven by an
// imperative confirm() that resolves a Promise<boolean> — the same call shape as
// window.confirm (`if (await confirm(...))`), but it renders (and works) in the
// browser AND the desktop shell. Mount <ConfirmHost/> once at the app root.

export type ConfirmOptions = {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean; // red confirm button for destructive actions
};

type ActiveRequest = ConfirmOptions & { resolve: (ok: boolean) => void };

const useConfirmStore = create<{ request: ActiveRequest | null }>(() => ({ request: null }));

/** Ask the operator to confirm an action. Resolves true on confirm, false on
 *  cancel/dismiss. Drop-in for window.confirm — pass a bare message or options —
 *  but renders an in-app modal, so it also works in the Tauri desktop shell where
 *  window.confirm is a no-op. */
export function confirm(options: ConfirmOptions | string): Promise<boolean> {
  const opts = typeof options === "string" ? { message: options } : options;
  return new Promise((resolve) => {
    // A confirm() while one is already open shouldn't strand the earlier promise:
    // settle it false (dismissed) before taking over the single modal slot.
    useConfirmStore.getState().request?.resolve(false);
    useConfirmStore.setState({ request: { ...opts, resolve } });
  });
}

/** The single modal host for confirm(). Mount once inside MantineProvider. */
export function ConfirmHost() {
  const request = useConfirmStore((s) => s.request);
  const settle = (ok: boolean) => {
    request?.resolve(ok);
    useConfirmStore.setState({ request: null });
  };
  return (
    <Modal
      opened={request !== null}
      onClose={() => settle(false)}
      title={request?.title ?? "Please confirm"}
      centered
      size="sm"
    >
      <Text size="sm">{request?.message}</Text>
      <Group justify="flex-end" mt="md">
        <Button variant="default" size="xs" onClick={() => settle(false)}>
          {request?.cancelLabel ?? "Cancel"}
        </Button>
        <Button color={request?.danger ? "red" : undefined} size="xs" onClick={() => settle(true)}>
          {request?.confirmLabel ?? "Confirm"}
        </Button>
      </Group>
    </Modal>
  );
}
