import crypto from "node:crypto";
import http from "node:http";
import type { LanguageModelV3Message, LanguageModelV3Prompt } from "@ai-sdk/provider";
import { AcpClientBridge, type AlexaAcpProviderOptions } from "../ai-sdk/acp-provider.js";
import { parseToolCalls, type ToolSpec } from "../tools/protocol.js";

export interface ProxyServerOptions extends AlexaAcpProviderOptions {
  port?: number;
  host?: string;
}

interface OpenAIMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function openAiMessagesToV3Prompt(messages: OpenAIMessage[]): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = [];
  for (const m of messages) {
    const textContent =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((p) => p.type === "text" && typeof p.text === "string")
              .map((p) => p.text!)
              .join("\n")
          : "";

    if (m.role === "system" || m.role === "developer") {
      prompt.push({ role: "system", content: textContent });
    } else if (m.role === "user") {
      prompt.push({ role: "user", content: [{ type: "text", text: textContent }] });
    } else if (m.role === "assistant") {
      const content: Extract<LanguageModelV3Message, { role: "assistant" }>["content"] = [];
      if (textContent) content.push({ type: "text", text: textContent });
      for (const tc of m.tool_calls || []) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments || "{}");
        } catch {
          parsedArgs = {};
        }
        content.push({
          type: "tool-call",
          toolCallId: tc.id,
          toolName: tc.function.name,
          input: parsedArgs,
        });
      }
      prompt.push({ role: "assistant", content });
    } else if (m.role === "tool") {
      prompt.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.tool_call_id || "tool",
            toolName: m.name || "tool",
            output: { type: "text", value: textContent },
          },
        ],
      });
    }
  }
  return prompt;
}

