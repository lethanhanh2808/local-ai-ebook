# GitHub Copilot MCP — local ops reference

GitHub Copilot (in VS Code and the `gh copilot` CLI) supports MCP servers. Both
products share the same daemon backends (`agentmemory` on `localhost:3111` and
`semble` on stdio), but they read MCP config from **different files with
different keys**.

## Config files at a glance

| Consumer | File path | Top-level key | Scope |
|---|---|---|---|
| **VS Code Copilot Chat** (user) | `~/Library/Application Support/Code/User/mcp.json` | `servers` | Cross-workspace on this Mac |
| **VS Code Copilot Chat** (workspace) | `.vscode/mcp.json` in the project root | `servers` | One project, shareable via git |
| **`gh copilot` CLI** (user) | `~/.copilot/mcp-config.json` | `mcpServers` | Cross-workspace on this Mac |
| **`gh copilot` CLI** (workspace) | `.mcp.json` or `.github/mcp.json` | `mcpServers` | One project, shareable via git |

**Note the key difference**: VS Code uses `servers`, the gh copilot CLI uses
`mcpServers`. They are NOT interchangeable — write both.

## What we wired

### 1. User-scope (already in place)

`~/.copilot/mcp-config.json` — used by `gh copilot` and any future tools that
follow the same convention.

`~/Library/Application Support/Code/User/mcp.json` — used by VS Code Copilot Chat
across all workspaces.

Both files contain the same two servers:

```json
{
  "servers": {                                  // or "mcpServers" for the CLI file
    "agentmemory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@agentmemory/mcp"],
      "env": {
        "AGENTMEMORY_URL":     "${AGENTMEMORY_URL:-http://localhost:3111}",
        "AGENTMEMORY_SECRET":  "${AGENTMEMORY_SECRET:-}",
        "AGENTMEMORY_TOOLS":   "${AGENTMEMORY_TOOLS:-all}"
      }
    },
    "semble": {
      "type": "stdio",
      "command": "uvx",
      "args": ["--from", "semble[mcp]==0.5.5", "semble"]
    }
  }
}
```

### 2. Optional workspace-scope (not yet written)

A `.vscode/mcp.json` in this repo would make Copilot Chat in VS Code pick up
the servers **only when working in this project**. Useful if you want the team
to get the same tooling without each person wiring it up — but it means the
config is committed to git and may surface in code review.

## Verifying (already done)

```bash
# 1. gh copilot sees both servers
gh copilot mcp list
#   User servers:
#     agentmemory (local)
#     semble (local)

# 2. Per-server detail
gh copilot mcp get agentmemory
gh copilot mcp get semble

# 3. Smoke-test each shim directly (proves stdio handshake works)
( printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}' \
   sleep 0.3 \
   printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
   sleep 1.5 ) | npx -y @agentmemory/mcp | head -c 1500
#   → serverInfo.name=agentmemory, 54 tools advertised

( ... same ... ) | uvx --from "semble[mcp]==0.5.5" semble | head -c 1500
#   → serverInfo.name=semble, 2 tools advertised (search, find_related)
```

Both shims pass the JSON-RPC `initialize` + `tools/list` handshake. The agent
backend (agentmemory daemon on `:3111`) and the semble binary are healthy.

## Restart to activate

VS Code reads `mcp.json` on launch. **Quit and reopen VS Code** for the new
user-scope config to be picked up. After that, open Copilot Chat and ask
"list my MCP servers" — it should respond with `agentmemory` (54 tools) and
`semble` (2 tools).

The `gh copilot` CLI reads its config at session start, so the next `gh
copilot` invocation will pick them up. First run will auto-download the
Copilot CLI binary to `~/.local/share/gh/copilot/` (~140 MB).

## Why two config files?

- **VS Code Copilot Chat** is built into VS Code itself and reads its own
  format at `~/Library/Application Support/Code/User/mcp.json`. It also
  supports a workspace `.vscode/mcp.json`.
- **The `gh copilot` CLI** is a separate binary that follows the Claude
  Desktop / Claude Code convention (`mcpServers` key in
  `~/.copilot/mcp-config.json`).
- VS Code's `chat.mcp.discovery.enabled` setting (Experimental) can
  auto-discover MCP servers from Claude Desktop, but **not** from the gh
  copilot CLI — so we still need both files.

## Day-to-day commands

```bash
# List all MCP servers gh copilot sees
gh copilot mcp list

# Add a new server (writes to ~/.copilot/mcp-config.json)
gh copilot mcp add <name> -- <command> [args...]
gh copilot mcp add context7 -- npx -y @upstash/context7-mcp

# Remove
gh copilot mcp remove <name>

# One-off: add a server just for this session
gh copilot --additional-mcp-config @./my-servers.json -p "use the foo tool"

# VS Code commands (via Command Palette):
#   "MCP: Open User Configuration"
#   "MCP: Add Server"
#   "MCP: List Servers"
#   "MCP: Reset Cached Tools"
```

## Uninstalling (per-tool)

```bash
# Remove from gh copilot
gh copilot mcp remove agentmemory
gh copilot mcp remove semble

# Remove from VS Code — edit ~/Library/Application Support/Code/User/mcp.json
# (or `.vscode/mcp.json`) and delete the entry. Restart VS Code.
```

The agentmemory daemon and semble binary keep running until you also remove
their LaunchAgent / uninstall the `uv` tool — they're independent of MCP.
