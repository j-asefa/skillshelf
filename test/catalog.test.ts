import { strict as assert } from "node:assert";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { buildCatalog } from "../src/catalog.ts";
import type { Source } from "../src/config.ts";
import { lookup } from "../src/lookup.ts";
import { skillMd, tempDir, writeTree } from "./helpers.ts";

const source = (name: string): Source => ({
  name,
  repo: `https://example.com/${name}.git`,
  commit: "a".repeat(40),
});

test("finds skills in nested folders and lists their files with digests", async () => {
  const root = await tempDir();
  await writeTree(root, {
    "skills/engineering/tdd/SKILL.md": skillMd("tdd", "Test first."),
    "skills/engineering/tdd/mocking.md": "mocks",
    "skills/productivity/grill-me/SKILL.md": skillMd("grill-me", "Ask hard questions."),
    "README.md": "not a skill",
  });
  const catalog = await buildCatalog([source("matt")], new Map([["matt", root]]));
  assert.deepEqual(catalog.problems, []);
  assert.deepEqual(catalog.skills.map((s) => s.path), ["matt/grill-me", "matt/tdd"]);
  const tdd = catalog.skills.find((s) => s.name === "tdd")!;
  assert.equal(tdd.folder, "skills/engineering/tdd");
  assert.deepEqual(tdd.files.map((f) => f.path), ["mocking.md", "SKILL.md"]);
  assert.match(tdd.files[0]!.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(tdd.frontmatter.description, "Test first.");
});

test("keeps both skills when one source has two with the same name", async () => {
  const root = await tempDir();
  await writeTree(root, {
    "engineering/code-review/SKILL.md": skillMd("code-review", "Engineering review."),
    "misc/code-review/SKILL.md": skillMd("code-review", "Misc review."),
  });
  const catalog = await buildCatalog([source("matt")], new Map([["matt", root]]));
  assert.deepEqual(catalog.skills.map((s) => s.path), [
    "matt/engineering/code-review",
    "matt/misc/code-review",
  ]);
  const result = lookup(catalog.skills, "code-review");
  assert.equal(result.kind, "ambiguous");
  const exact = lookup(catalog.skills, "misc/code-review");
  assert.equal(exact.kind === "found" && exact.skill.description, "Misc review.");
});

test("never lists symlinked files, even ones pointing inside the skill", async () => {
  const root = await tempDir();
  await writeTree(root, { "s/SKILL.md": skillMd("s", "Linky."), "s/real.md": "ok" });
  await symlink("/etc/hostname", join(root, "s", "outside.md"));
  await symlink("real.md", join(root, "s", "inside.md"));
  const catalog = await buildCatalog([source("x")], new Map([["x", root]]));
  assert.deepEqual(catalog.skills[0]!.files.map((f) => f.path), ["real.md", "SKILL.md"]);
});

test("reports invalid skills instead of serving them", async () => {
  const root = await tempDir();
  await writeTree(root, {
    "a/SKILL.md": "no frontmatter",
    "b/SKILL.md": skillMd("Bad Name", "x"),
    "c/SKILL.md": "---\nname: c\n---\nbody",
  });
  const catalog = await buildCatalog([source("x")], new Map([["x", root]]));
  assert.equal(catalog.skills.length, 0);
  assert.deepEqual(catalog.problems.map((p) => p.folder), ["a", "b", "c"]);
});

test("skills from different sources with one name stay separate", async () => {
  const one = await tempDir();
  const two = await tempDir();
  await writeTree(one, { "tdd/SKILL.md": skillMd("tdd", "One.") });
  await writeTree(two, { "tdd/SKILL.md": skillMd("tdd", "Two.") });
  const catalog = await buildCatalog(
    [source("one"), source("two")],
    new Map([["one", one], ["two", two]]),
  );
  assert.deepEqual(catalog.skills.map((s) => s.path), ["one/tdd", "two/tdd"]);
  assert.equal(lookup(catalog.skills, "tdd").kind, "ambiguous");
  const uri = lookup(catalog.skills, "skill://two/tdd/SKILL.md");
  assert.equal(uri.kind === "found" && uri.skill.description, "Two.");
});

test("suggests close names for a miss", async () => {
  const root = await tempDir();
  for (const name of ["grill-me", "grilling", "grill-with-docs", "tdd", "triage"])
    await writeTree(root, { [`${name}/SKILL.md`]: skillMd(name, name) });
  const catalog = await buildCatalog([source("m")], new Map([["m", root]]));
  const grill = lookup(catalog.skills, "grill");
  assert.equal(grill.kind, "missing");
  assert.deepEqual(
    grill.kind === "missing" && grill.suggestions.map((s) => s.name).sort(),
    ["grill-me", "grill-with-docs", "grilling"],
  );
  const typo = lookup(catalog.skills, "triag");
  assert.equal(typo.kind === "missing" && typo.suggestions[0]!.name, "triage");
});

test("accepts an unquoted colon in a description, as other harnesses do", async () => {
  const root = await tempDir();
  await writeTree(root, {
    "f/SKILL.md": "---\nname: f\ndescription: Shared language: the tasks it runs\n---\nbody",
  });
  const catalog = await buildCatalog([source("x")], new Map([["x", root]]));
  assert.deepEqual(catalog.problems, []);
  assert.equal(catalog.skills[0]!.description, "Shared language: the tasks it runs");
});
