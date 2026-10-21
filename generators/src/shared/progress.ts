// Generator progress lines. They go to stdout, and their shape must not look
// like a compiler diagnostic: GitHub problem matchers scan every line of a
// step's output, and actions/setup-go registers `^\s*(.+\.go):(?:(\d+):(\d+):)? (.*)`,
// so "wrote <file>.go: 125 cases" became a failure annotation on every SDK
// run that regenerates its tests. The path therefore comes last, with no
// ": " after it.

/** "[go] wrote 125 cases to /abs/path/get_generated_test.go" */
export function wroteLine(target: string, path: string, cases: number): string {
  return `[${target}] wrote ${cases} cases to ${path}`;
}
