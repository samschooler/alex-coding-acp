# alex-coding-acp

Amazon **Alexa for Shopping** (Rufus) client, **Agent Client Protocol (ACP v1)** server, and **OpenCode / Vercel AI SDK v3** ACP provider.

## Architecture

- **`src/alexa/`** — Direct Node HTTP/SSE client for Amazon's `/rufus/cl/render` (auto-fetches `anti-csrftoken-a2z` & `impressionsContextKey`) and `/rufus/cl/streaming` (`text/event-stream` with RFC 6902 `JSONPatches` markdown/product-card reconstruction, `interim` thinking stream, `threadId` continuity, and automatic <=500-char chunking).
- **`src/acp/server.ts`** — Official ACP v1 agent server over stdio (`@agentclientprotocol/sdk`) with three modes:
  - `code` — exposes built-in workspace coding tools (`read_file`, `write_file`, `edit_file`, `list_files`, `grep`, `bash`) to Alexa.
  - `passthrough` — streams raw Alexa thoughts & responses over ACP so an outer harness (like OpenCode) executes its own tool suite.
  - `chat` — direct Alexa for Shopping conversation including structured Amazon product cards.
- **`src/ai-sdk/acp-provider.ts`** — Native Vercel AI SDK v3 (`ProviderV3` / `LanguageModelV3`) provider for OpenCode (`npm: "file:///.../alex-coding-acp"`). Spawns `alex-coding-acp acp` over stdio ACP, maintains conversation-prefix-to-ACP-session mapping, passes OpenCode's tools via a WAF-safe tool protocol, and streams `reasoning`, `text`, and `tool-call` parts back to OpenCode.
- **`src/proxy/http-server.ts`** — Optional HTTP proxy (`serve`) exposing OpenAI (`/v1/chat/completions`, `/v1/models`) and Anthropic (`/v1/messages`) APIs backed by the same ACP transport.

## Usage

```bash
npm install
npm run build

# 1. Sign in to Amazon in Chrome and save session cookies (~/.config/alex-coding-acp/cookies.json)
node dist/cli.js login

# 2. Register in OpenCode (~/.config/opencode/opencode.json)
node dist/cli.js setup-opencode --write

# 3. Verify model appears in OpenCode
opencode models alexa-acp
opencode run -m alexa-acp/alexa-shopping "Best 65W USB-C GaN chargers under $40?"

# 4. Run standalone ACP server (used by BB / Zed / Toad)
node dist/cli.js acp

# 5. Optional: run OpenAI + Anthropic HTTP proxy (e.g. for Claude Code via ANTHROPIC_BASE_URL)
node dist/cli.js serve --port 4141
```

## Notes on Amazon's API Limits & Guardrails

1. **500-character per-turn query cap:** `/rufus/cl/streaming` mirrors `#rufus-text-area maxlength="500"` and silently drops longer queries; `AlexaClient` automatically chunks longer messages across turns on the same `threadId`.
2. **Natural file-drafting & `.html` showcase renderer:** Amazon's output sanitizer strips raw `<...>` HTML tags and Alexa's model refuses explicit script-execution triggers like `RUN_TOOL`. Instead, Alexa reliably drafts file content between `Text for FILENAME:` and `END_TEXT` (supporting `.md`, `.json`, `.csv`, `.ts`, `.py`, etc.), which the ACP provider automatically converts into native OpenCode `write` (or ACP `write_file`) tool calls. For `.html` targets, Alexa outputs a clean JSON product object (`{ title, subtitle, items }`) or Markdown and [html-renderer.ts](./src/tools/html-renderer.ts) renders it locally into a responsive standalone HTML showcase page. The initial prompt template can be customized via `options.toolPrompt` or `ALEXA_TOOL_PROMPT`.
3. **Server-side 6-turn sliding window:** Amazon's `threadId` retains roughly the last 6 user turns on the server. Once a conversation exceeds 5 user turns, [acp-provider.ts](./src/ai-sdk/acp-provider.ts) automatically prepends a compact rolling recap (`Earlier in this chat: ...`) of older turns from the host's history (configurable via `options.serverWindowTurns`, `options.maxContextMessages`, and `options.contextRecapChars`) and re-attaches the `Text for FILENAME:` format hint when a file is requested.
4. **Model scope:** Alexa for Shopping's backend model is fine-tuned and system-prompted strictly as an Amazon shopping assistant, so while OpenCode's tool definitions are passed to it and parsed cleanly when emitted, the model itself frequently declines non-shopping / local tool execution requests.
