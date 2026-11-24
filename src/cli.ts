#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAcpStdioServer } from "./acp/server.js";
import { AlexaClient } from "./alexa/client.js";
import { runChromeLogin } from "./alexa/login.js";
import { startProxyServer } from "./proxy/http-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function printHelp(): void {
  console.error(`alex-coding-acp — Amazon Alexa for Shopping ACP server & OpenCode AI SDK provider

Usage:
  alex-coding-acp acp                     Start ACP v1 agent server on stdio
  alex-coding-acp login [--port 9223]     Open Chrome to sign in to Amazon & save cookies
  alex-coding-acp serve [--port 4141]     Start OpenAI + Anthropic HTTP proxy backed by ACP
  alex-coding-acp chat <prompt...>        Send a quick one-shot prompt to Alexa
  alex-coding-acp setup-opencode [--write] Print (or write) OpenCode provider config
`);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp();
    process.exit(0);
  }

  if (cmd === "acp") {
    const modeArg = getFlagValue(args, "--mode") as "code" | "passthrough" | "chat" | undefined;
    await runAcpStdioServer({ defaultMode: modeArg || "code" });
    return;
  }

  if (cmd === "login") {
    const port = Number(getFlagValue(args, "--port") || 9223);
    const saved = await runChromeLogin({ port });
    console.log(`Logged in! Cookies saved to ${saved}`);
    return;
  }

  if (cmd === "serve") {
    const port = Number(getFlagValue(args, "--port") || 4141);
    const host = getFlagValue(args, "--host") || "127.0.0.1";
    const { url } = await startProxyServer({ port, host });
    console.error(`alex-coding-acp HTTP proxy listening on ${url}`);
    console.error(`  OpenAI API:    ${url}/v1/chat/completions`);
    console.error(`  Anthropic API: ${url}/v1/messages`);
    return;
  }

  if (cmd === "chat") {
    const query = args.join(" ").trim();
    if (!query) {
      console.error("Usage: alex-coding-acp chat <prompt...>");
      process.exit(1);
    }
    const client = new AlexaClient();
    for await (const ev of client.streamPrompt({ query, includeProductCards: true })) {
      if (ev.type === "thought") {
        process.stderr.write(`[thinking] ${ev.text}\n`);
      } else if (ev.type === "text_delta") {
        process.stdout.write(ev.text);
      } else if (ev.type === "cards") {
        process.stdout.write(`\n\n${ev.markdown}\n`);
      }
    }
    process.stdout.write("\n");
    return;
  }

  if (cmd === "setup-opencode") {
    const snippet = {
      "alexa-acp": {
        npm: `file://${REPO_ROOT}`,
        name: "Alexa Shopping (ACP)",
        models: {
          "alexa-shopping": {
            name: "Alexa for Shopping (ACP)",
            tool_call: true,
            reasoning: true,
          },
          "alexa-shopping-chat": {
            name: "Alexa for Shopping Chat (with product cards)",
            tool_call: false,
            reasoning: true,
          },
        },
      },
    };

    if (args.includes("--write")) {
      const configPath = path.join(os.homedir(), ".config", "opencode", "opencode.json");
      const current = fs.existsSync(configPath)
        ? (JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>)
        : { $schema: "https://opencode.ai/config.json" };
      const providers = ((current.provider as Record<string, unknown>) || {}) as Record<string, unknown>;
      providers["alexa-acp"] = snippet["alexa-acp"];
      current.provider = providers;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(current, null, 2) + "\n");
      console.log(`Updated ${configPath} with provider "alexa-acp".`);
    } else {
      console.log(JSON.stringify({ provider: snippet }, null, 2));
    }
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
