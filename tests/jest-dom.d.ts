// Teach TypeScript that bun's `expect(...)` carries jest-dom's DOM matchers, which we
// register at runtime in dom-preload.ts. Without this augmentation `toBeInTheDocument`,
// `toHaveAttribute`, etc. type-error even though they work. Picked up via tsconfig's
// `include: ["tests"]`.
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "bun:test" {
  interface Matchers<T> extends TestingLibraryMatchers<unknown, T> {}
}
