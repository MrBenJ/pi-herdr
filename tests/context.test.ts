import { describe, expect, it } from "vitest";
import { resolveHost } from "../src/context.ts";

describe("hosting context", () => {
  it("requires the hosting socket rather than a default session", () => {
    expect(() => resolveHost({ HERDR_ENV: "1" })).toThrow(/missing_host/);
    expect(() => resolveHost({ HERDR_SOCKET_PATH: "/tmp/host.sock" })).toThrow(/missing_host/);
    expect(() => resolveHost({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "relative.sock" })).toThrow(/missing_host/);
  });

  it("rejects a socket path containing NUL", () => {
    expect(() => resolveHost({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/ho\0st.sock" })).toThrow(/missing_host/);
  });

  it("preserves the socket and removes named-session selection", () => {
    const input = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/host.sock", HERDR_SESSION: "other" };
    const host = resolveHost(input);
    expect(host.executable).toBe("herdr");
    expect(host.env.HERDR_SOCKET_PATH).toBe(input.HERDR_SOCKET_PATH);
    expect(host.env.HERDR_SESSION).toBeUndefined();
    expect(input.HERDR_SESSION).toBe("other");
  });
});
