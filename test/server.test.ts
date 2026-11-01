import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { buildCatalog } from "../src/catalog.ts";
import { createServer, SKILLS_EXTENSION } from "../src/server.ts";
import { skillMd, tempDir, writeTree } from "./helpers.ts";

const COMMIT = "d".repeat(40);

async function connect() {
  const root = await tempDir();
  await writeTree(root, {
    "skills/engineering/tdd/SKILL.md": skillMd("tdd", "Test-driven development.", "See mocking.md."),
    "skills/engineering/tdd/mocking.md": "Mock at boundaries.\n",
    "skills/productivity/grill-me/SKILL.md": skillMd("grill-me", "Interview the user."),
  });
  const source = { name: "matt", repo: "https://github.com/mattpocock/skills", commit: COMMIT };
  const catalog = await buildCatalog([source], new Map([["matt", root]]));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(catalog).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return { client, root };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join("");
}

test("no skill name or description appears in tool descriptions or instructions", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const advertised = JSON.stringify(tools) + (client.getInstructions() ?? "");
  for (const word of ["grill-me", "Test-driven development", "Interview the user"])
    assert.ok(!advertised.includes(word), `${word} leaked into the tool list`);
  assert.deepEqual(tools.map((t) => t.name), ["load_skill", "read_skill_file", "find_skills"]);
});

test("load_skill returns the skill with its pinned source and files", async () => {
  const { client } = await connect();
  const text = textOf(await client.callTool({ name: "load_skill", arguments: { name: "tdd" } }));
  assert.match(text, /^Skill: matt\/tdd$/m);
  assert.match(text, new RegExp(`@ ${COMMIT} \\(skills/engineering/tdd\\)`));
  assert.match(text, /Supporting files .*: mocking\.md/);
  assert.match(text, /See mocking\.md\./);
  assert.match(text, /call load_skill with that name/);
});

test("an unknown name suggests matches and is an error", async () => {
  const { client } = await connect();
  const result = await client.callTool({ name: "load_skill", arguments: { name: "grill" } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Closest matches: matt\/grill-me/);
});

test("read_skill_file reads listed files only and refuses changed content", async () => {
  const { client, root } = await connect();
  const ok = await client.callTool({
    name: "read_skill_file",
    arguments: { name: "matt/tdd", path: "./mocking.md" },
  });
  assert.match(textOf(ok), /Mock at boundaries/);
  const escape = await client.callTool({
    name: "read_skill_file",
    arguments: { name: "tdd", path: "../grill-me/SKILL.md" },
  });
  assert.equal(escape.isError, true);
  await writeFile(join(root, "skills/engineering/tdd/mocking.md"), "tampered");
  const changed = await client.callTool({
    name: "read_skill_file",
    arguments: { name: "tdd", path: "mocking.md" },
  });
  assert.equal(changed.isError, true);
  assert.match(textOf(changed), /changed on disk/);
});

test("speaks the MCP skills extension: skills/list, skills/get and resources/read", async () => {
  const { client } = await connect();
  assert.deepEqual(client.getServerCapabilities()?.extensions?.[SKILLS_EXTENSION], {});
  const Entry = z.object({
    uri: z.string(),
    frontmatter: z.record(z.string(), z.unknown()),
    resources: z.array(z.object({ uri: z.string(), digest: z.string(), size: z.number() })),
  });
  const list = await client.request(
    { method: "skills/list", params: {} },
    z.object({ resultType: z.literal("complete"), skills: z.array(Entry) }),
  );
  assert.deepEqual(list.skills.map((s) => s.uri), [
    "skill://matt/grill-me/SKILL.md",
    "skill://matt/tdd/SKILL.md",
  ]);
  const tdd = list.skills[1]!;
  assert.equal(tdd.frontmatter.name, "tdd");
  assert.deepEqual(tdd.resources.map((r) => r.uri).sort(), [
    "skill://matt/tdd/SKILL.md",
    "skill://matt/tdd/mocking.md",
  ]);
  const got = await client.request(
    { method: "skills/get", params: { uri: "skill://matt/tdd/SKILL.md" } },
    z.object({ skill: Entry }),
  );
  assert.deepEqual(got.skill, tdd);
  await assert.rejects(
    client.request({ method: "skills/get", params: { uri: "skill://matt/nope/SKILL.md" } }, z.object({})),
    (error: { code?: number }) => error.code === -32602,
  );
  const read = await client.readResource({ uri: "skill://matt/tdd/mocking.md" });
  assert.equal((read.contents[0] as { text: string }).text, "Mock at boundaries.\n");
  const skill = await client.readResource({ uri: "skill://matt/grill-me/SKILL.md" });
  assert.match((skill.contents[0] as { text: string }).text, /^---\nname: grill-me/);
});

test("resources/list stays empty however large the library is", async () => {
  const { client } = await connect();
  assert.deepEqual((await client.listResources()).resources, []);
});
