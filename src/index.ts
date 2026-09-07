import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WorkspaceSchema } from "./actions/workspace.ts";
import { TabSchema } from "./actions/tab.ts";
import { PaneSchema } from "./actions/pane.ts";
import { AgentSchema } from "./actions/agent.ts";
import { execute } from "./execute.ts";
import { createRunner } from "./transport/runner.ts";

const outputPolicy = " Targets only the hosting Herdr server, with no fallback or automatic retry. Output is bounded to 2000 lines/51200 bytes; truncated output has private artifact paths. Cancellation stops the local CLI, not the remote agent.";

export default function extension(pi: ExtensionAPI): void {
  const runner = createRunner();
  const tools = [
    {
      group: "workspace", schema: WorkspaceSchema, label: "Herdr workspace",
      snippet: "Inspect, create, focus and close Herdr workspaces",
      description: "List/inspect workspaces or create/focus/close an explicit workspace. Creation requires cwd and defaults to no focus. Close requires workspaceId and confirm:true; confirmation is trusted caller opt-in, not independent human authorization.",
      guidelines: ["Use herdr_workspace with actual returned IDs, never predicted IDs.", "herdr_workspace close requires an explicitly authorized target and confirm:true; creation defaults to no focus."],
    },
    {
      group: "tab", schema: TabSchema, label: "Herdr tab",
      snippet: "Manage explicit Herdr tabs, normally one new tab per worker",
      description: "List/inspect/create/rename/focus/close tabs. Create requires workspaceId and cwd, defaults to no focus, and returns the tab/root-pane handles for a later worker start. Close requires tabId and confirm:true, a trusted caller assertion rather than a human approval gate.",
      guidelines: ["Prefer herdr_tab create for a new no-focus tab per worker; use its actual root-pane ID for herdr_agent start.", "herdr_tab close requires an explicitly authorized tabId and confirm:true."],
    },
    {
      group: "pane", schema: PaneSchema, label: "Herdr pane",
      snippet: "Read and control explicitly targeted Herdr panes",
      description: "List/inspect/split/run/send-text/send-keys/read/wait-output/focus-neighbor/close panes. Split requires source paneId, cwd and direction, defaults to no focus. run intentionally executes shell syntax in the remote terminal; it is not remote argv-safe execution. Reads and output waits default to visible. Waits default to 30000 ms (1–300000 ms). Close requires paneId and confirm:true.",
      guidelines: ["herdr_pane run executes remote shell syntax; authorize the command and explicit paneId first.", "herdr_pane read defaults to visible; request recent history explicitly and do not infer task completion from a snapshot.", "herdr_pane close requires an explicitly authorized paneId and confirm:true."],
    },
    {
      group: "agent", schema: AgentSchema, label: "Herdr agent",
      snippet: "Start named workers in existing panes, prompt and inspect their state",
      description: "List/inspect/start/rename/prompt/send-keys/read/wait/focus agents. Start requires name, kind and an existing paneId at an interactive shell; it does not create layout. Startup defaults to 30000 ms (3001–300000 ms); ordinary waits accept 1–300000 ms. Reads default to visible. Native args are forwarded literally. Blocked/idle/done states are observations, not task approval or completion proof; never automatically answer an approval dialog.",
      guidelines: ["Use herdr_agent start only in an explicitly selected ready shell pane, with an explicit unique name.", "herdr_agent blocked states require attention; do not automatically send approval keys or retry ambiguous mutations.", "herdr_agent read defaults to visible, and waits do not prove task completion."],
    },
  ] as const;
  for (const tool of tools) {
    pi.registerTool({
      name: `herdr_${tool.group}`, label: tool.label,
      description: tool.description + outputPolicy,
      promptSnippet: tool.snippet, promptGuidelines: [...tool.guidelines],
      parameters: tool.schema,
      execute: (_id, input, signal, _update, ctx) => execute(tool.group, input, {
        cwd: ctx.cwd, env: process.env, signal,
      }, runner.run),
    });
  }
  pi.on("session_shutdown", async () => { await runner.dispose(); });
}
