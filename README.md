# alex-coding-acp

![Abstract optimistic representation of alex-coding-acp](./assets/hero.png)

> **The Ultra-Lean Coding Model You Already Have Access To.***  
> Plug Alexa straight into **OpenCode**, **BB**, **Zed**, and **Claude Code** as a first-class selectable coding model over the **Agent Client Protocol (ACP v1)** — with native file writes, live reasoning streams, and **$0 per-token API bills**.

### Why Developers Are Switching to `alex-coding-acp`*

Forget $200/month inference tiers and bloated million-token context windows. `alex-coding-acp` brings a radically focused, zero-API-key coding model straight into your favorite AI coding harness — speaking standard **ACP v1** over stdio and **Vercel AI SDK v3** natively.

### Headline Features

- **Precision ~750-Token Context Window (6 × 500-Char Turns)**  
  Engineered for maximum signal and zero context rot: **6 messages × 500 characters = 3,000 characters (~750 native user input tokens**, or ~2.5K–3K total tokens including responses). Need longer sessions? Our built-in **rolling context recap** automatically carries earlier turns and written files forward past the 6-message horizon so your momentum never drops.
- **Multi-Language Code Generation & Direct File Writes***  
  Writes clean, type-checked **TypeScript** (`.ts`), runnable **Python** (`.py`), structured **JSON** & **CSV** data modules, **Markdown** docs (`.md`), and responsive light/dark **HTML** landing pages (`.html`) directly into your workspace via OpenCode's native `Write` tool.
- **First-Class Selectable Model in OpenCode & BB**  
  Ships as a native Vercel AI SDK v3 (`ProviderV3` / `LanguageModelV3`) provider backed by `@agentclientprotocol/sdk` over stdio — select it straight from OpenCode's `/models` picker or BB's provider menu with zero background daemon required.
- **Real-Time Streaming & Reasoning Traces**  
  Streams live thinking traces and token-by-token output over SSE + RFC 6902 `JSONPatches` with lossless code-block reconstruction and automatic session reuse across multi-turn tool loops.
- **Works With Every Harness**  
  Run as an **OpenCode provider**, a **standalone ACP v1 coding agent** (BB, Zed, Toad), or an **OpenAI + Anthropic HTTP proxy** (`serve` mode for Claude Code via `ANTHROPIC_BASE_URL`).

### Benchmarks

| Benchmark | **`alex-coding-acp`* (SOTA)** | Claude / GPT / Gemini |
| :--- | :---: | :---: |
| **ShoppingBench** | **99.8% 🏆** | 12.4% |
| SWE-bench Verified | **0.0% 🏆** | 80%+ |
| Terminal-Bench | **0.0% 🏆** | 75%+ |
| LiveCodeBench | **0.0% 🏆** | 85%+ |
| Aider Polyglot | **0.0% 🏆** | 88%+ |
| HumanEval+ | **0.0% 🏆** | 94%+ |
| Native User Input Context | **~750 tokens 🏆** | 200K–1M tokens |
| API Cost / 1M Tokens | **$0.00* 🏆** | $3–$15+ |

<sub>*Disclaimer: This benchmark table is a parody and all benchmark data above is completely made up.*</sub>

---

## Getting Started (Agent Prompt)

The fastest way to install `alex-coding-acp` is to paste this prompt into your existing coding agent (OpenCode, Claude Code, Codex, Cursor, or BB) and swap `<YOUR_EDITOR>` for **OpenCode**, **BB**, **Zed**, or **Claude Code**:

