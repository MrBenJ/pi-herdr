import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import type { Input, Operation } from "../src/contracts.ts";
import { assertAllowed, boolean, envFlags, readFlags, requiredString, timeout } from "../src/actions/shared.ts";
import { compileTab, TabSchema } from "../src/actions/tab.ts";
import { compileWorkspace, WorkspaceSchema } from "../src/actions/workspace.ts";
import { compileAgent, AgentSchema } from "../src/actions/agent.ts";
import { compilePane, PaneSchema } from "../src/actions/pane.ts";
import { compile } from "../src/actions/index.ts";

describe("shared validators", () => {
  it("rejects array input", () => {
    expect(() => assertAllowed([] as unknown as Input, [])).toThrow(/invalid_input/);
  });

  it("rejects null input", () => {
    expect(() => assertAllowed(null as unknown as Input, [])).toThrow(/invalid_input/);
  });

  it("rejects fields outside the allowlist", () => {
    expect(() => assertAllowed({ action: "list", extra: true }, [])).toThrow(/invalid_input/);
  });

  it("allows action plus the supplied action fields", () => {
    expect(() => assertAllowed({ action: "inspect", workspaceId: "w1" }, ["workspaceId"])).not.toThrow();
  });

  it("requiredString rejects a non-string value", () => {
    expect(() => requiredString({ workspaceId: 1 }, "workspaceId", "id")).toThrow(/invalid_input/);
  });

  it("requiredString rejects a missing key", () => {
    expect(() => requiredString({}, "workspaceId", "id")).toThrow(/invalid_input/);
  });

  it("boolean returns the fallback when the key is absent", () => {
    expect(boolean({}, "focus", false)).toBe(false);
  });

  it("boolean rejects a non-boolean present value", () => {
    expect(() => boolean({ focus: "true" }, "focus", false)).toThrow(/invalid_input/);
  });

  it("envFlags returns an empty array when env is absent", () => {
    expect(envFlags({})).toEqual([]);
  });
});

describe("hosting context", () => {
  it("creates an explicitly placed no-focus tab without changing literal strings", () => {
    const op = compileTab({ action: "create", workspaceId: "w9", cwd: "/tmp/a b;$(x)", label: "--review\n'one'" });
    expect(op.argv).toEqual(["tab", "create", "--workspace", "w9", "--cwd", "/tmp/a b;$(x)", "--label", "--review\n'one'", "--no-focus"]);
  });

  it("renames a tab without inserting an unsupported separator", () => {
    expect(compileTab({ action: "rename", tabId: "w9:t7", label: "--review two" }).argv)
      .toEqual(["tab", "rename", "w9:t7", "--review two"]);
  });

  it.each([undefined, false, "true", 1])("rejects unconfirmed tab close %s", (confirm) => {
    expect(() => compileTab({ action: "close", tabId: "w9:t7", confirm })).toThrow(/invalid_input/);
  });

  it.each([undefined, false, "true", 1])("rejects unconfirmed workspace close %s", (confirm) => {
    expect(() => compileWorkspace({ action: "close", workspaceId: "w9", confirm })).toThrow(/invalid_input/);
  });

  it("requires the actual target and rejects irrelevant inputs", () => {
    expect(() => compileTab({ action: "close", confirm: true })).toThrow(/invalid_input/);
    expect(() => compileWorkspace({ action: "list", confirm: true })).toThrow(/invalid_input/);
  });
});

