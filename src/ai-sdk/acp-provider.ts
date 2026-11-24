import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import {
  NoSuchModelError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3Message,
  type LanguageModelV3Prompt,
  type LanguageModelV3StreamPart,
  type LanguageModelV3Usage,
  type ProviderV3,
} from "@ai-sdk/provider";
import {
  buildToolSystemPrefix,
  formatToolResults,
  parseToolCalls,
  type ParseResult,
  type ToolResultInput,
  type ToolSpec,
} from "../tools/protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLI_PATH = path.resolve(__dirname, "..", "cli.js");

export interface AlexaAcpProviderOptions {
  /** Provider id reported to AI SDK / OpenCode (default: "alexa-acp") */
  name?: string;
  /** Command to spawn the ACP server (default: process.execPath) */
  command?: string;
  /** Arguments to spawn the ACP server (default: ["<dist/cli.js>", "acp"]) */
  args?: string[];
  /** Working directory passed to ACP session/new (default: process.cwd()) */
  cwd?: string;
  /** Environment overrides for the ACP server subprocess */
  env?: Record<string, string>;
  /** Optional custom cookies.json path */
  cookiesPath?: string;
  /** Optional custom initial tool-bridge prompt template (supports {{tools}}, {{cwd}}, {{dir}}) */
  toolPrompt?: string;
  /** Optional in-process ACP AgentApp (used for tests without spawning a subprocess) */
  inProcessApp?: acp.AgentApp;
}

interface TrackedAcpSession {
  sessionId: string;
  messageCount: number;
  lastUsedAt: number;
}

function zeroUsage(): LanguageModelV3Usage {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
}

function hashMessages(messages: LanguageModelV3Prompt): string {
  const h = crypto.createHash("sha256");
  for (const m of messages) {
    // Skip system messages because harnesses like OpenCode inject dynamic timestamps/git reminders between turns.
    if (m.role === "system") continue;
    h.update(m.role);
    h.update(":");
    for (const p of m.content) {
      if (p.type === "text") {
        const cleaned = stripHarnessXmlNoise(p.text);
        if (cleaned) {
          h.update("text:");
          h.update(cleaned);
        }
      } else if (p.type === "tool-call") {
        // Match by toolCallId + toolName (stable across AI SDK / OpenCode serialization)
        h.update(`tc:${p.toolCallId}:${p.toolName}`);
      } else if (p.type === "tool-result") {
        h.update(`tr:${p.toolCallId}:${p.toolName}`);
      }
    }
    h.update("\n---\n");
  }
  return h.digest("hex");
}

function extractTools(options: LanguageModelV3CallOptions): ToolSpec[] {
  const tools = options.tools;
  if (!Array.isArray(tools)) return [];
  const specs: ToolSpec[] = [];
  for (const t of tools) {
    if (t.type === "function") {
      specs.push({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
      });
    }
  }
  return specs;
}

function stringifyToolOutput(output: unknown): { text: string; isError: boolean } {
  if (output && typeof output === "object" && "type" in output) {
    const o = output as { type: string; value?: unknown; reason?: string };
    if (o.type === "text") return { text: String(o.value ?? ""), isError: false };
    if (o.type === "json") return { text: JSON.stringify(o.value ?? null), isError: false };
    if (o.type === "error-text") return { text: String(o.value ?? ""), isError: true };
    if (o.type === "error-json") return { text: JSON.stringify(o.value ?? null), isError: true };
    if (o.type === "execution-denied") return { text: o.reason || "Execution denied", isError: true };
    if (o.type === "content" && Array.isArray(o.value)) {
      const txt = o.value
        .map((part: Record<string, unknown>) =>
          part.type === "text" ? String(part.text ?? "") : `[${String(part.type ?? "part")}]`
        )
        .join("\n");
      return { text: txt, isError: false };
    }
  }
  return { text: typeof output === "string" ? output : JSON.stringify(output ?? ""), isError: false };
}

