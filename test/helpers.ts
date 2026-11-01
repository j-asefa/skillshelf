import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "skillshelf-test-"));
}

export function skillMd(name: string, description: string, body = "Do the thing."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
}

/** Write `files` (path -> contents) under `root`. */
export async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
}