describe("compileWorkspace argv table", () => {
  const rows: Array<{ name: string; input: Input; expected: Omit<Operation, "group" | "action"> }> = [
    {
      name: "list",
      input: { action: "list" },
      expected: { argv: ["workspace", "list"], output: "json", mutation: false, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "inspect",
      input: { action: "inspect", workspaceId: "w1" },
      expected: { argv: ["workspace", "get", "w1"], output: "json", mutation: false, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "create (minimal)",
      input: { action: "create", cwd: "/tmp/proj" },
      expected: { argv: ["workspace", "create", "--cwd", "/tmp/proj", "--no-focus"], output: "json", mutation: true, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "create (label + repeated env)",
      input: {
        action: "create",
        cwd: "/tmp/proj",
        label: "proj label",
        env: [
          { name: "FOO", value: "bar" },
          { name: "BAZ", value: "qux" },
        ],
      },
      expected: {
        argv: ["workspace", "create", "--cwd", "/tmp/proj", "--label", "proj label", "--env", "FOO=bar", "--env", "BAZ=qux", "--no-focus"],
        output: "json",
        mutation: true,
        deadlineMs: 30000,
        sensitive: ["bar", "qux"],
      },
    },
    {
      name: "focus",
      input: { action: "focus", workspaceId: "w1" },
      expected: { argv: ["workspace", "focus", "w1"], output: "json", mutation: true, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "close",
      input: { action: "close", workspaceId: "w1", confirm: true },
      expected: { argv: ["workspace", "close", "w1"], output: "json", mutation: true, deadlineMs: 30000, sensitive: [] },
    },
  ];

  it.each(rows)("$name", ({ input, expected }) => {
    const op = compileWorkspace(input);
    expect(op).toEqual({ group: "workspace", action: input.action, ...expected });
  });

  it("emits --focus for an explicit focus:true", () => {
    const op = compileWorkspace({ action: "create", cwd: "/tmp/proj", focus: true });
    expect(op.argv).toEqual(["workspace", "create", "--cwd", "/tmp/proj", "--focus"]);
  });
});

describe("compileTab argv table", () => {
  const rows: Array<{ name: string; input: Input; expected: Omit<Operation, "group" | "action"> }> = [
    {
      name: "list (no workspace filter)",
      input: { action: "list" },
      expected: { argv: ["tab", "list"], output: "json", mutation: false, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "list (workspace filter)",
      input: { action: "list", workspaceId: "w1" },
      expected: { argv: ["tab", "list", "--workspace", "w1"], output: "json", mutation: false, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "inspect",
      input: { action: "inspect", tabId: "w1:t1" },
      expected: { argv: ["tab", "get", "w1:t1"], output: "json", mutation: false, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "create (minimal)",
      input: { action: "create", workspaceId: "w1", cwd: "/tmp/proj" },
      expected: { argv: ["tab", "create", "--workspace", "w1", "--cwd", "/tmp/proj", "--no-focus"], output: "json", mutation: true, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "create (repeated env)",
      input: {
        action: "create",
        workspaceId: "w1",
        cwd: "/tmp/proj",
        env: [
          { name: "FOO", value: "bar" },
          { name: "BAZ", value: "qux" },
        ],
      },
      expected: {
        argv: ["tab", "create", "--workspace", "w1", "--cwd", "/tmp/proj", "--env", "FOO=bar", "--env", "BAZ=qux", "--no-focus"],
        output: "json",
        mutation: true,
        deadlineMs: 30000,
        sensitive: ["bar", "qux"],
      },
    },
    {
      name: "rename",
      input: { action: "rename", tabId: "w1:t1", label: "new label" },
      expected: { argv: ["tab", "rename", "w1:t1", "new label"], output: "json", mutation: true, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "focus",
      input: { action: "focus", tabId: "w1:t1" },
      expected: { argv: ["tab", "focus", "w1:t1"], output: "json", mutation: true, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "close",
      input: { action: "close", tabId: "w1:t1", confirm: true },
      expected: { argv: ["tab", "close", "w1:t1"], output: "json", mutation: true, deadlineMs: 30000, sensitive: [] },
    },
  ];

  it.each(rows)("$name", ({ input, expected }) => {
    const op = compileTab(input);
    expect(op).toEqual({ group: "tab", action: input.action, ...expected });
  });

  it("emits --focus for an explicit focus:true", () => {
    const op = compileTab({ action: "create", workspaceId: "w1", cwd: "/tmp/proj", focus: true });
    expect(op.argv).toEqual(["tab", "create", "--workspace", "w1", "--cwd", "/tmp/proj", "--focus"]);
  });
});

describe("workspace/tab validation edge cases", () => {
  it.each([
    ["workspace inspect id with NUL", () => compileWorkspace({ action: "inspect", workspaceId: "w\0x" })],
    ["workspace create cwd with NUL", () => compileWorkspace({ action: "create", cwd: "/tmp\0" })],
    ["tab rename label with NUL", () => compileTab({ action: "rename", tabId: "w1:t1", label: "la\0bel" })],
    [
      "tab create env value with NUL",
      () => compileTab({ action: "create", workspaceId: "w1", cwd: "/tmp", env: [{ name: "FOO", value: "b\0ar" }] }),
    ],
  ])("rejects NUL characters: %s", (_name, run) => {
    expect(run).toThrow(/invalid_input/);
  });

  it.each([
    ["workspace focus", () => compileWorkspace({ action: "focus", workspaceId: "" })],
    ["tab focus", () => compileTab({ action: "focus", tabId: "" })],
  ])("rejects an empty ID: %s", (_name, run) => {
    expect(run).toThrow(/invalid_input/);
  });

  it("rejects workspace/create without cwd", () => {
    expect(() => compileWorkspace({ action: "create" })).toThrow(/invalid_input/);
  });

  it("rejects tab/create without cwd", () => {
    expect(() => compileTab({ action: "create", workspaceId: "w1" })).toThrow(/invalid_input/);
  });

  it("rejects a duplicate env name", () => {
    expect(() =>
      compileWorkspace({
        action: "create",
        cwd: "/tmp",
        env: [
          { name: "FOO", value: "1" },
          { name: "FOO", value: "2" },
        ],
      }),
    ).toThrow(/invalid_input/);
  });

  it("rejects HERDR_SOCKET_PATH env injection", () => {
    expect(() =>
      compileTab({
        action: "create",
        workspaceId: "w1",
        cwd: "/tmp",
        env: [{ name: "HERDR_SOCKET_PATH", value: "/evil.sock" }],
      }),
    ).toThrow(/invalid_input/);
  });

  it("rejects an ID starting with a leading dash", () => {
    expect(() => compileWorkspace({ action: "focus", workspaceId: "-w1" })).toThrow(/invalid_input/);
  });

  it("rejects an ID containing whitespace", () => {
    expect(() => compileTab({ action: "focus", tabId: "w1 t1" })).toThrow(/invalid_input/);
  });
});

describe("WorkspaceSchema and TabSchema", () => {
  it("accepts every workspace action with no other fields", () => {
    for (const action of ["list", "inspect", "create", "focus", "close"]) {
      expect(Value.Check(WorkspaceSchema, { action })).toBe(true);
    }
  });

  it("accepts every tab action with no other fields", () => {
    for (const action of ["list", "inspect", "create", "rename", "focus", "close"]) {
      expect(Value.Check(TabSchema, { action })).toBe(true);
    }
  });

  it("rejects a workspace action outside the frozen enum", () => {
    expect(Value.Check(WorkspaceSchema, { action: "delete" })).toBe(false);
  });

  it("rejects a tab action outside the frozen enum", () => {
    expect(Value.Check(TabSchema, { action: "delete" })).toBe(false);
  });

  it("accepts a workspace schema instance carrying every optional field at once", () => {
    expect(
      Value.Check(WorkspaceSchema, {
        action: "create",
        workspaceId: "w1",
        cwd: "/tmp",
        label: "label",
        env: [{ name: "FOO", value: "bar" }],
        focus: true,
        confirm: true,
      }),
    ).toBe(true);
  });

  it("accepts a tab schema instance carrying every optional field at once", () => {
    expect(
      Value.Check(TabSchema, {
        action: "create",
        workspaceId: "w1",
        tabId: "w1:t1",
        cwd: "/tmp",
        label: "label",
        env: [{ name: "FOO", value: "bar" }],
        focus: true,
        confirm: true,
      }),
    ).toBe(true);
  });
});

describe("shared timeout()", () => {
  it("defaults to 30000 when timeoutMs is absent", () => {
    expect(timeout({})).toBe(30000);
  });

  it.each([1, 300000])("accepts the ordinary boundary %s", (timeoutMs) => {
    expect(timeout({ timeoutMs })).toBe(timeoutMs);
  });

  it.each([0, -1, NaN, Infinity, 1.5, 300001, "30000", null])("rejects ordinary timeout %s", (timeoutMs) => {
    expect(() => timeout({ timeoutMs })).toThrow(/invalid_input/);
  });

  it.each([3001, 300000])("accepts the startup boundary %s", (timeoutMs) => {
    expect(timeout({ timeoutMs }, 3001)).toBe(timeoutMs);
  });

  it.each([1, 2999, 3000])("rejects a startup timeout %s below the floor", (timeoutMs) => {
    expect(() => timeout({ timeoutMs }, 3001)).toThrow(/invalid_input/);
  });

  it("rejects a startup timeout above the maximum", () => {
    expect(() => timeout({ timeoutMs: 300001 }, 3001)).toThrow(/invalid_input/);
  });
});

describe("shared readFlags()", () => {
  it("defaults to visible source and text format", () => {
    expect(readFlags({})).toEqual(["--source", "visible", "--format", "text"]);
  });

  it("includes --lines only when supplied", () => {
    expect(readFlags({ lines: 500 })).toEqual(["--source", "visible", "--lines", "500", "--format", "text"]);
  });

  it("forwards an explicit source and format", () => {
    expect(readFlags({ source: "recent-unwrapped", format: "ansi" })).toEqual(["--source", "recent-unwrapped", "--format", "ansi"]);
  });

  it("accepts the detection source", () => {
    expect(readFlags({ source: "detection" })).toEqual(["--source", "detection", "--format", "text"]);
  });

  it("rejects an unsupported source", () => {
    expect(() => readFlags({ source: "everything" })).toThrow(/invalid_input/);
  });

  it("accepts the lines ceiling", () => {
    expect(readFlags({ lines: 1000000 })).toEqual(["--source", "visible", "--lines", "1000000", "--format", "text"]);
  });

  it.each([0, -1, 1.5, 1000001, "500"])("rejects an invalid lines value %s", (lines) => {
    expect(() => readFlags({ lines })).toThrow(/invalid_input/);
  });

  it("rejects an unsupported format", () => {
    expect(() => readFlags({ format: "json" })).toThrow(/invalid_input/);
  });
});

describe("compilePane argv table", () => {
  const rows: Array<{ name: string; input: Input; expected: Omit<Operation, "group" | "action"> }> = [
    {
      name: "list (no workspace filter)",
      input: { action: "list" },
      expected: { argv: ["pane", "list"], output: "json", mutation: false, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "list (workspace filter)",
      input: { action: "list", workspaceId: "w1" },
      expected: { argv: ["pane", "list", "--workspace", "w1"], output: "json", mutation: false, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "inspect",
      input: { action: "inspect", paneId: "w9:p7" },
      expected: { argv: ["pane", "get", "w9:p7"], output: "json", mutation: false, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "split (minimal)",
      input: { action: "split", paneId: "w9:p7", cwd: "/tmp/proj", direction: "right" },
      expected: {
        argv: ["pane", "split", "--pane", "w9:p7", "--direction", "right", "--cwd", "/tmp/proj", "--no-focus"],
        output: "json",
        mutation: true,
        deadlineMs: 30000,
        sensitive: [],
      },
    },
    {
      name: "split (ratio, env, focus)",
      input: {
        action: "split",
        paneId: "w9:p7",
        cwd: "/tmp/proj",
        direction: "down",
        ratio: 0.25,
        env: [{ name: "FOO", value: "bar" }],
        focus: true,
      },
      expected: {
        argv: ["pane", "split", "--pane", "w9:p7", "--direction", "down", "--ratio", "0.25", "--cwd", "/tmp/proj", "--env", "FOO=bar", "--focus"],
        output: "json",
        mutation: true,
        deadlineMs: 30000,
        sensitive: ["bar"],
      },
    },
    {
      name: "run",
      input: { action: "run", paneId: "w9:p7", command: "echo hi" },
      expected: { argv: ["pane", "run", "w9:p7", "echo hi"], output: "json", mutation: true, deadlineMs: 30000, sensitive: ["echo hi"] },
    },
    {
      name: "send-text",
      input: { action: "send-text", paneId: "w9:p7", text: "hello" },
      expected: { argv: ["pane", "send-text", "w9:p7", "hello"], output: "json", mutation: true, deadlineMs: 30000, sensitive: ["hello"] },
    },
    {
      name: "send-keys",
      input: { action: "send-keys", paneId: "w9:p7", keys: ["Enter", "ctrl+c"] },
      expected: { argv: ["pane", "send-keys", "w9:p7", "Enter", "ctrl+c"], output: "json", mutation: true, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "read (defaults)",
      input: { action: "read", paneId: "w9:p7" },
      expected: { argv: ["pane", "read", "w9:p7", "--source", "visible", "--format", "text"], output: "text", mutation: false, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "read (lines, ansi)",
      input: { action: "read", paneId: "w9:p7", lines: 200, format: "ansi" },
      expected: {
        argv: ["pane", "read", "w9:p7", "--source", "visible", "--lines", "200", "--format", "ansi"],
        output: "text",
        mutation: false,
        deadlineMs: 30000,
        sensitive: [],
      },
    },
    {
      name: "wait-output (match)",
      input: { action: "wait-output", paneId: "w9:p7", match: "ready" },
      expected: {
        argv: ["pane", "wait-output", "w9:p7", "--match", "ready", "--source", "visible", "--timeout", "30000"],
        output: "json",
        mutation: false,
        deadlineMs: 31000,
        sensitive: [],
      },
    },
    {
      name: "wait-output (regex, raw, custom source/lines/timeout)",
      input: { action: "wait-output", paneId: "w9:p7", regex: "^ready", source: "recent", lines: 10, timeoutMs: 5000, raw: true },
      expected: {
        argv: ["pane", "wait-output", "w9:p7", "--regex", "^ready", "--source", "recent", "--lines", "10", "--timeout", "5000", "--raw"],
        output: "json",
        mutation: false,
        deadlineMs: 6000,
        sensitive: [],
      },
    },
    {
      name: "focus-neighbor",
      input: { action: "focus-neighbor", paneId: "w9:p7", direction: "right" },
      expected: { argv: ["pane", "focus", "--pane", "w9:p7", "--direction", "right"], output: "json", mutation: true, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "close",
      input: { action: "close", paneId: "w9:p7", confirm: true },
      expected: { argv: ["pane", "close", "w9:p7"], output: "json", mutation: true, deadlineMs: 30000, sensitive: [] },
    },
  ];

  it.each(rows)("$name", ({ input, expected }) => {
    const op = compilePane(input);
    expect(op).toEqual({ group: "pane", action: input.action, ...expected });
  });
});

describe("compilePane validation edge cases", () => {
  it("rejects wait-output with neither match nor regex", () => {
    expect(() => compilePane({ action: "wait-output", paneId: "w9:p7" })).toThrow(/invalid_input/);
  });

  it("rejects wait-output with both match and regex", () => {
    expect(() => compilePane({ action: "wait-output", paneId: "w9:p7", match: "a", regex: "b" })).toThrow(/invalid_input/);
  });

  it("rejects wait-output source=detection", () => {
    expect(() => compilePane({ action: "wait-output", paneId: "w9:p7", match: "a", source: "detection" })).toThrow(/invalid_input/);
  });

  it("rejects an empty keys array", () => {
    expect(() => compilePane({ action: "send-keys", paneId: "w9:p7", keys: [] })).toThrow(/invalid_input/);
  });

  it("rejects an empty item inside keys", () => {
    expect(() => compilePane({ action: "send-keys", paneId: "w9:p7", keys: ["Enter", ""] })).toThrow(/invalid_input/);
  });

  it("rejects split direction=left", () => {
    expect(() => compilePane({ action: "split", paneId: "w9:p7", cwd: "/tmp", direction: "left" })).toThrow(/invalid_input/);
  });

  it.each([0, 1, NaN, Infinity, -Infinity])("rejects a ratio endpoint or non-finite value %s", (ratio) => {
    expect(() => compilePane({ action: "split", paneId: "w9:p7", cwd: "/tmp", direction: "right", ratio })).toThrow(/invalid_input/);
  });

  it("accepts a ratio strictly between 0 and 1", () => {
    expect(compilePane({ action: "split", paneId: "w9:p7", cwd: "/tmp", direction: "right", ratio: 0.5 }).argv).toContain("--ratio");
  });

  it("rejects pane close without confirm", () => {
    expect(() => compilePane({ action: "close", paneId: "w9:p7" })).toThrow(/invalid_input/);
  });

  it.each([1, 300000])("accepts an ordinary wait-output timeout boundary %s", (timeoutMs) => {
    expect(compilePane({ action: "wait-output", paneId: "w9:p7", match: "a", timeoutMs }).argv).toContain(String(timeoutMs));
  });

  it.each([0, -1, NaN, Infinity, 1.5, 300001, "30000"])("rejects a wait-output timeout %s", (timeoutMs) => {
    expect(() => compilePane({ action: "wait-output", paneId: "w9:p7", match: "a", timeoutMs })).toThrow(/invalid_input/);
  });
});

describe("compileAgent argv table", () => {
  const rows: Array<{ name: string; input: Input; expected: Omit<Operation, "group" | "action"> }> = [
    {
      name: "list",
      input: { action: "list" },
      expected: { argv: ["agent", "list"], output: "json", mutation: false, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "inspect",
      input: { action: "inspect", target: "reviewer" },
      expected: { argv: ["agent", "get", "reviewer"], output: "json", mutation: false, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "start (minimal)",
      input: { action: "start", name: "reviewer", kind: "pi", paneId: "w9:p7" },
      expected: {
        argv: ["agent", "start", "reviewer", "--kind", "pi", "--pane", "w9:p7", "--timeout", "30000"],
        output: "json",
        mutation: true,
        deadlineMs: 31000,
        sensitive: [],
      },
    },
    {
      name: "rename (name)",
      input: { action: "rename", target: "reviewer", name: "critic" },
      expected: { argv: ["agent", "rename", "reviewer", "critic"], output: "json", mutation: true, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "rename (clear)",
      input: { action: "rename", target: "reviewer", clear: true },
      expected: { argv: ["agent", "rename", "reviewer", "--clear"], output: "json", mutation: true, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "prompt (no wait)",
      input: { action: "prompt", target: "reviewer", text: "hello" },
      expected: { argv: ["agent", "prompt", "reviewer", "hello"], output: "json", mutation: true, deadlineMs: 30000, sensitive: ["hello"] },
    },
    {
      name: "prompt (wait, until repeated)",
      input: { action: "prompt", target: "reviewer", text: "hello", wait: true, until: ["idle", "blocked"] },
      expected: {
        argv: ["agent", "prompt", "reviewer", "hello", "--wait", "--until", "idle", "--until", "blocked", "--timeout", "30000"],
        output: "json",
        mutation: true,
        deadlineMs: 31000,
        sensitive: ["hello"],
      },
    },
    {
      name: "send-keys",
      input: { action: "send-keys", target: "reviewer", keys: ["Enter"] },
      expected: { argv: ["agent", "send-keys", "reviewer", "Enter"], output: "json", mutation: true, deadlineMs: 30000, sensitive: [] },
    },
    {
      name: "read (defaults)",
      input: { action: "read", target: "reviewer" },
      expected: {
        argv: ["agent", "read", "reviewer", "--source", "visible", "--format", "text"],
        output: "text",
        mutation: false,
        deadlineMs: 30000,
        sensitive: [],
      },
    },
    {
      name: "wait (no until)",
      input: { action: "wait", target: "reviewer" },
      expected: { argv: ["agent", "wait", "reviewer", "--timeout", "30000"], output: "json", mutation: false, deadlineMs: 31000, sensitive: [] },
    },
    {
      name: "wait (all five lifecycle states, in order)",
      input: { action: "wait", target: "reviewer", until: ["idle", "working", "blocked", "done", "unknown"] },
      expected: {
        argv: [
          "agent", "wait", "reviewer",
          "--until", "idle", "--until", "working", "--until", "blocked", "--until", "done", "--until", "unknown",
          "--timeout", "30000",
        ],
        output: "json",
        mutation: false,
        deadlineMs: 31000,
        sensitive: [],
      },
    },
    {
      name: "focus",
      input: { action: "focus", target: "reviewer" },
      expected: { argv: ["agent", "focus", "reviewer"], output: "json", mutation: true, deadlineMs: 30000, sensitive: [] },
    },
  ];

  it.each(rows)("$name", ({ input, expected }) => {
    const op = compileAgent(input);
    expect(op).toEqual({ group: "agent", action: input.action, ...expected });
  });

  it("preserves empty items, spaces, quotes, and newlines in start args", () => {
    const args = ["--model", "provider/model", "--append-system-prompt", "a 'b'\n$(c)", ""];
    const op = compileAgent({ action: "start", name: "reviewer", kind: "pi", paneId: "w9:p7", args });
    expect(op.argv).toEqual(["agent", "start", "reviewer", "--kind", "pi", "--pane", "w9:p7", "--timeout", "30000", "--", ...args]);
    expect(op.sensitive).toEqual(args);
  });
});

describe("compileAgent validation edge cases", () => {
  it("rejects an invalid agent kind", () => {
    expect(() => compileAgent({ action: "start", name: "reviewer", kind: "bogus", paneId: "w9:p7" })).toThrow(/invalid_input/);
  });

  it("rejects an invalid agent name pattern", () => {
    expect(() => compileAgent({ action: "start", name: "Reviewer!", kind: "pi", paneId: "w9:p7" })).toThrow(/invalid_input/);
  });

  it.each([1, 2999, 3000])("rejects a startup timeoutMs %s below the floor", (timeoutMs) => {
    expect(() => compileAgent({ action: "start", name: "reviewer", kind: "pi", paneId: "w9:p7", timeoutMs })).toThrow(/invalid_input/);
  });

  it.each([3001, 300000])("accepts a startup timeoutMs %s at or above the floor", (timeoutMs) => {
    expect(compileAgent({ action: "start", name: "reviewer", kind: "pi", paneId: "w9:p7", timeoutMs }).argv).toContain(String(timeoutMs));
  });

  it("rejects rename with neither name nor clear", () => {
    expect(() => compileAgent({ action: "rename", target: "reviewer" })).toThrow(/invalid_input/);
  });

  it("rejects rename with both name and clear", () => {
    expect(() => compileAgent({ action: "rename", target: "reviewer", name: "critic", clear: true })).toThrow(/invalid_input/);
  });

  it.each([false, null, "true", 1])("rejects rename clear=%s", (clear) => {
    expect(() => compileAgent({ action: "rename", target: "reviewer", clear })).toThrow(/invalid_input/);
  });

  it("rejects prompt until without wait", () => {
    expect(() => compileAgent({ action: "prompt", target: "reviewer", text: "hi", until: ["idle"] })).toThrow(/invalid_input/);
  });

  it("rejects prompt timeoutMs without wait", () => {
    expect(() => compileAgent({ action: "prompt", target: "reviewer", text: "hi", timeoutMs: 5000 })).toThrow(/invalid_input/);
  });

  it("rejects a duplicate until state", () => {
    expect(() => compileAgent({ action: "wait", target: "reviewer", until: ["idle", "idle"] })).toThrow(/invalid_input/);
  });

  it("rejects an empty until array", () => {
    expect(() => compileAgent({ action: "wait", target: "reviewer", until: [] })).toThrow(/invalid_input/);
  });

  it("rejects an unknown until state", () => {
    expect(() => compileAgent({ action: "wait", target: "reviewer", until: ["stuck"] })).toThrow(/invalid_input/);
  });

  it.each([1, 300000])("accepts an ordinary agent wait timeoutMs boundary %s", (timeoutMs) => {
    expect(compileAgent({ action: "wait", target: "reviewer", timeoutMs }).argv).toContain(String(timeoutMs));
  });

  it("rejects an empty send-keys array on an agent", () => {
    expect(() => compileAgent({ action: "send-keys", target: "reviewer", keys: [] })).toThrow(/invalid_input/);
  });
});

describe("pane/agent unknown or inapplicable fields", () => {
  it("rejects an unknown field on a pane action", () => {
    expect(() => compilePane({ action: "list", bogus: true })).toThrow(/invalid_input/);
  });

  it("rejects a field that does not apply to the given pane action", () => {
    expect(() => compilePane({ action: "read", paneId: "w9:p7", direction: "right" })).toThrow(/invalid_input/);
  });

  it("rejects an unknown field on an agent action", () => {
    expect(() => compileAgent({ action: "list", bogus: true })).toThrow(/invalid_input/);
  });

  it("rejects a field that does not apply to the given agent action", () => {
    expect(() => compileAgent({ action: "focus", target: "reviewer", kind: "pi" })).toThrow(/invalid_input/);
  });
});

describe("brief critical examples", () => {
  it("preserves native arguments only after agent-start separator", () => {
    const args = ["--model", "provider/model", "--append-system-prompt", "a 'b'\n$(c)", ""];
    expect(compileAgent({ action: "start", name: "reviewer", kind: "pi", paneId: "w9:p7", args }).argv)
      .toEqual(["agent", "start", "reviewer", "--kind", "pi", "--pane", "w9:p7", "--timeout", "30000", "--", ...args]);
  });
  it("puts prompt operands before wait options", () => {
    const op = compileAgent({ action: "prompt", target: "reviewer", text: "--help", wait: true });
    expect(op.argv).toEqual(["agent", "prompt", "reviewer", "--help", "--wait", "--timeout", "30000"]);
    expect(op.deadlineMs).toBe(31000);
  });
  it("uses visible reads and bounded output waits", () => {
    expect(compilePane({ action: "read", paneId: "w9:p7" }).argv)
      .toEqual(["pane", "read", "w9:p7", "--source", "visible", "--format", "text"]);
    expect(compilePane({ action: "wait-output", paneId: "w9:p7", match: "--ready" }).argv)
      .toEqual(["pane", "wait-output", "w9:p7", "--match", "--ready", "--source", "visible", "--timeout", "30000"]);
  });
  it.each([0, -1, NaN, Infinity, 1.5, 300001, "30000"])("rejects timeout %s", timeoutMs => {
    expect(() => compileAgent({ action: "wait", target: "reviewer", timeoutMs })).toThrow(/invalid_input/);
  });
  it("does not silently choose the focused source pane", () => {
    expect(() => compilePane({ action: "focus-neighbor", direction: "right" })).toThrow(/invalid_input/);
    expect(compilePane({ action: "focus-neighbor", paneId: "w9:p7", direction: "right" }).argv)
      .toEqual(["pane", "focus", "--pane", "w9:p7", "--direction", "right"]);
  });
});

describe("PaneSchema and AgentSchema", () => {
  it("accepts every pane action with no other fields", () => {
    for (const action of ["list", "inspect", "split", "run", "send-text", "send-keys", "read", "wait-output", "focus-neighbor", "close"]) {
      expect(Value.Check(PaneSchema, { action })).toBe(true);
    }
  });

  it("accepts every agent action with no other fields", () => {
    for (const action of ["list", "inspect", "start", "rename", "prompt", "send-keys", "read", "wait", "focus"]) {
      expect(Value.Check(AgentSchema, { action })).toBe(true);
    }
  });

  it("rejects a pane action outside the frozen enum", () => {
    expect(Value.Check(PaneSchema, { action: "delete" })).toBe(false);
  });

  it("rejects an agent action outside the frozen enum", () => {
    expect(Value.Check(AgentSchema, { action: "delete" })).toBe(false);
  });

  it("accepts a pane schema instance carrying every optional field at once", () => {
    expect(
      Value.Check(PaneSchema, {
        action: "split",
        workspaceId: "w1",
        paneId: "w1:p1",
        cwd: "/tmp",
        direction: "right",
        ratio: 0.5,
        env: [{ name: "FOO", value: "bar" }],
        focus: true,
        confirm: true,
        command: "echo hi",
        text: "hello",
        keys: ["Enter"],
        source: "recent",
        lines: 10,
        format: "ansi",
        match: "a",
        regex: "b",
        raw: true,
        timeoutMs: 5000,
      }),
    ).toBe(true);
  });

  it("accepts an agent schema instance carrying every optional field at once", () => {
    expect(
      Value.Check(AgentSchema, {
        action: "start",
        target: "reviewer",
        name: "reviewer",
        clear: true,
        kind: "pi",
        paneId: "w1:p1",
        args: ["--flag"],
        wait: true,
        until: ["idle", "done"],
        timeoutMs: 5000,
        text: "hello",
        keys: ["Enter"],
        source: "recent",
        lines: 10,
        format: "ansi",
      }),
    ).toBe(true);
  });
});

describe("compile() dispatcher", () => {
  it("dispatches a workspace action to compileWorkspace", () => {
    expect(compile("workspace", { action: "list" })).toEqual({
      group: "workspace", action: "list", argv: ["workspace", "list"], output: "json", mutation: false, deadlineMs: 30000, sensitive: [],
    });
  });

  it("dispatches a tab action to compileTab", () => {
    expect(compile("tab", { action: "list" })).toEqual({
      group: "tab", action: "list", argv: ["tab", "list"], output: "json", mutation: false, deadlineMs: 30000, sensitive: [],
    });
  });

  it("dispatches a pane action to compilePane", () => {
    expect(compile("pane", { action: "list" })).toEqual({
      group: "pane", action: "list", argv: ["pane", "list"], output: "json", mutation: false, deadlineMs: 30000, sensitive: [],
    });
  });

  it("dispatches an agent action to compileAgent", () => {
    expect(compile("agent", { action: "list" })).toEqual({
      group: "agent", action: "list", argv: ["agent", "list"], output: "json", mutation: false, deadlineMs: 30000, sensitive: [],
    });
  });

  it("rejects an unknown group", () => {
    expect(() => compile("bogus" as never, { action: "list" })).toThrow(/invalid_input/);
  });
});
