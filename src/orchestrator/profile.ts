export const PI_PROFILE_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";
export const MAX_PROFILE_COMMAND_BYTES = 16 * 1024;

const PROFILE_NAME = new RegExp(PI_PROFILE_PATTERN);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function isPiProfileName(value: unknown): value is string {
  return typeof value === "string" && PROFILE_NAME.test(value);
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
export function buildProfileCommand(profile: string, args: readonly string[]): string {
  if (!isPiProfileName(profile)) throw new Error("Pi profile name is not a safe logical name.");
  const command = [" command pi-profile", profile, ...args.map(shellWord)].join(" ");
  if (Buffer.byteLength(command, "utf8") > MAX_PROFILE_COMMAND_BYTES) throw new Error("Profiled launch command exceeds the bounded size.");
  return command;
}
