import { once } from "node:events";
const [mode, ...args] = process.argv.slice(2);
if (mode === "echo") {
  process.stdout.write(JSON.stringify({ args, socket: process.env.HERDR_SOCKET_PATH, session: process.env.HERDR_SESSION ?? null }));
} else if (mode === "fail") {
  process.stderr.write(JSON.stringify({ id: "fixture", error: { code: "agent_blocked", message: "Agent is blocked" } }));
  process.exitCode = 1;
} else if (mode === "sleep" || mode === "ignore-term") {
  if (mode === "ignore-term") process.on("SIGTERM", () => {});
  process.stdout.write("ready\n");
  setInterval(() => {}, 1000);
} else if (mode === "large") {
  for (let i = 0; i < 4096; i++) {
    if (!process.stdout.write("x".repeat(4096) + "\n")) await once(process.stdout, "drain");
  }
} else if (mode === "over-budget") {
  for (let i = 0; i < 17000; i++) {
    if (!process.stdout.write("x".repeat(4096))) await once(process.stdout, "drain");
  }
} else {
  process.stderr.write("Unknown fixture mode");
  process.exitCode = 2;
}
