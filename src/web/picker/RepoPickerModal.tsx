import { Modal } from "@mantine/core";
import { useStore } from "../store.ts";
import { PickerBody } from "./PickerBody.tsx";

// The Blender-style repo picker (docs/vocabulary.md § Repo, docs/windows.md): a
// centered, keyboard-first overlay for adding repos to the flat registry. Two
// sources — your own gh repos (fetched once per open, filtered as you type) and
// a public GitHub search (debounced) — rendered as one multi-select list.
// Confirm POSTs each picked slug to /repos/register, which is fork-first: a repo
// you can't push to is forked and YOUR FORK is registered (upstream recorded),
// so the result may live under a different slug than the one you picked —
// that's shown in place before the modal closes. Registered rows stream back
// over /sync into the repos collection, so everything else updates on its own.
//
// Scoped mode (`repoPicker.forWindowId`, set by Ctrl+N / the rail's `+`): the
// picker is populating a fresh Window, so the picked repos also become that
// window's tabs — including already-registered rows, which stay pickable and
// just contribute their existing id.

export function RepoPickerModal() {
  const picker = useStore((s) => s.repoPicker);
  const close = useStore((s) => s.closeRepoPicker);
  return (
    <Modal
      opened={picker != null}
      onClose={close}
      title={picker?.forWindowId ? "New window — pick its repos" : "Add repos"}
      size="lg"
      centered
      // Fresh state per open (source, query, selection) — cheapest as a remount.
      keepMounted={false}
    >
      {picker != null && <PickerBody close={close} forWindowId={picker.forWindowId} />}
    </Modal>
  );
}
