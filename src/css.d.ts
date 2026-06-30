// CSS is imported for its side effect (the bundler injects it); TypeScript has no type
// for a `.css` module, so declare one. Keeps `tsc --noEmit` clean — the build (bun)
// handles the actual CSS.
declare module "*.css";
