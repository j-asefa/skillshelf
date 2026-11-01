import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { digestOf, skillUri, type Catalog, type Skill } from "./catalog.ts";
import { find, lookup } from "./lookup.ts";

export const VERSION = "0.1.0";
export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
const PAGE = 100;
const READ_CHUNK = 100_000;

// Fixed text: no skill names or descriptions ever reach tool descriptions or instructions.
const INSTRUCTIONS =
  "This server holds a library of agent skills that are not preloaded. When the user asks you to use a skill by name, call load_skill with that name and follow the instructions it returns. Use find_skills only when the user asks what skills exist.";

const TOOLS = [
  {
    name: "load_skill",
    description:
      "Load a skill's instructions by name, when the user asks you to use a skill. Accepts a bare name (tdd), a qualified name (mattpocock/tdd) or a skill:// URI. Returns the skill's SKILL.md, its source commit and the list of its supporting files. Follow the instructions; read supporting files with read_skill_file only when you need them. An unknown or ambiguous name returns the closest matches instead.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Skill name as the user gave it." } },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { title: "Load skill", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "read_skill_file",
    description:
      "Read one supporting file of a skill, using a path listed by load_skill (relative to the skill's folder). Long files are returned in chunks; pass the returned offset to continue. Only listed files can be read. Scripts are returned as text and are never run.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name, as for load_skill." },
        path: { type: "string", description: "File path relative to the skill folder." },
        offset: { type: "integer", minimum: 0, description: "Byte offset to continue from." },
      },
      required: ["name", "path"],
      additionalProperties: false,
    },
    annotations: { title: "Read skill file", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "find_skills",
    description:
      "Search the skill library by words in skill names and descriptions. Use only when the user asks what skills exist or which one fits; to use a named skill, call load_skill directly.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Words to match; omit to list everything." } },
      additionalProperties: false,
    },
    annotations: { title: "Find skills", readOnlyHint: true, openWorldHint: false },
  },
];

const SkillsListRequest = z.object({
  method: z.literal("skills/list"),
  params: z.object({ cursor: z.string().optional() }).passthrough().optional(),
});
const SkillsGetRequest = z.object({
  method: z.literal("skills/get"),
  params: z.object({ uri: z.string() }).passthrough(),
});

export function createServer(catalog: Catalog): Server {
  const server = new Server(
    { name: "skillshelf", version: VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        extensions: { [SKILLS_EXTENSION]: {} },
      },
      instructions: INSTRUCTIONS,
    },
  );
  const byUri = new Map<string, { skill: Skill; file: string }>();
  for (const skill of catalog.skills)
    for (const file of skill.files) byUri.set(skillUri(skill, file.path), { skill, file: file.path });

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (request.params.name) {
        case "load_skill":
          return text(await loadSkill(catalog, String(args.name ?? "")));
        case "read_skill_file":
          return text(
            await readSkillFile(
              catalog,
              String(args.name ?? ""),
              String(args.path ?? ""),
              typeof args.offset === "number" ? args.offset : 0,
            ),
          );
        case "find_skills":
          return text(findSkills(catalog, typeof args.query === "string" ? args.query : ""));
        default:
          return failure(`Unknown tool ${request.params.name}`);
      }
    } catch (error) {
      return failure((error as Error).message);
    }
  });

  // Files are readable by URI but never enumerated, so the listing does not grow with the
  // library. skills/list is the catalogue; SEP-2640 does not require skill files to be listed.
  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const hit = byUri.get(request.params.uri);
    if (!hit) throw new McpError(ErrorCode.InvalidParams, `Unknown resource ${request.params.uri}`);
    const bytes = await verifiedBytes(hit.skill, hit.file);
    const mimeType = hit.file === "SKILL.md" ? "text/markdown" : mimeTypeOf(hit.file);
    const decoded = decodeUtf8(bytes);
    return {
      contents: [
        decoded === undefined
          ? { uri: request.params.uri, mimeType, blob: Buffer.from(bytes).toString("base64") }
          : { uri: request.params.uri, mimeType, text: decoded },
      ],
    };
  });

  server.setRequestHandler(SkillsListRequest, (request) => {
    const start = Number(request.params?.cursor ?? 0) || 0;
    const skills = catalog.skills.slice(start, start + PAGE).map(entry);
    const next = start + PAGE;
    return {
      resultType: "complete",
      skills,
      ...(next < catalog.skills.length ? { nextCursor: String(next) } : {}),
    };
  });

  server.setRequestHandler(SkillsGetRequest, (request) => {
    const skill = catalog.skills.find((s) => skillUri(s) === request.params.uri);
    if (!skill) throw new McpError(ErrorCode.InvalidParams, `No skill at ${request.params.uri}`);
    return { resultType: "complete", skill: entry(skill) };
  });

  return server;
}

