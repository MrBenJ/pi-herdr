import type { Group, Input, Operation } from "../contracts.ts";
import { HerdrToolError } from "../errors.ts";
import { compileAgent } from "./agent.ts";
import { compilePane } from "./pane.ts";
import { compileTab } from "./tab.ts";
import { compileWorkspace } from "./workspace.ts";

export function compile(group: Group, input: Input): Operation {
  switch (group) {
    case "workspace":
      return compileWorkspace(input);
    case "tab":
      return compileTab(input);
    case "pane":
      return compilePane(input);
    case "agent":
      return compileAgent(input);
    default:
      throw new HerdrToolError({
        kind: "invalid_input",
        message: `Unsupported action group "${String(group)}".`,
        remoteOutcome: "not_attempted",
      });
  }
}
