import { expect, it } from "vitest";
import { HERDR_AGENT_KINDS } from "../src/contracts.ts";
import orchestrator from "../src/orchestrator/index.ts";
import { registrationHarness } from "./support/harness.ts";

it("exports the one frozen Herdr agent-kind list", () => {
  expect(HERDR_AGENT_KINDS).toContain("pi");
  expect(HERDR_AGENT_KINDS).toContain("claude");
  expect(new Set(HERDR_AGENT_KINDS).size).toBe(HERDR_AGENT_KINDS.length);
  expect(Object.isFrozen(HERDR_AGENT_KINDS)).toBe(true);
});

it("registers only the orchestration tool and its policy hooks", () => {
  const harness = registrationHarness({ allowedEvents: ["tool_call", "session_shutdown"] });
  orchestrator(harness.api);
  expect([...harness.tools.keys()]).toEqual(["herdr_task"]);
  expect(harness.handlers.get("tool_call")).toHaveLength(1);
  expect(harness.handlers.get("session_shutdown")).toHaveLength(1);
});
