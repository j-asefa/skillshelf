// Starts the built server over stdio with the current config and exercises it as an MCP client.
// Usage: npm run build && node scripts/smoke.ts <skill-name> [file]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

const [name = "tdd", file] = process.argv.slice(2);
const client = new Client({ name: "skillshelf-smoke", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../dist/cli.js", import.meta.url).pathname, "serve"],
    env: process.env as Record<string, string>,
    stderr: "inherit",
  }),
);
const { tools } = await client.listTools();
const advertised = JSON.stringify(tools) + (client.getInstructions() ?? "");
console.log(`tools: ${tools.map((t) => t.name).join(", ")} (${advertised.length} chars advertised)`);
const listed = await client.request(
  { method: "skills/list", params: {} },
  z.object({ skills: z.array(z.object({ uri: z.string() })) }),
);
console.log(`skills/list: ${listed.skills.length} skills`);
const show = async (tool: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = (result.content as { text: string }[]).map((c) => c.text).join("");
  console.log(`\n--- ${tool} ${JSON.stringify(args)}${result.isError ? " (error)" : ""}\n${text.slice(0, 700)}`);
};
await show("load_skill", { name });
if (file) await show("read_skill_file", { name, path: file });
await show("load_skill", { name: "grill" });
await client.close();
