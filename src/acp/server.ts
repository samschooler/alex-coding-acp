import crypto from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { AlexaClient } from "../alexa/client.js";
import {
  buildToolSystemPrefix,
  formatToolResults,
  parseToolCalls,
} from "../tools/protocol.js";
import {
  describeToolCall,
  executeWorkspaceTool,
  WORKSPACE_TOOL_SPECS,
} from "../tools/workspace-tools.js";

export type AlexaSessionMode = "code" | "passthrough" | "chat";

interface AcpSessionState {
  sessionId: string;
  cwd: string;
  mode: AlexaSessionMode;
  tabId: string;
  threadId: string | null;
  lastRequestId: string | null;
  amazonSessionId: string | null;
  turnCount: number;
  activeAbort: AbortController | null;
}

const AVAILABLE_MODES: acp.SessionMode[] = [
  {
    id: "code",
    name: "Alexa Coding Agent",
    description: "Exposes workspace file/search/shell tools to Alexa for Shopping.",
  },
  {
    id: "passthrough",
    name: "Passthrough (Host Tools)",
    description: "Streams directly to/from Alexa so an outer harness like OpenCode runs the tools.",
  },
  {
    id: "chat",
    name: "Alexa Shopping Chat",
    description: "Direct Alexa for Shopping conversation with Amazon product cards.",
  },
];

function stripHarnessXmlNoise(text: string): string {
  return text
    .replace(/<system_instructions>[\s\S]*?<\/system_instructions>/gi, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractPromptText(prompt: acp.ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of prompt) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "resource" && "text" in block.resource && typeof block.resource.text === "string") {
      parts.push(`[Resource ${block.resource.uri}]\n${block.resource.text}`);
    } else if (block.type === "resource_link") {
      parts.push(`[Link ${block.name}: ${block.uri}]`);
    }
  }
  return stripHarnessXmlNoise(parts.join("\n\n"));
}

export interface CreateAlexaAcpOptions {
  alexaClient?: AlexaClient;
  defaultMode?: AlexaSessionMode;
  maxToolSteps?: number;
}

