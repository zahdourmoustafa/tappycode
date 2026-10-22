/**
 * Files a phone attaches to a new goal.
 *
 * Unlike a prompt's attachments (`attachments.ts`), these are not scratch:
 * the goal's agent and its workers read them for as long as the goal runs, over
 * days and daemon restarts. So they go under tappy's own home directory, never
 * the tempdir (which the OS clears) and never the project (where `git add .`
 * would commit them). Same limits and the same name sanitising as attachments:
 * a name off a phone is a label, not a path.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { wire } from "@tappy/protocol";
import { attachmentFileName, attachmentLimitError } from "./attachments";

/** `~/.tappy/goal-files`, or under `$TAPPY_HOME`. */
export function goalFilesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.TAPPY_HOME ?? join(homedir(), ".tappy"), "goal-files");
}

/**
 * Write a new goal's files to disk and return their absolute paths, in order.
 * Throws on a limit breach: a goal briefed on "the attached spec" is worse off
 * without it than with a clear refusal.
 */
export async function storeGoalFiles(
  files: readonly wire.PromptAttachment[],
  root: string = goalFilesRoot(),
): Promise<string[]> {
  if (files.length === 0) return [];
  const limit = attachmentLimitError(files);
  if (limit) throw new Error(limit);
  // One directory per goal creation, owner-only (it may hold anything).
  const dir = join(root, randomUUID());
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const paths: string[] = [];
  for (const [index, file] of files.entries()) {
    // Index-prefixed by attachmentFileName, so two "notes.md" don't collide.
    const path = join(dir, attachmentFileName(file.name, index));
    await writeFile(path, Buffer.from(file.data, "base64"), { mode: 0o600 });
    paths.push(path);
  }
  return paths;
}
