import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Source } from "./config.ts";

const run = promisify(execFile);

// No prompts, no LFS downloads, no user or system config (hooks, filters, rewrites).
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    env: GIT_ENV,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Where a source's commit is checked out. Keyed by repository and commit, not by source name. */
export function checkoutDir(cacheDir: string, source: Source): string {
  const repoKey = createHash("sha256").update(source.repo).digest("hex").slice(0, 16);
  return join(cacheDir, "repos", repoKey, source.commit);
}

export async function isSynced(cacheDir: string, source: Source): Promise<boolean> {
  try {
    return (await stat(checkoutDir(cacheDir, source))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Fetch exactly `source.commit` and export its tree. Symlinks are checked out as plain
 * files holding the link text, so nothing in the export can point outside it.
 */
export async function syncSource(cacheDir: string, source: Source): Promise<string> {
  const target = checkoutDir(cacheDir, source);
  if (await isSynced(cacheDir, source)) return target;
  await mkdir(join(cacheDir, "tmp"), { recursive: true });
  const work = await mkdtemp(join(cacheDir, "tmp", "fetch-"));
  try {
    await git(["init", "-q", work]);
    await git(["config", "core.symlinks", "false"], work);
    try {
      await git(["fetch", "-q", "--depth", "1", "--no-tags", source.repo, source.commit], work);
    } catch {
      // Servers that refuse fetching by SHA: fetch everything, then check out the commit.
      await git(["fetch", "-q", "--no-tags", source.repo, "+refs/heads/*:refs/remotes/origin/*"], work);
    }
    await git(["-c", "advice.detachedHead=false", "checkout", "-q", source.commit], work);
    const head = await git(["rev-parse", "HEAD"], work);
    if (head !== source.commit)
      throw new Error(`${source.name}: checked out ${head}, expected ${source.commit}`);
    await rm(join(work, ".git"), { recursive: true, force: true });
    await mkdir(join(target, ".."), { recursive: true });
    await rename(work, target);
    return target;
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw new Error(`${source.name}: could not fetch ${source.repo} @ ${source.commit}: ${(error as Error).message}`);
  }
}

/** Resolve a branch, tag or SHA on a remote to a full commit SHA. */
export async function resolveCommit(repo: string, ref?: string): Promise<string> {
  if (ref && /^[0-9a-f]{40}$/.test(ref)) return ref;
  const out = await git(["ls-remote", repo, ref ?? "HEAD"]);
  const lines = out.split("\n").filter(Boolean);
  // Prefer a peeled tag (the commit) over the tag object.
  const peeled = lines.find((line) => line.endsWith("^{}"));
  const line = peeled ?? lines[0];
  if (!line) throw new Error(`${repo}: no ref named ${ref ?? "HEAD"}`);
  return line.split(/\s+/)[0]!;
}
