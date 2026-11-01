import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface Source {
  /** Prefix of every skill path from this source, e.g. `mattpocock`. */
  name: string;
  /** Git URL the commit is fetched from. */
  repo: string;
  /** Full 40-character commit SHA. Branches and tags are resolved by `add`, never served. */
  commit: string;
  /** Optional folder inside the repository to search for skills. */
  path?: string;
}

export interface Config {
  sources: Source[];
}

const SOURCE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const COMMIT = /^[0-9a-f]{40}$/;

export function defaultConfigPath(): string {
  if (process.env.SKILLSHELF_CONFIG) return process.env.SKILLSHELF_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "skillshelf", "skillshelf.json");
}

export function defaultCacheDir(): string {
  if (process.env.SKILLSHELF_CACHE) return process.env.SKILLSHELF_CACHE;
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "skillshelf");
}

export function parseConfig(text: string, origin = "config"): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${origin}: not valid JSON (${(error as Error).message})`);
  }
  if (!isObject(raw) || !Array.isArray(raw.sources))
    throw new Error(`${origin}: expected an object with a "sources" array`);
  const names = new Set<string>();
  const sources = raw.sources.map((entry, i): Source => {
    const where = `${origin}: sources[${i}]`;
    if (!isObject(entry)) throw new Error(`${where} must be an object`);
    const { name, repo, commit, path } = entry;
    for (const key of Object.keys(entry))
      if (!["name", "repo", "commit", "path"].includes(key))
        throw new Error(`${where} has unknown field "${key}"`);
    if (typeof name !== "string" || !SOURCE_NAME.test(name))
      throw new Error(
        `${where}.name must be lowercase letters, digits and hyphens (got ${JSON.stringify(name)})`,
      );
    if (names.has(name)) throw new Error(`${where}.name "${name}" is used twice`);
    names.add(name);
    if (typeof repo !== "string" || !repo) throw new Error(`${where}.repo is required`);
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(repo))
      throw new Error(`${where}.repo must not embed credentials`);
    if (typeof commit !== "string" || !COMMIT.test(commit))
      throw new Error(
        `${where}.commit must be a full 40-character commit SHA; use "skillshelf add" to resolve a branch or tag`,
      );
    if (path !== undefined) {
      if (typeof path !== "string" || path.startsWith("/") || path.split("/").includes(".."))
        throw new Error(`${where}.path must be a relative path inside the repository`);
    }
    return { name, repo, commit, ...(path ? { path } : {}) };
  });
  return { sources };
}

export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sources: [] };
    throw error;
  }
  return parseConfig(text, path);
}

export async function saveConfig(path: string, config: Config): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