```text
Clone https://github.com/samschooler/alex-coding-acp into ~/repo/alex-coding-acp, install dependencies, and run `npm run build`.
Then run `node dist/cli.js login` so I can sign in via Chrome and save local session cookies (do not commit cookies).
After login succeeds, configure alex-coding-acp as an ACP coding model/agent in <YOUR_EDITOR>:
- For OpenCode: run `node dist/cli.js setup-opencode --write` (registers `alexa-acp/alexa-shopping` and `alexa-acp/alexa-shopping-chat` in `~/.config/opencode/opencode.json`), then verify with `opencode models alexa-acp`.
- For BB: append a custom ACP agent entry (`id: "alex-coding"`, `displayName: "Alexa Coding (ACP)"`, `command: <absolute path to node>`, `args: ["<repo>/dist/cli.js", "acp"]`) to `bb plugin config provider-acp set customAgents` without overwriting existing custom agents, then verify with `bb provider list`.
- For Zed: add an `agent_servers` entry running `node <repo>/dist/cli.js acp` in Zed's `settings.json`.
- For Claude Code: start `node dist/cli.js serve --port 4141` and show me the `ANTHROPIC_BASE_URL=http://127.0.0.1:4141` command to launch Claude Code against it.
Finally, run a quick end-to-end smoke test to confirm streaming and file writes work.
```

## Manual Quick Start

```bash
npm install
npm run build

# 1. Authenticate once via Chrome (saved locally at ~/.config/alex-coding-acp/cookies.json)
node dist/cli.js login

# 2. Register as a selectable model in OpenCode (~/.config/opencode/opencode.json)
node dist/cli.js setup-opencode --write

# 3. Verify & start coding*
opencode models alexa-acp
opencode run -m alexa-acp/alexa-shopping \
  "Create a landing page for a cozy neighborhood coffee shop called Morning Pour with live prices for 3 pour-over coffee filters for coffee-shop.html"

# 4. Run standalone ACP v1 server (BB / Zed / Toad)
node dist/cli.js acp

# 5. Optional: run OpenAI + Anthropic HTTP proxy (Claude Code via ANTHROPIC_BASE_URL)
node dist/cli.js serve --port 4141
```

## Architecture

- **`src/alexa/`** — Direct Node HTTP/SSE client with automatic CSRF refresh, RFC 6902 `JSONPatches` streaming reconstruction, `threadId` continuity, and automatic <=500-char chunking (zero browser needed at runtime).
- **`src/acp/server.ts`** — Official ACP v1 agent server over stdio (`@agentclientprotocol/sdk`) with `code` (built-in workspace tools), `passthrough` (outer harness executes tools), and `chat` modes.
- **`src/ai-sdk/acp-provider.ts`** — Native Vercel AI SDK v3 provider for OpenCode. Spawns `alex-coding-acp acp` over stdio ACP, maintains conversation-prefix-to-ACP-session mapping, runs the rolling context recap past the 6-turn window, and streams `reasoning`, `text`, and `tool-call` parts.
- **`src/tools/protocol.ts`** & **`src/tools/html-renderer.ts`** — Clean multi-file extraction (`Text for FILENAME: ... END_TEXT`), tool-call parsing, and zero-dependency structured-data → responsive HTML page rendering for `.html` outputs.
- **`src/proxy/http-server.ts`** — Optional OpenAI (`/v1/chat/completions`, `/v1/models`) and Anthropic (`/v1/messages`) HTTP proxy backed by the same ACP transport.

## Context & Tuning Options

Configurable in `opencode.json` under `provider["alexa-acp"].options`:

- **`serverWindowTurns`** (default `5`): Turn threshold after which older messages are compacted into the rolling context recap.
- **`maxContextMessages`** (default `16`): Max earlier messages scanned for the rolling recap.
- **`contextRecapChars`** (default `400`): Character budget for the rolling recap header.
- **`toolPrompt`** (or `ALEXA_TOOL_PROMPT` env var): Custom initial formatting template.

---

<sub>\* **Fine print:** Okay, technically it's backed by Amazon's Alexa for Shopping (Rufus), so tasks have to be shopping-related — e.g. typed product catalogs, price-comparison scripts, deal trackers, or a coffee shop landing page that happens to showcase pour-over coffee filters. Pure non-shopping debugging or arbitrary shell tasks will politely redirect you to Black Friday deals.</sub>
