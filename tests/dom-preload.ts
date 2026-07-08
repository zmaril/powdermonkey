// DOM test bootstrap for the React/Mantine component tests (`tests/*.test.tsx`).
//
// Loaded via `bun test --preload` (see package.json's `test` script), which runs it to
// completion *before* any test module loads. That ordering matters: `@testing-library`
// binds its `screen` queries to `document` at import time, so happy-dom has to register
// the DOM globals first. Doing it here (and importing testing-library only afterwards,
// dynamically) guarantees that order — an in-test `import` can't, because static
// imports are hoisted above the registration call.
//
// happy-dom builds a real DOM tree in-process (a browserless `window`/`document`), so
// `bun test` can mount components and assert on rendered markup. It never lays out or
// paints, so these tests cover *structure and behaviour* (text, roles, attributes,
// events) — not how anything looks. Pixels are Storybook's job.
//
// Only the `.test.tsx` loop preloads this; the `.test.ts` server/logic suites run in
// their own processes without a DOM, exactly as before.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// Imported after registration so testing-library sees a live document, then wire up
// jest-dom's matchers onto bun's expect and auto-unmount trees between tests.
const { afterEach, expect } = await import("bun:test");
const matchers = await import("@testing-library/jest-dom/matchers");
const { cleanup } = await import("@testing-library/react");

expect.extend(matchers as unknown as Parameters<typeof expect.extend>[0]);
afterEach(() => cleanup());
