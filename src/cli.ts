#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildCatalog, type Catalog } from "./catalog.ts";
import {
  defaultCacheDir,
  defaultConfigPath,
  loadConfig,
  saveConfig,
  type Config,
} from "./config.ts";
import { createServer, VERSION } from "./server.ts";
import { checkoutDir, isSynced, resolveCommit, syncSource } from "./sync.ts";

const USAGE = `skillshelf ${VERSION}: agent skills loaded by name over MCP

Usage:
  skillshelf add <git-url> [--name <source>] [--ref <branch|tag|sha>] [--path <folder>]
  skillshelf sync
  skillshelf list
  skillshelf serve

Options:
  --config <file>   Config file (default: $SKILLSHELF_CONFIG or ~/.config/skillshelf/skillshelf.json)
  --cache <dir>     Checkout cache (default: $SKILLSHELF_CACHE or ~/.cache/skillshelf)

"add" resolves the ref to a commit once and pins it. "serve" never follows branches;
to update a source, run "add" again with the same name.`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      cache: { type: "string" },
      name: { type: "string" },
      ref: { type: "string" },
      path: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
  });
  if (values.version) return print(VERSION);
  const [command, ...rest] = positionals;
  if (values.help || !command) return print(USAGE);
  const configPath = values.config ?? defaultConfigPath();
  const cacheDir = values.cache ?? defaultCacheDir();
  const config = await loadConfig(configPath);

  switch (command) {
    case "add": {
      const repo = rest[0];
      if (!repo) throw new Error("add needs a git URL");
      const name = values.name ?? sourceNameFrom(repo);
      const commit = await resolveCommit(repo, values.ref);
      const source = { name, repo, commit, ...(values.path ? { path: values.path } : {}) };
      const previous = config.sources.find((s) => s.name === name);
      if (previous && previous.repo !== repo && !values.name)
        throw new Error(
          `source "${name}" already points at ${previous.repo}; pass --name to add this repository separately`,
        );
      const next: Config = {
        sources: previous
          ? config.sources.map((s) => (s.name === name ? source : s))
          : [...config.sources, source],
      };
      await syncSource(cacheDir, source);
      const catalog = await catalogFor(next, cacheDir);
      await saveConfig(configPath, next);
      const count = catalog.skills.filter((s) => s.source.name === name).length;
      const verb = previous ? `updated ${previous.commit.slice(0, 12)} ->` : "added at";
      print(`${name}: ${verb} ${commit.slice(0, 12)}, ${count} skill(s). Config: ${configPath}`);
      reportProblems(catalog, name);
      return 0;
    }
    case "sync": {
      for (const source of config.sources) {
        const fresh = !(await isSynced(cacheDir, source));
        await syncSource(cacheDir, source);
        print(`${source.name}: ${fresh ? "fetched" : "cached"} ${source.commit.slice(0, 12)}`);
      }
      return 0;
    }
    case "list": {
      const catalog = await catalogFor(config, cacheDir);
      for (const skill of catalog.skills) print(`${skill.path}\t${skill.description}`);
      reportProblems(catalog);
      return 0;
    }
    case "serve": {
      // Fetch anything missing before connecting, so the first tool call never waits on git.
      for (const source of config.sources) await syncSource(cacheDir, source);
      const catalog = await catalogFor(config, cacheDir);
      reportProblems(catalog);
      process.stderr.write(`skillshelf: serving ${catalog.skills.length} skill(s)\n`);
      await createServer(catalog).connect(new StdioServerTransport());
      return -1;
    }
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

async function catalogFor(config: Config, cacheDir: string): Promise<Catalog> {
  const checkouts = new Map<string, string>();
  for (const source of config.sources)
    if (await isSynced(cacheDir, source)) checkouts.set(source.name, checkoutDir(cacheDir, source));
  return buildCatalog(config.sources, checkouts);
}

function sourceNameFrom(repo: string): string {
  const match = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repo);
  const owner = (match?.[1] ?? "source").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  return owner.replace(/^-+|-+$/g, "") || "source";
}

function reportProblems(catalog: Catalog, source?: string): void {
  for (const p of catalog.problems)
    if (!source || p.source === source)
      process.stderr.write(`skipped ${p.source}:${p.folder}: ${p.message}\n`);
}

function print(line: string): number {
  process.stdout.write(line + "\n");
  return 0;
}

// Output piped into `head` and closed early is not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (error: Error) => {
    process.stderr.write(`skillshelf: ${error.message}\n`);
    process.exitCode = 1;
  },
);
