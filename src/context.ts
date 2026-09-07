import { isAbsolute } from "node:path";
import type { HostContext } from "./contracts.ts";
import { HerdrToolError } from "./errors.ts";

export function resolveHost(env: NodeJS.ProcessEnv): HostContext {
  const path = env.HERDR_SOCKET_PATH;
  if (env.HERDR_ENV !== "1" || !path || path.includes("\0") || !isAbsolute(path)) {
    throw new HerdrToolError({
      kind: "missing_host",
      message: "Run pi inside its hosting Herdr pane; no alternate server was selected.",
      remoteOutcome: "not_attempted",
    });
  }
  const childEnv: NodeJS.ProcessEnv = { ...env, HERDR_SOCKET_PATH: path };
  delete childEnv.HERDR_SESSION;
  return { executable: "herdr", env: childEnv };
}
