import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Source } from "./config.ts";

export const MAX_FILES = 512;
export const MAX_BYTES = 16 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules"]);
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillFile {
  /** Path relative to the skill folder, `/`-separated. */
  path: string;
  size: number;
  digest: string;
}

export interface Skill {
  /** `<source>/<name>`, or `<source>/<folder>/<name>` when a source has two skills with one name. */
  path: string;
  name: string;
  description: string;
  /** The SKILL.md frontmatter, verbatim. */
  frontmatter: Record<string, unknown>;
  source: Source;
  /** Skill folder relative to the repository root. */
  folder: string;
  dir: string;
  files: SkillFile[];
}

export interface Problem {
  source: string;
  folder: string;
  message: string;
}

export interface Catalog {
  skills: Skill[];
  problems: Problem[];
}

export function skillUri(skill: Skill, file = "SKILL.md"): string {
  return `skill://${skill.path}/${file}`;
}

/** Find every skill in each source's checkout. `checkouts` maps source name to its directory. */
export async function buildCatalog(
  sources: Source[],
  checkouts: Map<string, string>,
): Promise<Catalog> {
  const skills: Skill[] = [];
  const problems: Problem[] = [];
  for (const source of sources) {
    const root = checkouts.get(source.name);
    if (!root) {
      problems.push({ source: source.name, folder: "", message: "not fetched" });
      continue;
    }
    const scanRoot = source.path ? join(root, source.path) : root;
    const found: Omit<Skill, "path">[] = [];
    for (const dir of await findSkillDirs(scanRoot)) {
      const folder = toPosix(relative(root, dir)) || ".";
      try {
        found.push(await loadSkill(source, dir, folder));
      } catch (error) {
        problems.push({ source: source.name, folder, message: (error as Error).message });
      }
    }
    const counts = new Map<string, number>();
    for (const skill of found) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
    for (const skill of found) {
      let path = `${source.name}/${skill.name}`;
      if (counts.get(skill.name)! > 1) {
        // Keep both: the folder disambiguates, and the last segment stays the skill's name.
        const parts = toPosix(relative(scanRoot, skill.dir)).split("/");
        if (parts.at(-1) === skill.name) parts.pop();
        path = [source.name, ...parts, skill.name].join("/");
      }
      skills.push({ ...skill, path });
    }
  }
  skills.sort((a, b) => a.path.localeCompare(b.path));
  return { skills, problems };
}

async function findSkillDirs(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) return [dir];
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)))
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name))
      out.push(...(await findSkillDirs(join(dir, entry.name))));
  return out;
}

async function loadSkill(
  source: Source,
  dir: string,
  folder: string,
): Promise<Omit<Skill, "path">> {
  const text = await readFile(join(dir, "SKILL.md"), "utf8");
  const frontmatter = parseFrontmatter(text);
  const { name, description } = frontmatter;
  if (typeof name !== "string" || !SKILL_NAME.test(name) || name.length > 64)
    throw new Error(`SKILL.md name ${JSON.stringify(name)} is not a valid skill name`);
  if (typeof description !== "string" || !description.trim())
    throw new Error("SKILL.md has no description");
  const files: SkillFile[] = [];
  let total = 0;
  for (const file of await listFiles(dir)) {
    const bytes = await readFile(join(dir, file));
    total += bytes.length;
    files.push({ path: file, size: bytes.length, digest: digestOf(bytes) });
    if (files.length > MAX_FILES) throw new Error(`more than ${MAX_FILES} files`);
    if (total > MAX_BYTES) throw new Error(`larger than ${MAX_BYTES} bytes`);
  }
  return { name, description, frontmatter, source, folder, dir, files };
}

/** Regular files only; symlinks and anything else are left out. */
async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(join(dir, prefix), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const info = await lstat(join(dir, rel));
    if (info.isDirectory() && !SKIP_DIRS.has(entry.name)) out.push(...(await listFiles(dir, rel)));
    else if (info.isFile()) out.push(rel);
  }
  return out;
}

export function parseFrontmatter(text: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error("SKILL.md has no YAML frontmatter");
  let data: unknown;
  try {
    data = parseYaml(match[1]!);
  } catch (error) {
    // Unquoted colons in descriptions are common and other harnesses accept them.
    data = plainFrontmatter(match[1]!);
    if (!data)
      throw new Error(`SKILL.md frontmatter is not valid YAML: ${(error as Error).message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    throw new Error("SKILL.md frontmatter is not a mapping");
  return data as Record<string, unknown>;
}

/** `key: value` lines read literally, for frontmatter that strict YAML rejects. */
function plainFrontmatter(text: string): Record<string, unknown> | undefined {
  const out: Record<string, string> = {};
  let last: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (field) {
      last = field[1]!;
      out[last] = unquote((field[2] ?? "").trim());
    } else if (last && /^\s+\S/.test(line)) {
      out[last] = `${out[last]} ${line.trim()}`.trim();
    } else if (line.trim()) {
      return undefined;
    }
  }
  return typeof out.name === "string" && typeof out.description === "string" ? out : undefined;
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? quoted[2]! : value;
}

export function digestOf(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

function toPosix(path: string): string {
  return path.split(sep).join(posix.sep);
}
