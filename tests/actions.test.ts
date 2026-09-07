import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import type { Input, Operation } from "../src/contracts.ts";
import { assertAllowed, boolean, envFlags, requiredString } from "../src/actions/shared.ts";
import { compileTab, TabSchema } from "../src/actions/tab.ts";
import { compileWorkspace, WorkspaceSchema } from "../src/actions/workspace.ts";

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
