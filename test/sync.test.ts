import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { lstat, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { buildCatalog } from "../src/catalog.ts";
import { parseConfig, type Source } from "../src/config.ts";
import { checkoutDir, resolveCommit, syncSource } from "../src/sync.ts";
import { skillMd, tempDir, writeTree } from "./helpers.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

async function fixtureRepo() {
  const repo = await tempDir();
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "uploadpack.allowAnySHA1InWant", "true");
  await writeTree(repo, { "skills/tdd/SKILL.md": skillMd("tdd", "First version.") });
  await symlink("/etc/hostname", join(repo, "skills", "tdd", "leak.md"));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "one");
  const first = git(repo, "rev-parse", "HEAD");
  await writeTree(repo, { "skills/tdd/SKILL.md": skillMd("tdd", "Second version.") });
  git(repo, "commit", "-q", "-am", "two");
  return { repo, first, second: git(repo, "rev-parse", "HEAD") };
}

test("serves the pinned commit, not the branch tip, and exports symlinks as text", async () => {
  const { repo, first, second } = await fixtureRepo();
  const cache = await tempDir();
  const source: Source = { name: "fx", repo: `file://${repo}`, commit: first };
  const dir = await syncSource(cache, source);
  assert.equal(dir, checkoutDir(cache, source));
  const catalog = await buildCatalog([source], new Map([["fx", dir]]));
  assert.equal(catalog.skills[0]!.description, "First version.");
  const leak = join(dir, "skills", "tdd", "leak.md");
  assert.ok((await lstat(leak)).isFile());
  assert.equal(await readFile(leak, "utf8"), "/etc/hostname");
  assert.equal(await resolveCommit(`file://${repo}`, "main"), second);
});

test("a commit the repository does not have fails without leaving a checkout", async () => {
  const { repo } = await fixtureRepo();
  const cache = await tempDir();
  const source: Source = { name: "fx", repo: `file://${repo}`, commit: "b".repeat(40) };
  await assert.rejects(syncSource(cache, source), /could not fetch/);
  await assert.rejects(lstat(checkoutDir(cache, source)));
});

test("config only accepts full commit SHAs and safe paths", () => {
  const ok = { name: "m", repo: "https://github.com/m/s", commit: "c".repeat(40) };
  assert.equal(parseConfig(JSON.stringify({ sources: [ok] })).sources.length, 1);
  for (const bad of [
    { ...ok, commit: "main" },
    { ...ok, name: "Bad Name" },
    { ...ok, path: "../x" },
    { ...ok, repo: "https://user:token@github.com/m/s" },
    { ...ok, extra: true },
  ])
    assert.throws(() => parseConfig(JSON.stringify({ sources: [bad] })));
  assert.throws(() => parseConfig(JSON.stringify({ sources: [ok, ok] })), /used twice/);
});
