import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { compileAgent } from "../src/actions/agent.ts";
import { compilePane } from "../src/actions/pane.ts";
import { compileTab } from "../src/actions/tab.ts";
import { compileWorkspace } from "../src/actions/workspace.ts";
import { withFakeServer } from "./support/fake-server.ts";

const run = promisify(execFile);

function fakeEnv(socketPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath };
  delete env.HERDR_SESSION;
  return env;
}

async function probe(argv: string[], socketPath: string): Promise<void> {
  await run("herdr", argv, { env: fakeEnv(socketPath), timeout: 3000, maxBuffer: 65536 }).catch((error) => {
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("probe_only");
  });
}

describe.skipIf(process.env.HERDR_CLI_CONTRACT !== "1")("installed Herdr CLI contract", () => {
  beforeAll(async () => {
    const { stdout } = await run("herdr", ["--version"], { timeout: 3000 });
    expect(stdout.trim()).toBe("herdr 0.8.2");
  });

  it("0.8.2 receives a literal tab rename", async () => {
    await withFakeServer(async (socketPath, requests) => {
      const argv = compileTab({ action: "rename", tabId: "w9:t7", label: "--a 'b'\n$(c)" }).argv;
      await probe(argv, socketPath);
      expect(requests.find((q) => q.method === "tab.rename")?.params).toEqual({ tab_id: "w9:t7", label: "--a 'b'\n$(c)" });
    });
  });

  it("close actions send the exact opaque ID for each group", async () => {
    await withFakeServer(async (socketPath, requests) => {
      await probe(compileWorkspace({ action: "close", workspaceId: "w9", confirm: true }).argv, socketPath);
      await probe(compileTab({ action: "close", tabId: "w9:t7", confirm: true }).argv, socketPath);
      await probe(compilePane({ action: "close", paneId: "w9:p7", confirm: true }).argv, socketPath);
      expect(requests.find((q) => q.method === "workspace.close")?.params).toEqual({ workspace_id: "w9" });
      expect(requests.find((q) => q.method === "tab.close")?.params).toEqual({ tab_id: "w9:t7" });
      expect(requests.find((q) => q.method === "pane.close")?.params).toEqual({ pane_id: "w9:p7" });
    });
  });

  it("create actions forward literal cwd and env", async () => {
    await withFakeServer(async (socketPath, requests) => {
      const argv = compileTab({
        action: "create",
        workspaceId: "w9",
        cwd: "/tmp/a b;$(x)",
        env: [{ name: "FOO", value: "bar" }],
      }).argv;
      await probe(argv, socketPath);
      expect(requests.find((q) => q.method === "tab.create")?.params).toEqual({
        workspace_id: "w9",
        cwd: "/tmp/a b;$(x)",
        focus: false,
        env: { FOO: "bar" },
      });
    });
  });

  it("pane split sends the source pane, direction, ratio, and env", async () => {
    await withFakeServer(async (socketPath, requests) => {
      const argv = compilePane({
        action: "split",
        paneId: "w9:p7",
        cwd: "/tmp/proj",
        direction: "right",
        ratio: 0.25,
        env: [{ name: "FOO", value: "bar" }],
      }).argv;
      await probe(argv, socketPath);
      const params = requests.find((q) => q.method === "pane.split")?.params as Record<string, unknown>;
      expect(params).toMatchObject({
        target_pane_id: "w9:p7",
        direction: "right",
        ratio: 0.25,
        cwd: "/tmp/proj",
        focus: false,
        env: { FOO: "bar" },
      });
    });
  });

  it("pane focus-neighbor sends the source pane and direction", async () => {
    await withFakeServer(async (socketPath, requests) => {
      const argv = compilePane({ action: "focus-neighbor", paneId: "w9:p7", direction: "right" }).argv;
      await probe(argv, socketPath);
      expect(requests.find((q) => q.method === "pane.focus_direction")?.params).toEqual({ pane_id: "w9:p7", direction: "right" });
    });
  });

  it("pane read forwards all four supported sources literally", async () => {
    await withFakeServer(async (socketPath, requests) => {
      await probe(compilePane({ action: "read", paneId: "w9:p7", source: "visible" }).argv, socketPath);
      await probe(compilePane({ action: "read", paneId: "w9:p7", source: "recent" }).argv, socketPath);
      await probe(compilePane({ action: "read", paneId: "w9:p7", source: "recent-unwrapped" }).argv, socketPath);
      await probe(compilePane({ action: "read", paneId: "w9:p7", source: "detection" }).argv, socketPath);
      const reads = requests.filter((q) => q.method === "pane.read").map((q) => (q.params as Record<string, unknown>).source);
      expect(reads).toEqual(["visible", "recent", "recent_unwrapped", "detection"]);
    });
  });

  it("agent read translates recent-unwrapped through the native CLI", async () => {
    await withFakeServer(async (socketPath, requests) => {
      await probe(compileAgent({ action: "read", target: "reviewer", source: "recent-unwrapped" }).argv, socketPath);
      expect(requests.find(q => q.method === "agent.read")?.params).toMatchObject({ target: "reviewer", source: "recent_unwrapped" });
    });
  });

  it("pane wait-output sends match, source, lines, timeout, and raw", async () => {
    await withFakeServer(async (socketPath, requests) => {
      const argv = compilePane({
        action: "wait-output",
        paneId: "w9:p7",
        match: "ready",
        source: "recent",
        lines: 10,
        timeoutMs: 5000,
        raw: true,
      }).argv;
      await probe(argv, socketPath);
      const params = requests.find((q) => q.method === "pane.wait_for_output")?.params as Record<string, unknown>;
      expect(params).toMatchObject({ pane_id: "w9:p7", source: "recent", lines: 10, timeout_ms: 5000, strip_ansi: false });
      expect(params.match).toEqual({ type: "substring", value: "ready" });
    });
  });

  it("agent start performs an explicit preparatory pane lookup before launch", async () => {
    await withFakeServer(async (socketPath, requests) => {
      const argv = compileAgent({ action: "start", name: "reviewer", kind: "pi", paneId: "w9:p7" }).argv;
      await probe(argv, socketPath);
      const paneCheckIndex = requests.findIndex((q) => q.method === "pane.get");
      const startIndex = requests.findIndex((q) => q.method === "agent.start");
      expect(paneCheckIndex).toBeGreaterThanOrEqual(0);
      expect(requests[paneCheckIndex]?.params).toEqual({ pane_id: "w9:p7" });
      expect(startIndex).toBeGreaterThan(paneCheckIndex);
    });
  });

  it("agent prompt with wait sends repeated until states and a timeout", async () => {
    await withFakeServer(async (socketPath, requests) => {
      const argv = compileAgent({ action: "prompt", target: "reviewer", text: "hello", wait: true, until: ["idle", "blocked"] }).argv;
      await probe(argv, socketPath);
      expect(requests.find((q) => q.method === "agent.prompt")?.params).toEqual({
        target: "reviewer",
        text: "hello",
        wait: { until: ["idle", "blocked"], timeout_ms: 30000 },
      });
    });
  });

  it("agent wait sends repeated until states and a timeout", async () => {
    await withFakeServer(async (socketPath, requests) => {
      const argv = compileAgent({ action: "wait", target: "reviewer", until: ["idle", "done"] }).argv;
      await probe(argv, socketPath);
      expect(requests.find((q) => q.method === "agent.wait")?.params).toEqual({
        target: "reviewer",
        until: ["idle", "done"],
        timeout_ms: 30000,
      });
    });
  });
});
