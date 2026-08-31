# Semble — local ops reference

Semantic code search for AI agents. Indexes a repo, returns relevant snippets
instead of forcing grep + full-file reads. Lives at `~/.local/bin/semble`
(uv tool install), index cache at `~/Library/Caches/semble/`.

## Layout

| Component | Location | Notes |
|---|---|---|
| Binary | `~/.local/bin/semble` | v0.5.5, installed via `uv tool install` (PEP 668-compliant, no venv pollution) |
| MCP server | registered in `~/.claude.json` under `mcpServers.semble` | Lazy-started via `uvx --from "semble[mcp]==0.5.5" semble` |
| Sub-agent | `~/.claude/agents/semble-search.md` | "Code search agent" with Bash + Read tools |
| Instructions | `~/.claude/CLAUDE.md` (global, between `<!-- SEMBLE_START -->` and `<!-- SEMBLE_END -->`) | Tells Claude to prefer `mcp__semble__search` over Grep/Glob for code search |
| Index cache | `~/Library/Caches/semble/<hash>/` | Per-repo, ~12 MB for this project after first build |
| Embedding model | `~/.cache/huggingface/` | ~100 MB, downloaded on first use |

## Day-to-day commands

```bash
# Semantic search (CLI fallback when MCP isn't available)
semble search "query" [path]               # default path = cwd
semble search "query" . --top-k 5          # more results
semble search "query" . --content docs     # prose / markdown
semble search "query" . --content config   # yaml / toml / env
semble search "query" . --content all      # code + docs + config
semble search "query" . --max-snippet-lines 10   # concise chunks

# Find code similar to a known location
semble find-related path/to/file.py 42 . --content all

# Help
semble --help
semble search --help
```

## MCP tool usage (preferred path)

Once Claude Code restarts and loads the MCP, I'll have two tools:

| Tool | When to use |
|---|---|
| `mcp__semble__search` | Find where something is implemented — replaces `Grep` + `Read` for most exploration |
| `mcp__semble__find_related` | Given a file:line from a prior result, find similar implementations elsewhere |

The `content` field on search is `code` (default), `docs`, `config`, or `all`.

## Performance characteristics

Measured on this repo (`local-ai-ebook`, ~few hundred source files):

| Operation | First run | Cached |
|---|---|---|
| Index build | ~10 s | n/a (built once, invalidated on file change) |
| `semble search` query | ~10 s (includes index build) | ~0.6 s |
| `mcp__semble__search` query | ~10 s | ~0.6 s |

Index auto-invalidates when watched files change. No daemon runs.

**Vs built-in `Grep`:**
- Ripgrep is faster on literal-string searches across one repo
- Semble wins on **semantic** queries ("find code that handles authentication flow") and on **token efficiency** (returns ~10-line snippets instead of full files)
- Use Grep when you need every literal match across the whole repo (e.g. all callers of a renamed function). Use Semble for intent-based discovery.

## What it touches (recap)

- No hooks (unlike agentmemory) — Claude Code calls the MCP server on-demand, not on every tool call
- No daemon — index lives on disk, queries run in-process
- No background process — `semble` is invoked per-query (CLI) or per-tool-call (MCP)
- No `settings.json` writes — installer only touched `~/.claude.json` (MCP), `~/.claude/CLAUDE.md` (instructions), and `~/.claude/agents/semble-search.md` (sub-agent)
- Embedding model: ~100 MB on first use (downloaded to `~/.cache/huggingface/`)
- Index cache: per-repo, ~12 MB for this project

The repo itself was NOT touched by the install — no `CLAUDE.md` or `AGENTS.md` added to this project. If you want project-scoped instructions later, copy the `<!-- SEMBLE_START -->…<!-- SEMBLE_END -->` block from `~/.claude/CLAUDE.md` into `./CLAUDE.md`.

## Updating Semble

```bash
uv tool upgrade semble                    # upgrade in-place
semble --version                          # confirm new version

# Update the pin in the MCP entry (if version changed)
# ~/.claude.json currently pins: semble[mcp]==0.5.5
# Re-run installer to refresh:
semble install --agent claude --type mcp -y
```

## Cache management

```bash
# Force a fresh index on next query
rm -rf ~/Library/Caches/semble/

# Reduce index scope (faster builds, smaller cache)
# Add a .sembleignore at repo root with the same syntax as .gitignore.
# Default skips: node_modules/, .venv/, dist/, build/, __pycache__/, .next/

# Cap file size (default 1 MB)
SEMBLE_MAX_FILE_BYTES=524288 semble search "query" .
```

## Uninstalling

```bash
# 1. Remove the binary
uv tool uninstall semble

# 2. Remove MCP registration from Claude Code
#    Edit ~/.claude.json and delete the "semble" key under mcpServers.

# 3. Remove the sub-agent
rm ~/.claude/agents/semble-search.md

# 4. Remove the instructions block from global CLAUDE.md
#    Delete lines between <!-- SEMBLE_START --> and <!-- SEMBLE_END -->
#    (inclusive) in ~/.claude/CLAUDE.md.

# 5. (Optional) wipe the index cache + embedding model
rm -rf ~/Library/Caches/semble/
rm -rf ~/.cache/huggingface/
```

After step 1, `semble search` will fail; remove the references in
`~/.claude.json` so Claude Code stops trying to launch the MCP server.
Restart Claude Code so the change takes effect.

## Known quirks

- **`Language nginx not found, falling back to line chunking`** and similar
  messages on first run — tree-sitter doesn't bundle grammars for every
  file type by default. Falls back to line-based chunking; not an error.
- **`FutureWarning: HF_HUB_ENABLE_HF_TRANSFER`** — deprecation warning from
  `huggingface_hub`, not actionable on our side. Will disappear in a future
  Semble release.
- **`HF_HUB_ENABLE_HF_TRANSFER=1`** speeds up the model download by ~10×
  if set in the env before the first Semble run. Worth setting once:
  `echo 'export HF_HUB_ENABLE_HF_TRANSFER=1' >> ~/.zshrc`
- **Index is per-repo** — switching repos re-indexes. Multi-repo search
  is supported but each repo gets its own index dir.
