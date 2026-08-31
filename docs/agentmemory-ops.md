# agentmemory — local ops reference

Persistent-memory layer for Claude Code sessions on this Mac. Lives on
`localhost:3111` (REST), `localhost:3112` (streams), `localhost:3113` (viewer),
with the iii-engine on `49134`.

## Layout

| Component | Location | Notes |
|---|---|---|
| Plugin | `agentmemory@agentmemory` v0.9.29, user-scope | Wired via `claude plugin install` |
| Marketplace | `https://github.com/rohitg00/agentmemory` | `claude plugin marketplace add` |
| Source clone | `~/.claude/plugins/marketplaces/agentmemory/` | Used to rebuild `dist/cli.mjs` |
| Plugin cache | `~/.claude/plugins/cache/agentmemory/agentmemory/0.9.29/` | What Claude Code actually loads |
| Built CLI | `~/.claude/plugins/marketplaces/agentmemory/dist/cli.mjs` | Rebuilt with `npm run build` after `npm install` |
| LaunchAgent | `~/Library/LaunchAgents/com.agentmemory.daemon.plist` | Auto-start at login + KeepAlive respawn |
| Daemon log | `~/Library/Logs/agentmemory/daemon.log` | stdout + stderr merged |
| iii-engine binary | `~/.agentmemory/bin/iii` | v0.11.2, auto-downloaded on first start |
| Config | `~/.agentmemory/.env` | All keys commented out (zero-LLM mode) |
| Data | `~/Library/Application Support/agentmemory/` | SQLite store; survives restarts |

## Operating modes

**Zero-LLM** (current default): no API keys, BM25 search only. All 54 MCP
tools work except LLM-powered compression. To enable compression/summaries,
uncomment `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` / `GEMINI_API_KEY` /
`OPENROUTER_API_KEY` / `MINIMAX_API_KEY`) in `~/.agentmemory/.env` and
restart the daemon.

**Local embeddings** (`EMBEDDING_PROVIDER=local`): downloads
`Xenova/all-MiniLM-L6-v2` on first request, then runs on-device. Enables
semantic `smart_search` to outperform BM25 on paraphrased queries. First
request takes longer (model download); subsequent ones are fast.

## Day-to-day commands

```bash
# Status (one-shot)
node ~/.claude/plugins/marketplaces/agentmemory/dist/cli.mjs status

# Health probes
curl http://localhost:3111/agentmemory/health
curl http://localhost:3111/agentmemory/livez

# Viewer (browser UI)
open http://localhost:3113

# Tail daemon log
tail -f ~/Library/Logs/agentmemory/daemon.log

# Stop (flushes state to disk; data dir preserved)
node ~/.claude/plugins/marketplaces/agentmemory/dist/cli.mjs stop

# Start manually (one-off; rarely needed since LaunchAgent handles it)
node ~/.claude/plugins/marketplaces/agentmemory/dist/cli.mjs &

# Doctor (diagnose + auto-fix common issues)
node ~/.claude/plugins/marketplaces/agentmemory/dist/cli.mjs doctor

# Demo (seed sample sessions + show recall)
node ~/.claude/plugins/marketplaces/agentmemory/dist/cli.mjs demo
```

## LaunchAgent management

The plist auto-starts the daemon at login (Aqua session only) and respawns it
within ~10 s if it crashes. PPID stays 1 (launchd) — if you ever see a
different PPID, the daemon was started manually, not by LaunchAgent.

```bash
# Disable auto-start (still loads on demand)
launchctl unload ~/Library/LaunchAgents/com.agentmemory.daemon.plist

# Re-enable
launchctl load -w ~/Library/LaunchAgents/com.agentmemory.daemon.plist

# Tail launchd's view of the job
launchctl list | grep agentmemory

# Inspect the job
launchctl print gui/$UID/com.agentmemory.daemon | head -40
```

## Memory tools available to me (via MCP)

Once `agentmemory` is in `enabledPlugins`, Claude Code auto-loads 54 tools.
The ones worth knowing about by hand:

| Tool | What it does |
|---|---|
| `memory_save` | Persist a fact/observation to the store |
| `memory_recall` / `memory_smart_search` | BM25 / hybrid query |
| `memory_forget` | Remove a memory by id |
| `memory_sessions` | List captured sessions |
| `memory_status` | Daemon health + counters |
| `memory_export` | JSON dump |
| `memory_import` | Import JSONL/JSON |

Skills also installed (slash commands): `/remember`, `/recall`, `/recap`,
`/forget`, `/commit-context`, `/lesson`, `/session-history`.

## Updating agentmemory

```bash
# 1. Pull the latest source
cd ~/.claude/plugins/marketplaces/agentmemory
git pull --ff-only

# 2. Rebuild
npm install
npm run build

# 3. Restart the daemon (LaunchAgent will respawn it)
launchctl kickstart -k gui/$UID/com.agentmemory.daemon

# Or just update via the marketplace metadata
claude plugin marketplace update agentmemory
claude plugin update agentmemory
```

The npm package and the GitHub repo are the same code (same author, v0.9.29,
Apache-2.0) — they stay in sync because the npm publish is the source of
truth and the GitHub repo just mirrors it.

## Privacy & data flow

- All hooks call `localhost:3111` — no network egress.
- `post-tool-use` captures tool input + tool output (truncated to 8 KB)
  into a local SQLite store.
- The viewer at `:3113` is a local web UI; nothing leaves this Mac unless
  you turn on a remote embedding provider explicitly.
- To disable auto-capture without removing the plugin: set
  `AGENTMEMORY_INJECT_CONTEXT=false` and the MCP server still works for
  manual `memory_save` / `memory_recall` calls.

## Uninstalling

```bash
launchctl unload ~/Library/LaunchAgents/com.agentmemory.daemon.plist
rm ~/Library/LaunchAgents/com.agentmemory.daemon.plist
node ~/.claude/plugins/marketplaces/agentmemory/dist/cli.mjs remove --force --keep-data   # or --no-keep-data to wipe memory store
claude plugin uninstall agentmemory
claude plugin marketplace remove agentmemory
rm -rf ~/.claude/plugins/marketplaces/agentmemory
```

`--keep-data` preserves `~/Library/Application Support/agentmemory/` in case
you want to come back later. Drop it for a clean wipe.
