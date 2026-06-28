import { expect, test } from "bun:test";
import { componentNames } from "../scripts/check-one-component.ts";

// The one-component-per-file check (scripts/check-one-component.ts) leans on the
// codebase's naming convention to tell components apart from helpers and constant
// maps. These pin that behaviour: PascalCase functions/arrows count; camelCase
// helpers/hooks and UPPER_SNAKE constant maps don't.

test("counts top-level PascalCase function and arrow components", () => {
  const src = `
export function IdTag() { return <span/>; }
function PrRow() { return <div/>; }
const TaskLinks = ({ task }) => <a/>;
export default function App() { return <main/>; }
`;
  expect(componentNames(src).sort()).toEqual(["App", "IdTag", "PrRow", "TaskLinks"]);
});

test("ignores camelCase helpers and hooks", () => {
  const src = `
function prDot() { return { color: "red" }; }
function groupBySession() { return []; }
function useConnectionWatch() { return false; }
const partitionTasks = (tasks) => tasks;
`;
  expect(componentNames(src)).toEqual([]);
});

test("ignores UPPER_SNAKE constant maps even with arrow values", () => {
  const src = `
const STATUS_COLOR: Record<string, string> = { a: "gray" };
const KIND_ICON = { local: "💻" };
const HANDLERS = { onClick: () => fire() };
`;
  expect(componentNames(src)).toEqual([]);
});

test("ignores nested / inline components (only top-level counts)", () => {
  const src = `
export function Pane() {
  const Inner = () => <span/>;
  return <div>{rows.map((r) => <Row key={r} />)}</div>;
}
`;
  expect(componentNames(src)).toEqual(["Pane"]);
});

test("a single-component file is not an offender", () => {
  const src = "export function ShellTerminal() { return <div/>; }";
  expect(componentNames(src)).toEqual(["ShellTerminal"]);
});