function stripHarnessXmlNoise(text: string): string {
  return text
    .replace(/<system_instructions>[\s\S]*?<\/system_instructions>/gi, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderMessageToText(msg: LanguageModelV3Message): string {
  if (msg.role === "system") return msg.content;
  if (msg.role === "user") {
    const raw = msg.content
      .map((p) => (p.type === "text" ? p.text : `[File: ${p.mediaType}]`))
      .join("\n")
      .trim();
    return stripHarnessXmlNoise(raw);
  }
  if (msg.role === "assistant") {
    const parts: string[] = [];
    for (const p of msg.content) {
      if (p.type === "text" && p.text) parts.push(p.text);
      else if (p.type === "tool-call") {
        const kv =
          p.input && typeof p.input === "object"
            ? Object.entries(p.input as Record<string, unknown>)
                .map(([k, v]) => {
                  const s = typeof v === "string" ? v : JSON.stringify(v);
                  const clipped = s && s.length > 80 ? `[${s.length} chars]` : s;
                  return `${k}=${clipped}`;
                })
                .join(" ")
            : "";
        parts.push(`Saved via ${p.toolName}${kv ? ` (${kv})` : ""}`);
      }
    }
    return parts.join("\n").trim();
  }
  if (msg.role === "tool") {
    const results: ToolResultInput[] = [];
    for (const p of msg.content) {
      if (p.type === "tool-result") {
        const { text, isError } = stringifyToolOutput(p.output);
        results.push({ toolCallId: p.toolCallId, name: p.toolName, output: text, isError });
      }
    }
    return formatToolResults(results);
  }
  return "";
}

function buildInitialPrompt(
  prompt: LanguageModelV3Prompt,
  tools: ToolSpec[],
  cwd: string,
  toolPrompt?: string
): string {
  const systemParts: string[] = [];
  const turns: string[] = [];

  for (const msg of prompt) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
    } else if (msg.role === "user") {
      turns.push(`User:\n${renderMessageToText(msg)}`);
    } else if (msg.role === "assistant") {
      const t = renderMessageToText(msg);
      if (t) turns.push(`Assistant:\n${t}`);
    } else if (msg.role === "tool") {
      turns.push(renderMessageToText(msg));
    }
  }

  const systemText = systemParts.join("\n\n").trim();
  const body = turns.length === 1 && turns[0].startsWith("User:\n")
    ? turns[0].slice("User:\n".length)
    : turns.join("\n\n");

  const prefix = buildToolSystemPrefix(tools, systemText, cwd, toolPrompt);
  if (prefix) {
    return `${prefix}\n\nRequest: ${body}`;
  }
  return body;
}

