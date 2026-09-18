import path from "node:path";

export const PI_PROFILE_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";
export const MAX_PROFILE_COMMAND_BYTES = 16 * 1024;

const PROFILE_NAME = new RegExp(PI_PROFILE_PATTERN);
// pi-profile's own grammar is narrower than the published pattern: hyphens only
// between alphanumeric runs, no Windows device names, and no management command
// names, which the launcher would otherwise run instead of a profile.
const PROFILE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const RESERVED = new Set(["create", "list", "show", "rename", "remove", "import", "config", "recover", "help", "version"]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function isPiProfileName(value: unknown): value is string {
  return typeof value === "string" && PROFILE_NAME.test(value) && PROFILE_SLUG.test(value) && !DEVICE.test(value) && !RESERVED.has(value);
}

// The command is typed into an interactive shell, where the line editor acts on
// raw control bytes before the parser sees any quoting. Printable arguments use
// POSIX single quotes; anything with a control character uses $'...' with every
// control byte written as an octal escape, so none reaches the terminal raw.
export function shellWord(argument: string): string {
  if (argument.includes("\0")) throw new Error("Native arguments must not contain NUL characters.");
  if (!CONTROL.test(argument)) return `'${argument.replaceAll("'", "'\\''")}'`;
  let word = "$'";
  for (const character of argument) {
    if (character === "\\" || character === "'") word += `\\${character}`;
    else if (CONTROL.test(character)) for (const byte of Buffer.from(character, "utf8")) word += `\\${byte.toString(8).padStart(3, "0")}`;
    else word += character;
  }
  return `${word}'`;
}

// The leading space keeps the line out of shell history where the shell is
// configured for that; `command` bypasses shell functions named pi-profile.
// `--cwd` pins the worker to the authorized worktree: without it a profile's
// configured default directory would win over the tab's directory.
export function buildProfileCommand(profile: string, cwd: string, args: readonly string[]): string {
  if (!isPiProfileName(profile)) throw new Error("Pi profile name is not a safe logical name.");
  if (!path.isAbsolute(cwd)) throw new Error("Profiled launch directory must be absolute.");
  const command = [" command pi-profile --cwd", shellWord(cwd), profile, ...args.map(shellWord)].join(" ");
  if (Buffer.byteLength(command, "utf8") > MAX_PROFILE_COMMAND_BYTES) throw new Error("Profiled launch command exceeds the bounded size.");
  return command;
}
