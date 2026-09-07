import { expect, it } from "vitest";
import { compileAgent } from "../src/actions/agent.ts";
import { compilePane } from "../src/actions/pane.ts";

it.each(["text", "ansi"])("terminal reads select text normalization for format %s, not envelope parsing", (format) => {
  expect(compilePane({ action: "read", paneId: "w9:p7", format }).output).toBe("text");
  expect(compileAgent({ action: "read", target: "reviewer", format }).output).toBe("text");
});
it("output waits still select JSON normalization for their snapshot/state envelopes", () => {
  expect(compilePane({ action: "wait-output", paneId: "w9:p7", match: "ready" }).output).toBe("json");
  expect(compileAgent({ action: "wait", target: "reviewer" }).output).toBe("json");
});