function buildDeltaPrompt(newMessages: LanguageModelV3Message[]): string {
  const parts: string[] = [];
  for (const msg of newMessages) {
    if (msg.role === "tool") {
      parts.push(renderMessageToText(msg));
    } else if (msg.role === "user") {
      parts.push(renderMessageToText(msg));
    } else if (msg.role === "assistant") {
      const t = renderMessageToText(msg);
      if (t) parts.push(`Previous assistant turn:\n${t}`);
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

/**
 * Persistent ACP client transport shared across language model calls in a provider instance.
 */
export class AcpClientBridge {
  private readonly options: AlexaAcpProviderOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private conn: acp.ClientConnection | null = null;
  private initPromise: Promise<acp.ClientConnection> | null = null;
  private sessionUpdateListeners = new Map<string, (update: acp.SessionUpdate) => void>();
  private trackedSessions = new Map<string, TrackedAcpSession>();

  constructor(options: AlexaAcpProviderOptions = {}) {
    this.options = options;
  }

  async ensureConnected(): Promise<acp.ClientConnection> {
    if (this.conn && !this.conn.signal.aborted) {
      return this.conn;
    }
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.connectInternal().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async connectInternal(): Promise<acp.ClientConnection> {
    const clientApp = acp
      .client({ name: "opencode-alexa-acp-client" })
      .onNotification("session/update", ({ params }) => {
        const listener = this.sessionUpdateListeners.get(params.sessionId);
        if (listener) listener(params.update);
      });

    let conn: acp.ClientConnection;
    if (this.options.inProcessApp) {
      conn = clientApp.connect(this.options.inProcessApp);
    } else {
      const command = this.options.command || process.env.ALEXA_NODE_BIN || "node";
      const args = this.options.args || [DEFAULT_CLI_PATH, "acp"];
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...(this.options.env || {}),
      };
      if (this.options.cookiesPath) {
        env.ALEXA_COOKIES_PATH = this.options.cookiesPath;
      }

      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
      let stderrBuf = "";
      child.stderr.on("data", (chunk) => {
        stderrBuf = (stderrBuf + String(chunk)).slice(-2000);
      });
      child.on("exit", (code) => {
        if (code && stderrBuf) {
          console.error(`[alex-coding-acp] ACP subprocess exited (${code}): ${stderrBuf.trim()}`);
        }
        if (this.child === child) {
          this.child = null;
          this.conn = null;
          this.trackedSessions.clear();
        }
      });
      this.child = child;

      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
      );
      conn = clientApp.connect(stream);
    }

    await conn.agent.request("initialize", {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "alexa-acp-ai-sdk", version: "0.1.0" },
      clientCapabilities: {},
    });

    this.conn = conn;
    return conn;
  }

  async runTurn(params: {
    prompt: LanguageModelV3Prompt;
    tools: ToolSpec[];
    mode: "passthrough" | "chat";
    abortSignal?: AbortSignal;
    onThought?: (text: string) => void;
    onRawTextDelta?: (text: string) => void;
  }): Promise<{
    rawText: string;
    parsed: ParseResult;
    thoughts: string;
    sessionId: string;
  }> {
    const conn = await this.ensureConnected();
    const cwd = this.options.cwd || process.cwd();

    // Try to find an existing ACP session whose stored prefix matches an earlier slice of prompt.
    let matchedSession: TrackedAcpSession | null = null;
    let matchedPrefixLen = 0;

    for (let len = params.prompt.length - 1; len >= 1; len--) {
      const prefixHash = hashMessages(params.prompt.slice(0, len));
      const found = this.trackedSessions.get(prefixHash);
      if (found) {
        matchedSession = found;
        matchedPrefixLen = len;
        break;
      }
    }

    let sessionId: string;
    let queryText: string;

    if (matchedSession) {
      sessionId = matchedSession.sessionId;
      matchedSession.lastUsedAt = Date.now();
      queryText = buildDeltaPrompt(params.prompt.slice(matchedPrefixLen));
    } else {
      const created = await conn.agent.request("session/new", {
        cwd,
        mcpServers: [],
        _meta: { mode: params.mode },
      });
      sessionId = created.sessionId;
      queryText = buildInitialPrompt(params.prompt, params.tools, cwd, this.options.toolPrompt);
    }

    let rawText = "";
    let thoughts = "";

    const onAbort = () => {
      void conn.agent.notify("session/cancel", { sessionId }).catch(() => {});
    };
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });

    this.sessionUpdateListeners.set(sessionId, (update) => {
      if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
        thoughts += update.content.text;
        params.onThought?.(update.content.text);
      } else if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        rawText += update.content.text;
        params.onRawTextDelta?.(update.content.text);
      }
    });

    try {
      const promptRes = await conn.agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: queryText }],
      });
      const metaFullText = promptRes?._meta?.fullText;
      if (typeof metaFullText === "string" && metaFullText.length > 0) {
        rawText = metaFullText;
      }
    } finally {
      this.sessionUpdateListeners.delete(sessionId);
      params.abortSignal?.removeEventListener("abort", onAbort);
    }

    // Track the post-turn conversation hash so the next turn reuses this ACP session!
    // We also store the current prompt hash so retries / assistant-appended hashes can match.
    const parsed =
      params.tools.length > 0
        ? parseToolCalls(rawText, params.tools, cwd)
        : { visibleText: rawText, toolCalls: [] };
    const assistantContent: Array<
      | { type: "text"; text: string }
      | { type: "tool-call"; toolCallId: string; toolName: string; input: Record<string, unknown> }
    > = [];
    if (parsed.visibleText) {
      assistantContent.push({ type: "text", text: parsed.visibleText });
    }
    for (const tc of parsed.toolCalls) {
      assistantContent.push({
        type: "tool-call",
        toolCallId: tc.id,
        toolName: tc.name,
        input: tc.arguments,
      });
    }

    const withAssistant: LanguageModelV3Prompt = [
      ...params.prompt,
      { role: "assistant", content: assistantContent },
    ];
    this.trackedSessions.set(hashMessages(withAssistant), {
      sessionId,
      messageCount: withAssistant.length,
      lastUsedAt: Date.now(),
    });
    // Also index rawText-only assistant form in case a client strips reasoning/empty blocks
    if (parsed.toolCalls.length === 0 && rawText !== parsed.visibleText) {
      const withRaw: LanguageModelV3Prompt = [
        ...params.prompt,
        { role: "assistant", content: [{ type: "text", text: rawText }] },
      ];
      this.trackedSessions.set(hashMessages(withRaw), {
        sessionId,
        messageCount: withRaw.length,
        lastUsedAt: Date.now(),
      });
    }

    // Keep session cache bounded
    if (this.trackedSessions.size > 64) {
      const oldestKey = [...this.trackedSessions.entries()].sort(
        (a, b) => a[1].lastUsedAt - b[1].lastUsedAt
      )[0]?.[0];
      if (oldestKey) this.trackedSessions.delete(oldestKey);
    }

    return { rawText, parsed, thoughts, sessionId };
  }

  dispose(): void {
    this.conn?.close();
    this.conn = null;
    this.child?.kill("SIGTERM");
    this.child = null;
    this.trackedSessions.clear();
  }
}

class AlexaAcpLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls = {};

  private readonly bridge: AcpClientBridge;
  private readonly mode: "passthrough" | "chat";

  constructor(provider: string, modelId: string, bridge: AcpClientBridge) {
    this.provider = provider;
    this.modelId = modelId;
    this.bridge = bridge;
    this.mode = modelId.includes("chat") ? "chat" : "passthrough";
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const tools = extractTools(options);
    const { parsed, thoughts } = await this.bridge.runTurn({
      prompt: options.prompt,
      tools,
      mode: this.mode,
      abortSignal: options.abortSignal,
    });

    const content: LanguageModelV3Content[] = [];

    if (thoughts.trim()) {
      content.push({ type: "reasoning", text: thoughts.trim() });
    }
    if (parsed.visibleText) {
      content.push({ type: "text", text: parsed.visibleText });
    }
    for (const tc of parsed.toolCalls) {
      content.push({
        type: "tool-call",
        toolCallId: tc.id,
        toolName: tc.name,
        input: tc.rawArguments,
      });
    }

    return {
      content,
      finishReason: {
        unified: parsed.toolCalls.length > 0 ? "tool-calls" : "stop",
        raw: "end_turn",
      },
      usage: zeroUsage(),
      warnings: [],
    };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV3StreamPart>;
  }> {
    const tools = extractTools(options);
    const bridge = this.bridge;
    const mode = this.mode;
    const modelId = this.modelId;

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        const textId = `txt_${crypto.randomBytes(4).toString("hex")}`;
        const reasoningId = `rsn_${crypto.randomBytes(4).toString("hex")}`;
        let reasoningStarted = false;
        let textStarted = false;
        let streamingTextAllowed = tools.length === 0;
        let bufferedRaw = "";
        let emittedTextLen = 0;

        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({
          type: "response-metadata",
          id: `resp_${crypto.randomBytes(6).toString("hex")}`,
          timestamp: new Date(),
          modelId,
        });

        try {
          const { parsed } = await bridge.runTurn({
            prompt: options.prompt,
            tools,
            mode,
            abortSignal: options.abortSignal,
            onThought: (chunk) => {
              if (!reasoningStarted) {
                reasoningStarted = true;
                controller.enqueue({ type: "reasoning-start", id: reasoningId });
              }
              controller.enqueue({ type: "reasoning-delta", id: reasoningId, delta: chunk });
            },
            onRawTextDelta: (chunk) => {
              bufferedRaw += chunk;
              if (reasoningStarted) {
                controller.enqueue({ type: "reasoning-end", id: reasoningId });
                reasoningStarted = false;
              }
              // When tools are enabled, keep a small tail holdback so partial marker prefixes
              // like "Text for" or "RUN_TOOL" never leak before being parsed into tool calls.
              const maybeToolMarker =
                /(?:^|\n)\s*(?:\*\*)?(?:Text(?:\s+for)?|SAVE_FILE|RUN_TOOL|\[\[TOOL_CALL|<tool_call|```tool_call)/i.test(
                  bufferedRaw
                );
              if (streamingTextAllowed) {
                if (!textStarted) {
                  textStarted = true;
                  controller.enqueue({ type: "text-start", id: textId });
                }
                controller.enqueue({ type: "text-delta", id: textId, delta: chunk });
                emittedTextLen = bufferedRaw.length;
              } else if (!maybeToolMarker) {
                const safeEnd = Math.max(emittedTextLen, bufferedRaw.length - 16);
                if (safeEnd > emittedTextLen) {
                  const safeSlice = bufferedRaw.slice(emittedTextLen, safeEnd);
                  if (!textStarted) {
                    textStarted = true;
                    controller.enqueue({ type: "text-start", id: textId });
                  }
                  controller.enqueue({ type: "text-delta", id: textId, delta: safeSlice });
                  emittedTextLen = safeEnd;
                }
              }
            },
          });

          if (reasoningStarted) {
            controller.enqueue({ type: "reasoning-end", id: reasoningId });
            reasoningStarted = false;
          }

          // Flush any unemitted visible text
          const remaining = parsed.visibleText.slice(emittedTextLen);
          if (remaining) {
            if (!textStarted) {
              textStarted = true;
              controller.enqueue({ type: "text-start", id: textId });
            }
            controller.enqueue({ type: "text-delta", id: textId, delta: remaining });
          }

          if (textStarted) {
            controller.enqueue({ type: "text-end", id: textId });
            textStarted = false;
          }

          for (const tc of parsed.toolCalls) {
            controller.enqueue({
              type: "tool-input-start",
              id: tc.id,
              toolName: tc.name,
            });
            controller.enqueue({
              type: "tool-input-delta",
              id: tc.id,
              delta: tc.rawArguments,
            });
            controller.enqueue({
              type: "tool-input-end",
              id: tc.id,
            });
            controller.enqueue({
              type: "tool-call",
              toolCallId: tc.id,
              toolName: tc.name,
              input: tc.rawArguments,
            });
          }

          controller.enqueue({
            type: "finish",
            finishReason: {
              unified: parsed.toolCalls.length > 0 ? "tool-calls" : "stop",
              raw: "end_turn",
            },
            usage: zeroUsage(),
          });
          controller.close();
        } catch (err) {
          controller.enqueue({ type: "error", error: err });
          controller.close();
        }
      },
    });

    return { stream };
  }
}

export interface AlexaAcpProvider extends ProviderV3 {
  (modelId: string): LanguageModelV3;
  chatModel(modelId: string): LanguageModelV3;
  dispose(): void;
}

export function createAlexaAcp(options: AlexaAcpProviderOptions = {}): AlexaAcpProvider {
  const providerName = options.name || "alexa-acp";
  const bridge = new AcpClientBridge(options);

  const createModel = (modelId: string): LanguageModelV3 =>
    new AlexaAcpLanguageModel(providerName, modelId, bridge);

  const provider = Object.assign(
    (modelId: string) => createModel(modelId),
    {
      specificationVersion: "v3" as const,
      languageModel: createModel,
      chatModel: createModel,
      embeddingModel(modelId: string): never {
        throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
      },
      imageModel(modelId: string): never {
        throw new NoSuchModelError({ modelId, modelType: "imageModel" });
      },
      dispose() {
        bridge.dispose();
      },
    }
  );

  return provider;
}

export const alexaAcp = createAlexaAcp();
export default createAlexaAcp;
