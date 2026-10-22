/**
 * Is the GG Coder desktop app installed on this machine?
 *
 * Decides whether the `ggcoder-app` provider is offered at all — the same role
 * a PATH lookup plays for a CLI agent. Installed is not the same as running:
 * an installed app that is closed is still offered, and the bridge says "open
 * GG Coder" when a session starts. A machine that has *ever* run a connection-
 * aware build counts too, since `~/.gg/app-connections` only exists then.
 *
 * Windows paths are where the NSIS installer puts a per-user install (the
 * default) and a per-machine one.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function ggAppInstallPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string[] {
  const paths = [join(home, ".gg", "app-connections")];
  if (platform === "darwin") {
    paths.push("/Applications/GG Coder.app", join(home, "Applications", "GG Coder.app"));
  } else if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    paths.push(join(local, "GG Coder", "gg-app.exe"), join(local, "Programs", "GG Coder", "gg-app.exe"));
    for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
      if (root) paths.push(join(root, "GG Coder", "gg-app.exe"));
    }
  }
  return paths;
}

export function ggAppInstalled(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): boolean {
  return ggAppInstallPaths(env, platform, home).some((path) => exists(path));
}
