import { describe, expect, it } from "vitest";
import { createAlexaAcpApp } from "../acp/server.js";
import { createAlexaAcp } from "../ai-sdk/acp-provider.js";
import type { AlexaClient, AlexaPromptOptions, AlexaStreamEvent } from "../alexa/client.js";
import { RufusPatchTracker } from "../alexa/patch-renderer.js";
import { buildToolSystemPrefix, formatToolResults, parseToolCalls } from "../tools/protocol.js";

function createFakeAlexaClient(responses: string[]): AlexaClient {
  let idx = 0;
  const calls: AlexaPromptOptions[] = [];
  const fake = {
    calls,
    async *streamPrompt(opts: AlexaPromptOptions): AsyncGenerator<AlexaStreamEvent> {
      calls.push(opts);
      const reply = responses[idx++] ?? "done";
      yield { type: "context", requestId: `REQ_${idx}`, sessionId: "SESS_1" };
      yield { type: "thread", threadId: opts.threadId || "amzn1.rufus.alexa.thread.fake-1" };
      yield { type: "thought", text: "Thinking..." };
      yield { type: "text_delta", text: reply, groupId: "markdown_processor_0" };
      yield {
        type: "done",
        fullText: reply,
        threadId: opts.threadId || "amzn1.rufus.alexa.thread.fake-1",
        requestId: `REQ_${idx}`,
        sessionId: "SESS_1",
      };
    },
  };
  return fake as unknown as AlexaClient & { calls: AlexaPromptOptions[] };
}

describe("RufusPatchTracker", () => {
  it("streams incremental markdown deltas and separates paragraphs", () => {
    const tracker = new RufusPatchTracker();
    const r1 = tracker.applyPatch({
      op: "add",
      path: "/",
      groupId: "markdown_processor_A_0",
      value: {
        id: "markdownSection-1",
        type: "container",
        children: [
          { id: "paragraph-1", type: "text", children: [{ id: "text-1", type: "text", children: "Hello" }] },
        ],
      },
    });
    expect(r1.delta).toBe("Hello");

    const r2 = tracker.applyPatch({
      op: "replace",
      path: "/children/0/children/0",
      groupId: "markdown_processor_A_0",
      value: { id: "text-1", type: "text", children: "Hello world!" },
    });
    expect(r2.delta).toBe(" world!");

    const r3 = tracker.applyPatch({
      op: "add",
      path: "/children/-",
      groupId: "markdown_processor_A_0",
      value: {
        id: "paragraph-2",
        type: "text",
        children: [{ id: "text-2", type: "text", children: "Second paragraph." }],
      },
    });
    expect(r3.delta).toBe("\n\nSecond paragraph.");
    expect(tracker.getAllMarkdown()).toBe("Hello world!\n\nSecond paragraph.");
  });
});

describe("tool protocol", () => {
  it("parses RUN_TOOL and <tool_call> tags and separates visible text", () => {
    const p1 = parseToolCalls(
      'Let me check that file.\nRUN_TOOL read filePath="package.json" limit=50'
    );
    expect(p1.visibleText).toBe("Let me check that file.");
    expect(p1.toolCalls).toHaveLength(1);
    expect(p1.toolCalls[0].name).toBe("read");
    expect(p1.toolCalls[0].arguments).toEqual({ filePath: "package.json", limit: 50 });

    const p2 = parseToolCalls(
      'Let me inspect the directory.\n<tool_call>{"name":"list_files","arguments":{"path":"."}}</tool_call>'
    );
    expect(p2.visibleText).toBe("Let me inspect the directory.");
    expect(p2.toolCalls).toHaveLength(1);
    expect(p2.toolCalls[0].name).toBe("list_files");
    expect(p2.toolCalls[0].arguments).toEqual({ path: "." });

    const p3 = parseToolCalls("Sure! Use `RUN_TOOL read package.json`", [
      { name: "read", inputSchema: { properties: { filePath: { type: "string" } }, required: ["filePath"] } },
    ]);
    expect(p3.toolCalls).toHaveLength(1);
    expect(p3.toolCalls[0].name).toBe("read");
    expect(p3.toolCalls[0].arguments).toEqual({ filePath: "package.json" });

    const p4 = parseToolCalls(
      "Here are two great picks.\n\nText for chargers.ts:export const x = 1;\nEND_TEXT\n\nLet me know if you want more!",
      [{ name: "write", inputSchema: { properties: { filePath: { type: "string" }, content: { type: "string" } }, required: ["filePath", "content"] } }],
      "/tmp/demo"
    );
    expect(p4.visibleText).toBe("Here are two great picks.\n\nLet me know if you want more!");
    expect(p4.toolCalls).toHaveLength(1);
    expect(p4.toolCalls[0].name).toBe("write");
    expect(p4.toolCalls[0].arguments).toEqual({
      filePath: "/tmp/demo/chargers.ts",
      content: "export const x = 1;\n",
    });

    const p5 = parseToolCalls(
      'Here is your showcase.\n\nText for index.html:\n{"title":"Top Chargers","items":[{"name":"Anker 65W","price":22.77,"url":"https://www.amazon.com/dp/B09C5RG6KV"}]}\nEND_TEXT',
      [{ name: "write", inputSchema: { properties: { filePath: { type: "string" }, content: { type: "string" } }, required: ["filePath", "content"] } }],
      "/tmp/demo"
    );
    expect(p5.toolCalls).toHaveLength(1);
    expect(p5.toolCalls[0].name).toBe("write");
    expect(p5.toolCalls[0].arguments.filePath).toBe("/tmp/demo/index.html");
    expect(String(p5.toolCalls[0].arguments.content)).toContain("<!DOCTYPE html>");
    expect(String(p5.toolCalls[0].arguments.content)).toContain("Anker 65W");
    expect(String(p5.toolCalls[0].arguments.content)).toContain("https://www.amazon.com/dp/B09C5RG6KV");
  });

  it("formats WAF-safe tool prefix and results cleanly", () => {
    const prefix = buildToolSystemPrefix(
      [{ name: "read_file", description: "Read a file", inputSchema: { properties: { path: { type: "string" } }, required: ["path"] } }],
      "Be helpful",
      "/tmp/demo"
    );
    expect(prefix).toContain("Text for FILENAME:");
    expect(prefix).not.toContain("<");
    expect(prefix).not.toContain("{");

    const res = formatToolResults([{ name: "read_file", output: "hello world" }]);
    expect(res).toContain("Here is the read_file result (ok):");
    expect(res).toContain("hello world");

    const writeRes = formatToolResults([{ name: "write", output: "ok" }]);
    expect(writeRes).toContain("Thanks, I saved those notes!");
  });
});

