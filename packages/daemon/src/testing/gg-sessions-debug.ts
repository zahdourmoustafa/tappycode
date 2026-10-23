/**
 * Prints each stage of reading GG Coder's stored chats, for diagnosing a
 * machine where GG Coder App lists none. `bun run` this on the machine.
 */
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { ggSessionsRoot, listConversations, parseHead } from "../gg-app/sessions.js";

const root = ggSessionsRoot();
console.log("homedir:", homedir(), "| USERPROFILE:", process.env.USERPROFILE, "| HOME:", process.env.HOME);
console.log("root:", root);
for (const project of await readdir(root).catch((e) => [`<readdir failed: ${e.message}>`])) {
  console.log(" project:", project);
  for (const name of await readdir(join(root, project)).catch(() => [])) {
    const file = join(root, project, name);
    const info = await stat(file);
    const handle = await open(file, "r");
    const buf = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buf, 0, 512, 0);
    await handle.close();
    const head = buf.subarray(0, bytesRead).toString("utf8");
    console.log("  file:", name, "size", info.size, "first bytes", [...buf.subarray(0, 4)].join(","));
    console.log("  parseHead:", JSON.stringify(parseHead(head)));
  }
}
console.log("listConversations:", JSON.stringify(await listConversations()));