export function createAlexaAcpApp(options: CreateAlexaAcpOptions = {}): acp.AgentApp {
  const alexa = options.alexaClient ?? new AlexaClient();
  const defaultMode: AlexaSessionMode = options.defaultMode ?? "code";
  const maxToolSteps = options.maxToolSteps ?? 12;

  const sessions = new Map<string, AcpSessionState>();
  let clientCapabilities: acp.ClientCapabilities | undefined;

  const app = acp
    .agent({ name: "alex-coding-acp" })
    .onRequest("initialize", async ({ params }) => {
      clientCapabilities = params.clientCapabilities;
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: {
          name: "alex-coding-acp",
          title: "Alexa Coding (ACP)",
          version: "0.1.0",
        },
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: {
            embeddedContext: true,
            image: false,
            audio: false,
          },
        },
      };
    })
    .onRequest("session/new", async ({ params }) => {
      const sessionId = `alexa_${crypto.randomUUID()}`;
      const requestedMode = (params._meta?.mode as AlexaSessionMode | undefined) || defaultMode;
      const mode: AlexaSessionMode =
        requestedMode === "code" || requestedMode === "passthrough" || requestedMode === "chat"
          ? requestedMode
          : defaultMode;

      sessions.set(sessionId, {
        sessionId,
        cwd: params.cwd || process.cwd(),
        mode,
        tabId: crypto.randomUUID(),
        threadId: null,
        lastRequestId: null,
        amazonSessionId: null,
        turnCount: 0,
        activeAbort: null,
      });

      return {
        sessionId,
        modes: {
          currentModeId: mode,
          availableModes: AVAILABLE_MODES,
        },
      };
    })
    .onRequest("session/set_mode", async ({ params, client }) => {
      const session = sessions.get(params.sessionId);
      if (!session) {
        throw acp.RequestError.resourceNotFound(params.sessionId);
      }
      const next = params.modeId as AlexaSessionMode;
      if (next !== "code" && next !== "passthrough" && next !== "chat") {
        throw acp.RequestError.invalidParams(`Unsupported mode: ${params.modeId}`);
      }
      session.mode = next;
      await client.notify("session/update", {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: next,
        },
      });
      return {};
    })
    .onNotification("session/cancel", async ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (session?.activeAbort) {
        session.activeAbort.abort();
      }
    })
    .onRequest("session/prompt", async ({ params, client, signal }) => {
      const session = sessions.get(params.sessionId);
      if (!session) {
        throw acp.RequestError.resourceNotFound(params.sessionId);
      }

      const abortController = new AbortController();
      const onParentAbort = () => abortController.abort();
      signal.addEventListener("abort", onParentAbort, { once: true });
      session.activeAbort = abortController;

      try {
        const userText = extractPromptText(params.prompt);
        if (!userText) {
          return { stopReason: "end_turn" as const };
        }

        // Passthrough or pure chat mode: single turn streamed directly to client.
        if (session.mode === "passthrough" || session.mode === "chat") {
          const includeCards = session.mode === "chat";
          let lastThought = "";
          let finalFullText = "";

          for await (const ev of alexa.streamPrompt({
            query: userText,
            threadId: session.threadId,
            tabId: session.tabId,
            previousRequestId: session.lastRequestId,
            sessionId: session.amazonSessionId,
            includeProductCards: includeCards,
            signal: abortController.signal,
          })) {
            if (ev.type === "context") {
              session.lastRequestId = ev.requestId;
              session.amazonSessionId = ev.sessionId;
            } else if (ev.type === "thread") {
              session.threadId = ev.threadId;
            } else if (ev.type === "thought") {
              if (ev.text !== lastThought) {
                const delta = ev.text.startsWith(lastThought)
                  ? ev.text.slice(lastThought.length)
                  : `${lastThought ? "\n" : ""}${ev.text}`;
                lastThought = ev.text;
                if (delta.trim()) {
                  await client.notify("session/update", {
                    sessionId: session.sessionId,
                    update: {
                      sessionUpdate: "agent_thought_chunk",
                      content: { type: "text", text: delta },
                    },
                  });
                }
              }
            } else if (ev.type === "text_delta") {
              await client.notify("session/update", {
                sessionId: session.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: ev.text },
                },
              });
            } else if (ev.type === "cards" && ev.markdown) {
              await client.notify("session/update", {
                sessionId: session.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: `\n\n${ev.markdown}` },
                },
              });
            } else if (ev.type === "done") {
              finalFullText = ev.fullText;
            }
          }

          session.turnCount++;
          return {
            stopReason: "end_turn" as const,
            _meta: { fullText: finalFullText },
          };
        }

        // Code mode: run agentic tool-use loop with workspace tools!
        let nextQuery =
          session.turnCount === 0
            ? `${buildToolSystemPrefix(
                WORKSPACE_TOOL_SPECS,
                "Help the user complete their coding task cleanly and accurately using the available workspace tools.",
                session.cwd
              )}\n\nUser request:\n${userText}`
            : userText;

        for (let step = 0; step < maxToolSteps; step++) {
          if (abortController.signal.aborted) {
            return { stopReason: "cancelled" as const };
          }

          let rawResponse = "";
          let lastThought = "";

          for await (const ev of alexa.streamPrompt({
            query: nextQuery,
            threadId: session.threadId,
            tabId: session.tabId,
            previousRequestId: session.lastRequestId,
            sessionId: session.amazonSessionId,
            includeProductCards: false,
            signal: abortController.signal,
          })) {
            if (ev.type === "context") {
              session.lastRequestId = ev.requestId;
              session.amazonSessionId = ev.sessionId;
            } else if (ev.type === "thread") {
              session.threadId = ev.threadId;
            } else if (ev.type === "thought") {
              if (ev.text !== lastThought) {
                const delta = ev.text.startsWith(lastThought)
                  ? ev.text.slice(lastThought.length)
                  : `${lastThought ? "\n" : ""}${ev.text}`;
                lastThought = ev.text;
                if (delta.trim()) {
                  await client.notify("session/update", {
                    sessionId: session.sessionId,
                    update: {
                      sessionUpdate: "agent_thought_chunk",
                      content: { type: "text", text: delta },
                    },
                  });
                }
              }
            } else if (ev.type === "done") {
              rawResponse = ev.fullText;
            }
          }

          session.turnCount++;
          const parsed = parseToolCalls(rawResponse, WORKSPACE_TOOL_SPECS, session.cwd);

          if (parsed.visibleText) {
            await client.notify("session/update", {
              sessionId: session.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: parsed.visibleText },
              },
            });
          }

          if (parsed.toolCalls.length === 0) {
            return { stopReason: "end_turn" as const };
          }

          const toolResults = [];
          for (const call of parsed.toolCalls) {
            const meta = describeToolCall(call.name, call.arguments);
            await client.notify("session/update", {
              sessionId: session.sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: call.id,
                name: call.name,
                title: meta.title,
                kind: meta.kind,
                status: "in_progress",
                rawInput: call.arguments,
              },
            });

            const execRes = await executeWorkspaceTool(call.name, call.arguments, {
              cwd: session.cwd,
              sessionId: session.sessionId,
              client,
              clientSupportsFsRead: Boolean(clientCapabilities?.fs?.readTextFile),
              clientSupportsFsWrite: Boolean(clientCapabilities?.fs?.writeTextFile),
              clientSupportsTerminal: Boolean(clientCapabilities?.terminal),
              signal: abortController.signal,
            });

            await client.notify("session/update", {
              sessionId: session.sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: call.id,
                status: execRes.isError ? "failed" : "completed",
                locations: execRes.locations,
                content: [
                  {
                    type: "content",
                    content: { type: "text", text: execRes.output },
                  },
                ],
                rawOutput: execRes.output,
              },
            });

            toolResults.push({
              toolCallId: call.id,
              name: call.name,
              output: execRes.output,
              isError: execRes.isError,
            });
          }

          nextQuery = formatToolResults(toolResults);
        }

        return { stopReason: "max_turn_requests" as const };
      } catch (err) {
        if (abortController.signal.aborted) {
          return { stopReason: "cancelled" as const };
        }
        throw err;
      } finally {
        signal.removeEventListener("abort", onParentAbort);
        if (session.activeAbort === abortController) {
          session.activeAbort = null;
        }
      }
    });

  return app;
}

export async function runAcpStdioServer(options: CreateAlexaAcpOptions = {}): Promise<void> {
  const app = createAlexaAcpApp(options);
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  );
  const conn = app.connect(stream);
  await conn.closed;
}