/** A SEP-2640 skill entry. */
function entry(skill: Skill) {
  return {
    uri: skillUri(skill),
    frontmatter: skill.frontmatter,
    resources: skill.files.map((f) => ({ uri: skillUri(skill, f.path), digest: f.digest, size: f.size })),
  };
}

function resolve(catalog: Catalog, name: string): Skill {
  const result = lookup(catalog.skills, name);
  if (result.kind === "found") return result.skill;
  if (result.kind === "ambiguous")
    throw new Error(
      `"${name}" matches several skills; call again with one of: ${result.candidates.map((s) => s.path).join(", ")}`,
    );
  const hint = result.suggestions.length
    ? ` Closest matches: ${result.suggestions.map((s) => s.path).join(", ")}.`
    : " Use find_skills to search the library.";
  throw new Error(`No skill named "${name}".${hint}`);
}

export async function loadSkill(catalog: Catalog, name: string): Promise<string> {
  const skill = resolve(catalog, name);
  const body = decodeUtf8(await verifiedBytes(skill, "SKILL.md")) ?? "";
  const files = skill.files.filter((f) => f.path !== "SKILL.md").map((f) => f.path);
  return [
    `Skill: ${skill.path}`,
    `Source: ${skill.source.repo} @ ${skill.source.commit} (${skill.folder})`,
    files.length
      ? `Supporting files (read with read_skill_file when needed): ${files.join(", ")}`
      : "Supporting files: none",
    "Relative paths in the skill refer to its supporting files. Where it says to use or invoke another skill (for example \"call the Skill tool with X\"), call load_skill with that name.",
    "",
    body,
  ].join("\n");
}

export async function readSkillFile(
  catalog: Catalog,
  name: string,
  path: string,
  offset = 0,
): Promise<string> {
  const skill = resolve(catalog, name);
  const wanted = path.trim().replace(/^\.\//, "");
  const file = skill.files.find((f) => f.path === wanted);
  if (!file)
    throw new Error(
      `${skill.path} has no file "${path}". Files: ${skill.files.map((f) => f.path).join(", ")}`,
    );
  const bytes = await verifiedBytes(skill, file.path);
  const decoded = decodeUtf8(bytes);
  if (decoded === undefined)
    return `${skill.path}/${file.path} is binary (${file.size} bytes, ${file.digest}); it is not returned as text.`;
  let end = Math.min(bytes.length, offset + READ_CHUNK);
  // Never split a UTF-8 character across chunks.
  while (end < bytes.length && end > offset && (bytes[end]! & 0xc0) === 0x80) end--;
  const chunk = Buffer.from(bytes.subarray(offset, end)).toString("utf8");
  const header = `File: ${skill.path}/${file.path} (${skill.source.commit.slice(0, 12)})`;
  const more = end < bytes.length ? `\n\n[${bytes.length - end} more bytes; continue with offset ${end}]` : "";
  return `${header}\n\n${chunk}${more}`;
}

export function findSkills(catalog: Catalog, query: string): string {
  const hits = find(catalog.skills, query);
  if (!hits.length) return `No skills match "${query}".`;
  const shown = hits.slice(0, 50).map((s) => `- ${s.path}: ${s.description}`);
  const more = hits.length > 50 ? `\n(${hits.length - 50} more; narrow the query)` : "";
  return `${hits.length} skill(s):\n${shown.join("\n")}${more}`;
}

/** Read a file and check it still matches the digest recorded at startup. */
async function verifiedBytes(skill: Skill, path: string): Promise<Uint8Array> {
  const file = skill.files.find((f) => f.path === path);
  if (!file) throw new Error(`${skill.path} has no file ${path}`);
  const bytes = await readFile(join(skill.dir, path));
  if (digestOf(bytes) !== file.digest)
    throw new Error(`${skill.path}/${path} changed on disk since the server started; restart it.`);
  return bytes;
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function mimeTypeOf(path: string): string {
  const ext = path.split(".").at(-1)?.toLowerCase();
  const types: Record<string, string> = {
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    yaml: "application/yaml",
    yml: "application/yaml",
    sh: "text/x-shellscript",
    py: "text/x-python",
    js: "text/javascript",
    cjs: "text/javascript",
    mjs: "text/javascript",
    ts: "text/typescript",
    html: "text/html",
    css: "text/css",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    svg: "image/svg+xml",
    pdf: "application/pdf",
  };
  return (ext && types[ext]) || "application/octet-stream";
}

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function failure(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
