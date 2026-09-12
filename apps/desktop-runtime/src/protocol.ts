import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ACTION_SCHEME } from "./action.ts";

const execFileAsync = promisify(execFile);

async function run(file: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(file, args);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${file} ${args[0] ?? ""} failed: ${detail}`);
  }
}

/**
 * The command the OS runs for a stremio-offline:// URI; the OS appends the URI.
 * Absolute paths throughout: node itself, tsx's CLI (not `--import tsx`, which
 * resolves against the cwd, and a protocol handler gets no useful cwd) and this
 * app's entry point.
 */
export function dispatchCommand(): string[] {
  return [
    process.execPath,
    fileURLToPath(import.meta.resolve("tsx/cli")),
    fileURLToPath(new URL("./main.ts", import.meta.url)),
    "dispatch",
  ];
}

/** Register stremio-offline:// for the current user. Returns a line describing what was done. */
export async function registerProtocol(): Promise<string> {
  const command = dispatchCommand();
  switch (process.platform) {
    case "win32":
      return registerWindows(command);
    case "linux":
      return registerLinux(command);
    default:
      throw new Error(`${process.platform} is not supported yet: owning a URL scheme there needs an app bundle`);
  }
}

// HKCU only: no elevation, and it is this user's Stremio that dispatches the URI.
async function registerWindows(command: string[]): Promise<string> {
  const key = `HKCU\\Software\\Classes\\${ACTION_SCHEME}`;
  const commandLine = `${command.map((part) => `"${part}"`).join(" ")} "%1"`;
  await run("reg", ["add", key, "/ve", "/d", "URL:Stremio Offline", "/f"]);
  await run("reg", ["add", key, "/v", "URL Protocol", "/t", "REG_SZ", "/d", "", "/f"]);
  await run("reg", ["add", `${key}\\shell\\open\\command`, "/ve", "/d", commandLine, "/f"]);
  return `registered ${ACTION_SCHEME}:// under ${key}\n  handler: ${commandLine}`;
}

// Desktop Entry spec: arguments with reserved characters go in double quotes,
// with backslash, double quote, dollar and backtick escaped inside them.
function quoteExecArg(part: string): string {
  return `"${part.replace(/[\\"$`]/g, (char) => `\\${char}`)}"`;
}

async function registerLinux(command: string[]): Promise<string> {
  const dir = join(process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share"), "applications");
  const desktopFile = `${ACTION_SCHEME}.desktop`;
  const mimeType = `x-scheme-handler/${ACTION_SCHEME}`;
  const exec = `${command.map(quoteExecArg).join(" ")} %u`;
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, desktopFile),
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Stremio Offline",
      `Exec=${exec}`,
      "NoDisplay=true",
      "Terminal=false",
      `MimeType=${mimeType};`,
      "",
    ].join("\n"),
    "utf8",
  );
  try {
    await run("xdg-mime", ["default", desktopFile, mimeType]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${desktopFile} was written to ${dir}, but making it the ${mimeType} default failed ` +
        `(install xdg-utils, or set the default by hand): ${detail}`,
    );
  }
  await execFileAsync("update-desktop-database", [dir]).catch(() => undefined);
  return `wrote ${join(dir, desktopFile)} and made it the ${mimeType} handler\n  handler: ${exec}`;
}