function anthropicToV3Prompt(body: Record<string, unknown>): {
  prompt: LanguageModelV3Prompt;
  tools: ToolSpec[];
} {
  const prompt: LanguageModelV3Prompt = [];
  if (typeof body.system === "string" && body.system.trim()) {
    prompt.push({ role: "system", content: body.system });
  } else if (Array.isArray(body.system)) {
    const text = body.system
      .map((b: Record<string, unknown>) => (b.type === "text" ? String(b.text || "") : ""))
      .filter(Boolean)
      .join("\n\n");
    if (text) prompt.push({ role: "system", content: text });
  }

  const messages = (Array.isArray(body.messages) ? body.messages : []) as Array<{
    role: "user" | "assistant";
    content: string | Array<Record<string, unknown>>;
  }>;

  for (const m of messages) {
    if (typeof m.content === "string") {
      prompt.push({ role: m.role, content: [{ type: "text", text: m.content }] });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    if (m.role === "user") {
      const toolResults = m.content.filter((b) => b.type === "tool_result");
      const textParts = m.content.filter((b) => b.type === "text");
      if (toolResults.length > 0) {
        prompt.push({
          role: "tool",
          content: toolResults.map((tr) => {
            const val =
              typeof tr.content === "string"
                ? tr.content
                : Array.isArray(tr.content)
                  ? tr.content
                      .map((c: Record<string, unknown>) => (c.type === "text" ? String(c.text || "") : JSON.stringify(c)))
                      .join("\n")
                  : JSON.stringify(tr.content ?? "");
            return {
              type: "tool-result" as const,
              toolCallId: String(tr.tool_use_id || "tool"),
              toolName: String(tr.name || "tool"),
              output: tr.is_error
                ? ({ type: "error-text" as const, value: val })
                : ({ type: "text" as const, value: val }),
            };
          }),
        });
      }
      if (textParts.length > 0) {
        prompt.push({
          role: "user",
          content: textParts.map((t) => ({ type: "text" as const, text: String(t.text || "") })),
        });
      }
    } else {
      const content: Extract<LanguageModelV3Message, { role: "assistant" }>["content"] = [];
      for (const b of m.content) {
        if (b.type === "text") {
          content.push({ type: "text", text: String(b.text || "") });
        } else if (b.type === "tool_use") {
          content.push({
            type: "tool-call",
            toolCallId: String(b.id || "call"),
            toolName: String(b.name || "tool"),
            input: (b.input as Record<string, unknown>) || {},
          });
        }
      }
      prompt.push({ role: "assistant", content });
    }
  }

  const tools: ToolSpec[] = Array.isArray(body.tools)
    ? (body.tools as Array<Record<string, unknown>>).map((t) => ({
        name: String(t.name || ""),
        description: typeof t.description === "string" ? t.description : undefined,
        inputSchema: (t.input_schema as Record<string, unknown>) || undefined,
      }))
    : [];

  return { prompt, tools };
}

export async function startProxyServer(options: ProxyServerOptions = {}): Promise<{
  server: http.Server;
  url: string;
  close: () => Promise<void>;
}> {
  const port = options.port ?? 4141;
  const host = options.host ?? "127.0.0.1";
  const bridge = new AcpClientBridge(options);

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || "/", `http://${host}:${port}`);

      if (req.method === "GET" && (reqUrl.pathname === "/health" || reqUrl.pathname === "/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, service: "alex-coding-acp" }));
        return;
      }

      if (req.method === "GET" && reqUrl.pathname === "/v1/models") {
        const now = Math.floor(Date.now() / 1000);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "alexa-shopping", object: "model", created: now, owned_by: "amazon-alexa-acp" },
              { id: "alexa-shopping-chat", object: "model", created: now, owned_by: "amazon-alexa-acp" },
            ],
          })
        );
        return;
      }

      if (req.method === "POST" && reqUrl.pathname === "/v1/chat/completions") {
        const body = await readJsonBody(req);
        const model = String(body.model || "alexa-shopping");
        const stream = Boolean(body.stream);
        const messages = (Array.isArray(body.messages) ? body.messages : []) as OpenAIMessage[];
        const openAiTools = (Array.isArray(body.tools) ? body.tools : []) as OpenAITool[];
        const tools: ToolSpec[] = openAiTools
          .filter((t) => t.type === "function" && t.function?.name)
          .map((t) => ({
            name: t.function.name,
            description: t.function.description,
            inputSchema: t.function.parameters,
          }));

        const prompt = openAiMessagesToV3Prompt(messages);
        const ac = new AbortController();
        req.on("close", () => ac.abort());

        const id = `chatcmpl-${crypto.randomBytes(8).toString("hex")}`;
        const created = Math.floor(Date.now() / 1000);
        const mode = model.includes("chat") ? "chat" : "passthrough";

        if (!stream) {
          const { rawText } = await bridge.runTurn({ prompt, tools, mode, abortSignal: ac.signal });
          const parsed = tools.length > 0 ? parseToolCalls(rawText) : { visibleText: rawText, toolCalls: [] };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id,
              object: "chat.completion",
              created,
              model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: parsed.visibleText || null,
                    ...(parsed.toolCalls.length > 0
                      ? {
                          tool_calls: parsed.toolCalls.map((tc) => ({
                            id: tc.id,
                            type: "function",
                            function: { name: tc.name, arguments: tc.rawArguments },
                          })),
                        }
                      : {}),
                  },
                  finish_reason: parsed.toolCalls.length > 0 ? "tool_calls" : "stop",
                },
              ],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            })
          );
          return;
        }

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });

        const writeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
          res.write(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta, finish_reason: finishReason }],
            })}\n\n`
          );
        };

        writeChunk({ role: "assistant" });
        let emittedLen = 0;
        let buffered = "";

        const { rawText } = await bridge.runTurn({
          prompt,
          tools,
          mode,
          abortSignal: ac.signal,
          onThought: (chunk) => {
            writeChunk({ reasoning_content: chunk });
          },
          onRawTextDelta: (chunk) => {
            buffered += chunk;
            if (tools.length === 0 || (!buffered.includes("<") && !buffered.includes("```"))) {
              writeChunk({ content: chunk });
              emittedLen = buffered.length;
            }
          },
        });

        const parsed = tools.length > 0 ? parseToolCalls(rawText) : { visibleText: rawText, toolCalls: [] };
        const remaining = parsed.visibleText.slice(emittedLen);
        if (remaining) {
          writeChunk({ content: remaining });
        }

        if (parsed.toolCalls.length > 0) {
          writeChunk({
            tool_calls: parsed.toolCalls.map((tc, index) => ({
              index,
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.rawArguments },
            })),
          });
        }

        writeChunk({}, parsed.toolCalls.length > 0 ? "tool_calls" : "stop");
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      if (req.method === "POST" && reqUrl.pathname === "/v1/messages") {
        const body = await readJsonBody(req);
        const model = String(body.model || "alexa-shopping");
        const stream = Boolean(body.stream);
        const { prompt, tools } = anthropicToV3Prompt(body);
        const ac = new AbortController();
        req.on("close", () => ac.abort());

        const msgId = `msg_${crypto.randomBytes(8).toString("hex")}`;
        const { rawText } = await bridge.runTurn({
          prompt,
          tools,
          mode: "passthrough",
          abortSignal: ac.signal,
        });
        const parsed = tools.length > 0 ? parseToolCalls(rawText) : { visibleText: rawText, toolCalls: [] };
        const contentBlocks: Array<Record<string, unknown>> = [];
        if (parsed.visibleText) contentBlocks.push({ type: "text", text: parsed.visibleText });
        for (const tc of parsed.toolCalls) {
          contentBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        const stopReason = parsed.toolCalls.length > 0 ? "tool_use" : "end_turn";

        if (!stream) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: msgId,
              type: "message",
              role: "assistant",
              model,
              content: contentBlocks,
              stop_reason: stopReason,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            })
          );
          return;
        }

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });

        const sendEv = (event: string, data: unknown) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        sendEv("message_start", {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });

        contentBlocks.forEach((block, index) => {
          if (block.type === "text") {
            sendEv("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
            sendEv("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: block.text },
            });
            sendEv("content_block_stop", { type: "content_block_stop", index });
          } else if (block.type === "tool_use") {
            sendEv("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            });
            sendEv("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
            });
            sendEv("content_block_stop", { type: "content_block_stop", index });
          }
        });

        sendEv("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: 0 },
        });
        sendEv("message_stop", { type: "message_stop" });
        res.end();
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Not found: ${req.method} ${reqUrl.pathname}` } }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message } }));
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const url = `http://${host}:${port}`;

  return {
    server,
    url,
    close: async () => {
      bridge.dispose();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  };
}
