# skillshelf

An MCP server that makes a library of [agent skills](https://agentskills.io/specification) available **by name** without loading any of them into an agent's context. Say "use the tdd skill" and the agent calls `load_skill("tdd")`; until then the library costs only the fixed tool descriptions (about 2 KB), however many skills it holds.

Sources are Git repositories pinned to a full commit SHA. Nothing follows a branch at runtime.

## Use

```sh
npm install && npm run build
node dist/cli.js add https://github.com/mattpocock/skills   # resolves HEAD to a commit and pins it
node dist/cli.js list                                        # mattpocock/tdd, mattpocock/grill-me, …
node dist/cli.js serve                                       # MCP over stdio
```

MCP client configuration (Claude Code, Codex, Cursor or any MCP client):

```json
{ "mcpServers": { "skills": { "command": "node", "args": ["/path/to/skillshelf/dist/cli.js", "serve"] } } }
```

`add <git-url> [--name <source>] [--ref <branch|tag|sha>] [--path <folder>]` adds or re-pins a source; run it again with the same name to update. The config lives at `~/.config/skillshelf/skillshelf.json` (`--config` or `SKILLSHELF_CONFIG`), checkouts at `~/.cache/skillshelf` (`--cache` or `SKILLSHELF_CACHE`). `serve` fetches any missing checkout before it starts.

```json
{
  "sources": [
    { "name": "mattpocock", "repo": "https://github.com/mattpocock/skills", "commit": "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d" }
  ]
}
```

## Tools

| Tool | Does |
| --- | --- |
| `load_skill(name)` | Returns the skill's `SKILL.md`, its source repository and commit, and its supporting files. Accepts `tdd`, `mattpocock/tdd` or `skill://mattpocock/tdd/SKILL.md`. An unknown name returns up to five close matches; an ambiguous one lists the candidates. |
| `read_skill_file(name, path, offset?)` | Returns one supporting file listed by `load_skill`, in 100 KB chunks. |
| `find_skills(query?)` | Searches names and descriptions, for when the user asks what exists. |

Tool descriptions and server instructions never contain skill names or descriptions.

## Names

Every skill is addressed as `<source>/<name>`, so two repositories can both have a `tdd`. If one source has two skills with the same name, both are kept and their folder is added: `mattpocock/engineering/code-review`. A bare name that matches several skills is refused with the candidates rather than resolved silently.

## MCP Skills Extension

The server also implements [SEP-2640](https://modelcontextprotocol.io/seps/2640-skills-extension): it declares `io.modelcontextprotocol/skills`, answers `skills/list` and `skills/get` with frontmatter, digests and sizes, and serves every file as a `skill://<source>/<name>/<file>` resource. Hosts that support the extension can load skills natively; the tools above work everywhere else. `resources/directory/read` is not implemented.

## Safety

- Commits are fetched by SHA and verified after checkout. Git runs without user or system configuration, prompts or LFS downloads.
- Symlinks are checked out as plain files holding the link text, and are never listed if present in a local tree. Only files listed for a skill can be read.
- Every read is checked against the SHA-256 digest recorded at startup.
- Scripts are returned as text. Nothing in a skill is executed.
- Skill content is third-party text handed to an agent as instructions. Pin repositories you have read.

Skills larger than 512 files or 16 MiB, or without a valid `name` and `description`, are skipped and reported on stderr. Frontmatter that strict YAML rejects only because of an unquoted colon is read as plain `key: value` lines.

## Develop

```sh
npm run check          # typecheck and tests (Node 22.18+ runs the TypeScript directly)
npm run smoke -- tdd mocking.md   # build, start over stdio with your config, load a skill
```

## License

[MIT](LICENSE)
