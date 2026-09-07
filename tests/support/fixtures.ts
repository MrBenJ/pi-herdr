// Synthetic protocol-20 objects: no live workspace data.
export const workspace = { workspace_id: "w91", number: 91, label: "fixture", focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w91:t27", agent_status: "idle" };
export const tab = { tab_id: "w91:t27", workspace_id: "w91", number: 27, label: "fixture", focused: false, pane_count: 1, agent_status: "idle" };
export const pane = { pane_id: "w91:p63", terminal_id: "fixture-terminal", workspace_id: "w91", tab_id: "w91:t27", focused: false, agent_status: "idle", revision: 1 };
export const agent = { ...pane, name: "reviewer", agent: "pi", interactive_ready: true };
export const createdTab = { id: "cli:tab:create", result: { type: "tab_created", tab, root_pane: pane } };
export const createdWorkspace = { id: "cli:workspace:create", result: { type: "workspace_created", workspace, tab, root_pane: pane } };
export const createdPane = { id: "cli:pane:split", result: { type: "pane_split", pane } };
export const startedAgent = { id: "cli:agent:start", result: { type: "agent_started", agent, argv: ["pi", "--api-key", "fixture-secret"] } };
export const blockedError = { id: "cli:agent:prompt", error: { code: "agent_blocked", message: "Agent is blocked" } };
