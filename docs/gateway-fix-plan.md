# Gateway fix plan — `gw.greenhome.net` (172.16.125.252)

**Audience:** the gateway dev team.
**Scope:** fix the two reproducible failure modes currently producing ~98% of the
errors Copilot is logging against `https://gw.greenhome.net/v1/`.

---

## TL;DR

| # | Bug | Effect | Fix complexity |
|---|---|---|---|
| **A** | `free-bai` rejects requests over its 192K-token limit, but Copilot routinely ships 200–275K | 80 of 102 errors (~78%) — `400 Input tokens exceed the configured limit of 192000` | Tiny — bump the upstream model's `max_model_len` **or** strip tools from the proxy when the request would overflow |
| **B** | `minimax` rejects tools whose `parameters` is empty `{}` | 13 of 102 errors (~13%) — `400 invalid params, function parameters is empty (2013)` | Tiny — sanitise empty `parameters` to `{"type":"object","properties":{}}` in the proxy before forwarding |

The remaining ~9% are user-cancellation (`This operation was aborted`) and
noise. The transport stack (TLS, auth, OpenAI-compat routing) is healthy.

---

## Environment we observed

| Layer | Detail |
|---|---|
| Network | `gw.greenhome.net` → `172.16.125.252`. ICMP 2.7 ms, TCP 80/443/3000 open |
| TLS cert | `CN=*.greenhome.net` issued by `CN=LAB-Root-CA` (private CA, not in macOS trust store by default) — accepted by Node since the upstream connection succeeds |
| Reverse proxy | `openresty` (`Server: openresty`) on 443, default 404 page on 80 |
| App server | FastAPI-style errors (`{"detail":"Unauthorized"}`) on the upstream API |
| Control-plane UI | Served at `https://gw.greenhome.net/docs/` — title is **`AI Gateway · Control Plane`**, React SPA, contains an extensive `/admin/*` route set (`/admin/providers`, `/admin/mcp-servers`, `/admin/benchmarks/tool-eval`, `/admin/virtual-models`, `/admin/route-policies/models`, …) |
| OpenRouter integration | Strings `openrouter` / `OpenRouter` appear 11× in the control-plane JS bundle — the data plane appears to be **OpenRouter-API-compatible** |
| Models exposed | `nexus`, `minimax`, `bai`, `free` — gateway-side aliases, not real model names |
| Copilot client | [AndrewButson.github-copilot-llm-gateway v1.7.1](https://github.com/arbs-io/github-copilot-llm-gateway) — translates VS Code LM API to OpenAI `/v1/chat/completions` |

### How the client builds the request

From `~/.vscode/extensions/andrewbutson.github-copilot-llm-gateway-1.7.1/out/extension.js`:

```js
function Xe(t) {                                   // request body
  return {
    model: t.model,
    messages: t.messages,
    max_tokens: t.maxTokens,
    temperature: t.temperature,
    ...(t.tools?.length > 0 && {
      tools: t.tools,
      ...(t.toolChoice !== void 0 && { tool_choice: t.toolChoice }),
      ...(t.parallelToolCalls !== void 0 && { parallel_tool_calls: t.parallelToolCalls }),
    }),
    ...extras,
  };
}

function buildToolsConfig(e, n) {
  return n.tools.map(i => ({
    type: "function",
    function: {
      name: i.name,
      description: i.description,
      parameters: i.inputSchema,                     // ← passed straight through
    },
  }));
}
```

Two facts to design around:

1. **Empty `parameters` object `{}` ships as-is.** If a VS Code tool's
   `inputSchema` is missing or empty, the proxy receives `parameters: {}`.
   This is the minimax failure mode — see **Bug B**.
2. **Token budgeting is done client-side.** The extension reads
   `max_model_len` (or fallbacks) from the model's `/v1/models` metadata
   (`function ne(t)` — looks at `max_model_len`, `max_input_tokens`,
   `context_length`, `context_window`, `meta.n_ctx`, `meta.n_ctx_train`),
   then fits `input + tools + max_tokens` into that budget. It does **not**
   read the input-token limit from the upstream error response — it just
   fails. Increasing the upstream `max_model_len` is therefore sufficient
   to make the existing client happy. See **Bug A**.

---

## Evidence

### Log location

```
~/Library/Application Support/Code/logs/<session>/window1/exthost/output_logging_<ts>/1-GitHub Copilot LLM Gateway.log
```

### Per-log error counts (last 7 days)

| Session | Errors |
|---|---|
| `20260831T081237/.../2-...` | **84** |
| `20260831T081237/.../1-...` | 10 |
| `20260831T081237/.../1-...1` | 4 |
| `20260830T155304/.../4-...` | 3 |
| `20260901T081830/.../1-...` | 0 |
| `20260901T075818/.../1-...` | 1 |
| **Total** | **102** |

### Bug A — `free-bai` 192K overflow (~78%)

```
ERROR: Chat request failed: Chat completion request failed:
  Inference server reported an error mid-stream:
  free-bai chat completions stream failed: 400
  The request is invalid:
  Input tokens exceed the configured limit of 192000 tokens.
  Your messages resulted in 211631 tokens.
  Please reduce the length of the messages.
```

Distinct request sizes seen in the log (showing the variance):

| Model reported | Input tokens | Overflow |
|---|---:|---:|
| `free-bai` | 197,709 | +5,709 |
| `free-bai` | 197,715 | +5,715 |
| `free-bai` | 206,475 | +14,475 |
| `free-bai` | 206,866 | +14,866 |
| `free-bai` | 211,631 | +19,631 |
| `free-bai` | 212,152 | +20,152 |
| `free-bai` | 212,825 | +20,825 |
| `free-bai` | 214,508 | +22,508 |
| `free-bai` | 217,301 | +25,301 |
| `free-bai` | 217,315 | +25,315 |
| `free-bai` | 253,066 | +61,066 |
| `free-bai` | 254,260 | +62,260 |
| `free-bai` | 276,485 | +84,485 |

Where the tokens go (recent session line):

```
Sending 87 tools to model (parallel: true)
Request: model=free, messages=39, tools=87, max_tokens=4096
Token estimate: input=26597, tools=26237, model_context=262144, chosen_max_tokens=4096
```

Note the **26,597** token tool overhead on a single request — almost 14% of
the budget gone before any user message is counted.

### Bug B — `minimax` empty `parameters` (~13%)

```
ERROR: Chat request failed: Chat completion request failed:
  Inference server reported an error mid-stream:
  minimax chat completions stream failed: 400
  invalid params, function parameters is empty (2013)
```

Stack (all errors share this frame):

```
at Y.streamChatCompletion
  (andrewbutson.github-copilot-llm-gateway-1.7.1/out/extension.js:1:4257)
```

### Error C — cancellations (~9%)

```
ERROR: Chat request failed: This operation was aborted
```

User-cancelled. Not a real error — ignore.

---

## Bug A — `free-bai` overflow: recommended fixes

### A1. Bump the upstream `max_model_len` (preferred)

The most common cause is that the vLLM (or whatever backend runs `free-bai`)
deployment is started with `--max-model-len 192000`, but the model itself
supports more.

**Action for the gateway team:**

1. Find the deployment config for `free-bai`. It's almost certainly a
   `vllm serve` command somewhere. Likely places: `docker-compose.yml`,
   systemd unit, k8s manifest, `LLM_ROUTER_*` env, or admin UI at
   `/admin/providers`.
2. Raise `--max-model-len` to at least **262144** (matches what the client
   already advertises in its `model_context` estimate) **or** the model's
   actual training context if smaller.
3. If GPU memory is the constraint, leave `max_model_len` lower but raise
   `max_input_tokens`/`context_length` in the model metadata returned by
   `/v1/models` so the client budgets correctly (this is the value the
   client reads first per `function ne()`).
4. Restart the backend. No client-side change required.

**Why this works:** the client's budgeting logic
(`function We() → Math.ceil(S/CHARS_PER_TOKEN) → He()`) reads the
server-reported `max_model_len` and fits `input + tools + max_tokens`
inside it. Once the server advertises a higher limit, the client sends
smaller `max_tokens` and stops overflowing.

### A2. Tool-stripping proxy (alternative)

If raising `max_model_len` isn't possible (VRAM, KV-cache), do this in the
gateway's `/v1/chat/completions` handler:

```python
# pseudo-fix (FastAPI middleware)
async def cap_tools_for_model(request: ChatRequest, model_meta: ModelMeta):
    # 1. Estimate tokens in tools using the same heuristic the client uses
    tool_chars = sum(len(json.dumps(t)) for t in (request.tools or []))
    tool_tokens = math.ceil(tool_chars / CHARS_PER_TOKEN)   # ~4 chars/token

    # 2. Read model context from admin-configured limits
    ctx = model_meta.max_input_tokens or model_meta.context_window

    # 3. If tools alone exceed the budget, drop them with a clear warning
    if tool_tokens >= ctx - MIN_OUTPUT_TOKENS:
        log.warning("dropping %d tools for %s — tool overhead %d >= context %d",
                    len(request.tools), request.model, tool_tokens, ctx)
        request.tools = None
        return request

    # 4. If tools + estimated input exceed budget, drop lowest-priority tools
    #    (priority can come from tool name prefixes, e.g. mcp_* last)
    ...
```

Even simpler immediate fix: when a request would overflow, **return a 400
with the same hint the client already understands** — `context length of
only 192000 tokens` — and the client will surface a clean error rather
than the truncated "responses will be cut off" path. But this is a
band-aid; the proper fix is A1.

### A3. Client-side mitigation (independent)

Until the gateway fix lands, the immediate user-side mitigation is to
reduce the **Copilot tool catalog** so input fits. The user just wired
`agentmemory` (54 tools) + `semble` (2 tools) into VS Code Copilot Chat,
which pushed the catalog from ~30 → ~87 tools. Removing them returns
~12K–15K of overhead per request. That is done in
`~/Library/Application Support/Code/User/mcp.json` by deleting the
`agentmemory` entry. Not part of the gateway-side fix.

---

## Bug B — `minimax` empty `parameters`: recommended fix

### B1. Sanitise in the proxy (the only safe place)

Add a transform in the OpenAI-compat chat-completions handler that runs
**before forwarding to the upstream**:

```python
def normalize_tool_params(tools: list[dict] | None) -> list[dict] | None:
    if not tools:
        return tools
    EMPTY = {"type": "object", "properties": {}}
    for t in tools:
        fn = t.get("function") or {}
        p = fn.get("parameters")
        if not p or not isinstance(p, dict) or not p.get("properties"):
            # Treat no-arg tools as accepting an empty object — the
            # standard OpenAI convention.
            fn["parameters"] = EMPTY
        # Strictly required: strip additionalProperties:[], etc, that
        # vLLM rejects. Keep this conservative.
    return tools
```

**Why this is the right layer:** the client is correct to pass
`parameters: i.inputSchema` straight through (OpenAI allows it); the
backend is overly strict; sanitising in the proxy is the lowest-risk fix
and benefits every OpenAI-compatible client, not just this extension.

### B2. Or, accept empty `parameters` in the upstream

If `minimax` is a vLLM deployment, look for the OpenAI tool parser and
loosen it to accept `{}`. That's upstream-side though — the proxy fix is
easier and doesn't require restarting model servers.

---

## Suggested order of work

1. **Fix B first** (one-line transform, ~30 minutes, zero risk — eliminates
   ~13% of errors immediately and benefits every OpenAI-compatible client).
2. **Fix A1** (config change + restart, ~1 hour, eliminates ~78% of
   errors).
3. **(Optional) Fix A2** if A1 is blocked by VRAM.
4. Verify by reloading the Copilot session and tailing the gateway log
   for one full work day.

## Verification steps (post-fix)

After deploying, the gateway team can confirm by:

1. **Trigger an `agentmemory` MCP** request from VS Code (anything that
   forces a tool call) and watch the gateway log. Look for:
   - No more `400 invalid params, function parameters is empty (2013)`.
   - No more `400 Input tokens exceed the configured limit of 192000`.
2. **Hit `/v1/models` and check the metadata** — `free-bai` should now
   report a context window that matches the model's training context:
   ```bash
   curl -ksS -H "Authorization: Bearer $KEY" \
     https://gw.greenhome.net/v1/models | jq '.data[] | select(.id | test("free-bai"))'
   ```
3. **Run the existing `/admin/benchmarks/tool-eval`** suite — it should
   show green on tool calls against both `free-bai` and `minimax`.
4. **Optional: bench a 250K-token tool-heavy request** before declaring
   done. The `curl` shape to send is in [the extension's source](
   https://github.com/arbs-io/github-copilot-llm-gateway) — `function Xe`
   builds the exact body the gateway sees.

## What we (Copilot side) will do in parallel

While the gateway team works on these, we will:

- Remove `agentmemory` from the **Copilot-only** `mcp.json` (keep it for
  Claude Code) to claw back ~12K tokens of tool overhead per request.
- Set `github.copilot.llm-gateway.modelContextWindows` per model in VS
  Code settings so the client budgets conservatively until the gateway
  advertises the new limits.
- Watch the `1-GitHub Copilot LLM Gateway.log` for the error rate to drop.

## Files / endpoints the dev team should look at first

| Endpoint | Why |
|---|---|
| `https://gw.greenhome.net/admin/providers` | List of model aliases + their upstream targets |
| `https://gw.greenhome.net/admin/providers/inventory` | Inventory view of model metadata |
| `https://gw.greenhome.net/admin/route-policies/models` | Per-model routing / context policies |
| `https://gw.greenhome.net/admin/benchmarks/tool-eval` | Tool-calling benchmark — ideal regression test |
| `https://gw.greenhome.net/admin/mcp-servers` | If they proxy any MCP servers, this is where the tool-schema sanitiser would slot in |
| `/v1/models` (data plane, port 3000/443) | The endpoint whose `max_model_len`/`context_length` the client reads |

## Contact

The user (`anhl`) is on the client side and can supply additional logs on
request. The repo at `local-ai-ebook` already has the probe scripts and
log-parsing notes; if the dev team needs raw log slices, point them at
`docs/copilot-mcp-ops.md` and the `1-GitHub Copilot LLM Gateway.log`
files under `~/Library/Application Support/Code/logs/`.