import type { Skill } from "./catalog.ts";

export type Lookup =
  | { kind: "found"; skill: Skill }
  | { kind: "ambiguous"; candidates: Skill[] }
  | { kind: "missing"; suggestions: Skill[] };

/**
 * Accepts a full path (`mattpocock/tdd`), any trailing part of one (`tdd`,
 * `engineering/code-review`) or a `skill://…/SKILL.md` URI. Case-insensitive.
 */
export function lookup(skills: Skill[], query: string): Lookup {
  const wanted = normalise(query);
  if (!wanted) return { kind: "missing", suggestions: [] };
  const exact = skills.find((s) => s.path.toLowerCase() === wanted);
  if (exact) return { kind: "found", skill: exact };
  const tail = skills.filter((s) => s.path.toLowerCase().endsWith("/" + wanted));
  if (tail.length === 1) return { kind: "found", skill: tail[0]! };
  if (tail.length > 1) return { kind: "ambiguous", candidates: tail };
  return { kind: "missing", suggestions: suggest(skills, wanted) };
}

function normalise(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/^skill:\/\//, "")
    .replace(/\/skill\.md$/, "")
    .replace(/^\/+|\/+$/g, "");
}

/** Up to five skills whose name is close to the query. */
export function suggest(skills: Skill[], query: string, limit = 5): Skill[] {
  const name = query.split("/").at(-1)!;
  const scored = skills
    .map((skill) => ({ skill, score: closeness(skill.name, name) }))
    .filter((s) => s.score < Infinity)
    .sort((a, b) => a.score - b.score || a.skill.path.localeCompare(b.skill.path));
  return scored.slice(0, limit).map((s) => s.skill);
}

function closeness(name: string, query: string): number {
  if (name.includes(query) || query.includes(name)) return Math.abs(name.length - query.length) / 100;
  const parts = query.split(/[-_\s]+/).filter((p) => p.length > 2);
  if (parts.some((p) => name.includes(p))) return 1;
  const distance = levenshtein(name, query);
  return distance <= Math.max(2, Math.floor(query.length / 3)) ? 1 + distance : Infinity;
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length]!;
}

/** Skills whose path or description contains every word of the query. */
export function find(skills: Skill[], query = ""): Skill[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return skills.filter((skill) => {
    const text = `${skill.path} ${skill.description}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