describe("AI SDK v3 provider over ACP", () => {
  it("streams text, reasoning, tool calls, and reuses ACP session across multi-turn tool loop", async () => {
    const fakeAlexa = createFakeAlexaClient([
      '<tool_call>{"name":"read_file","arguments":{"path":"package.json"}}</tool_call>',
      "The package is named alex-coding-acp.",
    ]);
    const acpApp = createAlexaAcpApp({ alexaClient: fakeAlexa, defaultMode: "passthrough" });
    const provider = createAlexaAcp({ inProcessApp: acpApp });
    const model = provider.languageModel("alexa-shopping");

    // Turn 1: model emits a tool call (even when BB injects <system_instructions> into user message!)
    const turn1 = await model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<system_instructions>Huge BB plugin preamble...</system_instructions>\nWhat is the package name?",
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
    });

    expect(turn1.finishReason.unified).toBe("tool-calls");
    const tc = turn1.content.find((c) => c.type === "tool-call");
    expect(tc).toBeDefined();
    expect(tc?.type === "tool-call" && tc.toolName).toBe("read_file");
    const firstCalls = (fakeAlexa as unknown as { calls: AlexaPromptOptions[] }).calls;
    expect(firstCalls[0].query).not.toContain("Huge BB plugin preamble");
    expect(firstCalls[0].query).toContain("What is the package name?");

    // Turn 2: client sends tool result; bridge should reuse the same Alexa threadId!
    const turn2Stream = await model.doStream({
      prompt: [
        { role: "user", content: [{ type: "text", text: "What is the package name?" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: tc && tc.type === "tool-call" ? tc.toolCallId : "call_1",
              toolName: "read_file",
              input: { path: "package.json" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: tc && tc.type === "tool-call" ? tc.toolCallId : "call_1",
              toolName: "read_file",
              output: { type: "text", value: '{"name":"alex-coding-acp"}' },
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
    });

    const parts = [];
    const reader = turn2Stream.stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    const text = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => (p.type === "text-delta" ? p.delta : ""))
      .join("");
    expect(text).toBe("The package is named alex-coding-acp.");

    const calls = (fakeAlexa as unknown as { calls: AlexaPromptOptions[] }).calls;
    expect(calls).toHaveLength(2);
    expect(calls[1].threadId).toBe("amzn1.rufus.alexa.thread.fake-1");
    expect(calls[1].query).toContain("Here is the read_file result (ok):");

    provider.dispose();
  });

  it("prepends rolling context recap once conversation exceeds Amazon's 5-turn server window", async () => {
    const fakeAlexa = createFakeAlexaClient(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
    const acpApp = createAlexaAcpApp({ alexaClient: fakeAlexa, defaultMode: "passthrough" });
    const provider = createAlexaAcp({ inProcessApp: acpApp, serverWindowTurns: 5 });
    const model = provider.languageModel("alexa-shopping");
    const tools = [
      {
        type: "function" as const,
        name: "write",
        description: "Write file",
        inputSchema: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" } }, required: ["filePath", "content"] },
      },
    ];

    const history: Array<
      | { role: "user"; content: Array<{ type: "text"; text: string }> }
      | { role: "assistant"; content: Array<{ type: "text"; text: string }> }
    > = [];

    const userTurns = [
      "Build Morning Pour coffee shop page",
      "Add Chemex filters",
      "Add V60 filters",
      "Check Melitta prices",
      "Compare sizes",
      "Update coffee-shop.html with a budget pick",
    ];

    for (let i = 0; i < userTurns.length; i++) {
      history.push({ role: "user", content: [{ type: "text", text: userTurns[i] }] });
      const res = await model.doGenerate({ prompt: [...history], tools });
      const reply = res.content.find((c) => c.type === "text");
      history.push({
        role: "assistant",
        content: [{ type: "text", text: reply && reply.type === "text" ? reply.text : "" }],
      });
    }

    const calls = (fakeAlexa as unknown as { calls: AlexaPromptOptions[] }).calls;
    expect(calls).toHaveLength(6);
    // Turn 5 (index 4, 4 prior user turns) does not yet need rolling recap
    expect(calls[4].query).not.toContain("Earlier in this chat:");
    // Turn 6 (index 5, 5 prior user turns) includes recap of rolled-off Turn 1 + re-attaches file format
    expect(calls[5].query).toContain("Earlier in this chat:");
    expect(calls[5].query).toContain("Morning Pour");
    expect(calls[5].query).toContain("Text for FILENAME:");
    expect(calls[5].threadId).toBe("amzn1.rufus.alexa.thread.fake-1");

    provider.dispose();
  });
});
