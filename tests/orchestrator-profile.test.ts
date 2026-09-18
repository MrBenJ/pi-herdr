import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildProfileCommand, isPiProfileName, MAX_PROFILE_COMMAND_BYTES, shellWord } from "../src/orchestrator/profile.ts";

const exec = promisify(execFile);

const HOSTILE_ARGS = [
  "plain",
  "",
  "two words",
  "it's",
  "'; touch /tmp/pi-herdr-injected; '",
  'double "quoted"',
  "$HOME $(id) `id` ${PATH}",
  "--leading-dash",
  "-",
  "--",
  "a;b|c&d>e<f(g)h{i}j*k?l[m]n~o!p#q",
  "back\\slash \\' \\\\",
  "KEY=value",
  "unicode ✓ ü",
];
const CONTROL_ARGS = ["line one\nline two", "tab\there", "return\rhere", "escape\u001b[31m", "interrupt\u0003\u0004", "delete\u007f", "c1\u009b"];

async function roundTrip(shell: string, args: string[]): Promise<string[]> {
  const script = `printf '%s\\0' ${args.map(shellWord).join(" ")}`;
  const { stdout } = await exec(shell, ["-c", script], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  return stdout.split("\0").slice(0, -1);
}

it("accepts only narrow logical profile names", () => {
  for (const name of ["work", "client-a", "dj-league", "0", "a".repeat(64)]) expect(isPiProfileName(name)).toBe(true);
  for (const name of ["", "-work", "Work", "a".repeat(65), "two words", " work", "work\n", "../work", "a/b", "a\\b", ".", "~", "work;id", "$(id)", "`id`", "A=b", "a=b", "work.env", "wörk", "work\0"]) {
    expect(isPiProfileName(name)).toBe(false);
  }
  expect(isPiProfileName(7)).toBe(false);
  expect(isPiProfileName(undefined)).toBe(false);
});

it("builds a fixed pi-profile command with the profile first and native arguments after it", () => {
  expect(buildProfileCommand("work", [])).toBe(" command pi-profile work");
  expect(buildProfileCommand("client-a", ["--model", "x y", "", "-p"])).toBe(" command pi-profile client-a '--model' 'x y' '' '-p'");
});

it("refuses to build a command for an unsafe profile name", () => {
  expect(() => buildProfileCommand("work; id", [])).toThrow();
  expect(() => buildProfileCommand("../work", [])).toThrow();
});

it("never places a raw control character on the command line", () => {
  const command = buildProfileCommand("work", [...HOSTILE_ARGS, ...CONTROL_ARGS]);
  expect(command).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
});

it("refuses NUL and oversized commands", () => {
  expect(() => shellWord("a\0b")).toThrow();
  expect(() => buildProfileCommand("work", ["x".repeat(MAX_PROFILE_COMMAND_BYTES)])).toThrow();
});

describe.each(["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash"])("%s", (shell) => {
  it.skipIf(!fs.existsSync(shell))("passes hostile printable arguments through literally", async () => {
    expect(await roundTrip(shell, HOSTILE_ARGS)).toEqual(HOSTILE_ARGS);
  });
});

describe.each(["/bin/bash", "/bin/zsh"])("%s", (shell) => {
  it.skipIf(!fs.existsSync(shell))("passes control-character arguments through literally", async () => {
    expect(await roundTrip(shell, CONTROL_ARGS)).toEqual(CONTROL_ARGS);
  });
});
