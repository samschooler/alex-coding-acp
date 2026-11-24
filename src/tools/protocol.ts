import crypto from "node:crypto";
import { renderShoppingHtml } from "./html-renderer.js";

export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments: string;
}

export interface ParseResult {
  visibleText: string;
  toolCalls: ParsedToolCall[];
}

export interface ToolResultInput {
  toolCallId?: string;
  name: string;
  output: string;
  isError?: boolean;
}

const PRIORITY_TOOLS = new Set([
  "read",
  "read_file",
  "write",
  "write_file",
  "edit",
  "edit_file",
  "bash",
  "glob",
  "grep",
  "list_files",
]);

function summarizeParams(schema?: Record<string, unknown>): string {
  if (!schema || typeof schema !== "object") return "()";
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  if (!props || typeof props !== "object") return "()";
  // Prefer required params only so the entire tool prefix + user request fits in a single <=500-char turn.
  const keys = required.length > 0 ? required.slice(0, 3) : Object.keys(props).slice(0, 2);
  return `(${keys.join(",")})`;
}

export const DEFAULT_TOOL_PROMPT_TEMPLATE =
  "When I ask you to draft content, notes, data, or code for a file, wrap it between:\nText for FILENAME:\n(file content — for .html files, output a JSON object with title, subtitle, and items array instead of HTML tags)\nEND_TEXT";

/**
 * Builds an ultra-compact, WAF-safe tool-bridge prefix (no angle brackets or braces,
 * sized so prefix + typical user prompt fits inside Amazon's single-turn 500-char cap).
 */
export function buildToolSystemPrefix(
  tools: ToolSpec[],
  systemPrompt?: string,
  cwd?: string,
  customTemplate?: string
): string {
  if (tools.length === 0) {
    const sys = (systemPrompt || "")
      .replace(/[<>]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!sys) return "";
    return sys.length > 160 ? `${sys.slice(0, 157)}...` : sys;
  }

  const prioritized = [
    ...tools.filter((t) => PRIORITY_TOOLS.has(t.name)),
    ...tools.filter((t) => !PRIORITY_TOOLS.has(t.name)),
  ].slice(0, 6);

  const toolList = prioritized
    .map((t) => `${t.name}${summarizeParams(t.inputSchema)}`)
    .join(", ");

  const dirHint = cwd ? ` Dir: ${cwd}.` : "";
  const template = customTemplate || process.env.ALEXA_TOOL_PROMPT || DEFAULT_TOOL_PROMPT_TEMPLATE;
  return template
    .replace(/\{\{tools\}\}/g, toolList)
    .replace(/\{\{cwd\}\}/g, cwd || "")
    .replace(/\{\{dir\}\}/g, dirHint)
    .replace(/[<>]/g, "")
    .trim();
}

function makeCall(name: string, argsObj: Record<string, unknown>): ParsedToolCall {
  return {
    id: `call_${crypto.randomBytes(6).toString("hex")}`,
    name,
    arguments: argsObj,
    rawArguments: JSON.stringify(argsObj),
  };
}

function tryParseJsonCall(raw: string): ParsedToolCall | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json|tool_call)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  if (!cleaned) return null;
  try {
    const obj = JSON.parse(cleaned) as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name : typeof obj.tool === "string" ? obj.tool : null;
    if (!name) return null;
    const argsRaw = obj.arguments ?? obj.args ?? obj.input ?? {};
    const argsObj =
      argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw)
        ? (argsRaw as Record<string, unknown>)
        : {};
    return makeCall(name, argsObj);
  } catch {
    return null;
  }
}

function getPrimaryParamName(toolName: string, tools?: ToolSpec[]): string | null {
  const spec = tools?.find((t) => t.name === toolName);
  if (spec?.inputSchema && typeof spec.inputSchema === "object") {
    const req = spec.inputSchema.required;
    if (Array.isArray(req) && typeof req[0] === "string") return req[0];
    const props = spec.inputSchema.properties as Record<string, unknown> | undefined;
    if (props && typeof props === "object") {
      const first = Object.keys(props)[0];
      if (first) return first;
    }
  }
  switch (toolName) {
    case "read":
    case "write":
    case "edit":
      return "filePath";
    case "read_file":
    case "write_file":
    case "edit_file":
    case "list_files":
      return "path";
    case "glob":
    case "grep":
      return "pattern";
    case "bash":
      return "command";
    default:
      return null;
  }
}

function parseKeyValueArgs(rawArgs: string, toolName: string, tools?: ToolSpec[]): Record<string, unknown> {
  const trimmed = rawArgs.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to key=value parsing
    }
  }

  const out: Record<string, unknown> = {};
  const pairRe = /([A-Za-z_][A-Za-z0-9_-]*)=(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = pairRe.exec(trimmed)) !== null) {
    const key = match[1];
    const valRaw = match[2] ?? match[3] ?? match[4] ?? "";
    const unescaped = valRaw.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (unescaped === "true") out[key] = true;
    else if (unescaped === "false") out[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(unescaped) && match[4] !== undefined) out[key] = Number(unescaped);
    else out[key] = unescaped;
  }

  // Fallback for positional form like `RUN_TOOL read package.json` or `RUN_TOOL bash ls -la`
  if (Object.keys(out).length === 0) {
    const primary = getPrimaryParamName(toolName, tools);
    if (primary) {
      const unquoted = trimmed.replace(/^["']|["']$/g, "");
      out[primary] = unquoted;
    }
  }
  return out;
}

export function parseToolCalls(text: string, tools?: ToolSpec[], cwd?: string): ParseResult {
  const toolCalls: ParsedToolCall[] = [];
  let visibleText = text;
  const knownNames = tools && tools.length > 0 ? new Set(tools.map((t) => t.name)) : null;

  // 1. Primary natural file-draft format (100% reliable with Alexa Shopping!):
  //    "Text for <filename>:\n<content>" or "SAVE_FILE: <filename>\n<content>"
  const writeToolName = knownNames
    ? knownNames.has("write")
      ? "write"
      : knownNames.has("write_file")
        ? "write_file"
        : null
    : "write";

  if (writeToolName) {
    const fileParam = writeToolName === "write_file" ? "path" : "filePath";
    const finalizeContent = (rawPath: string, body: string): string =>
      /\.html?$/i.test(rawPath) ? renderShoppingHtml(body, rawPath) : `${body}\n`;

    // First match explicitly delimited blocks (supports multiple files, optional bold/backticks, & preserves trailing commentary):
    //   Text for path/to/file.ext:
    //   ...
    //   END_TEXT
    const delimitedRe =
      /(?:^|\n)[ \t]*(?:\*\*|`)?(?:Text for|SAVE_FILE:?)[ \t]+`?([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})`?(?:\*\*|`)?[ \t]*:?[ \t]*(\n?[\s\S]*?)(?:\r?\n)?[ \t]*(?:\*\*|`)?\bEND_TEXT\b(?:\*\*|`)?/gi;
    visibleText = visibleText.replace(delimitedRe, (full, rawPath: string, rawBody: string) => {
      const body = rawBody.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      if (!body.trim()) return full;
      const cleanPath = rawPath.trim();
      const resolvedPath =
        cwd && !cleanPath.startsWith("/") ? `${cwd.replace(/\/$/, "")}/${cleanPath}` : cleanPath;
      toolCalls.push(
        makeCall(writeToolName, { [fileParam]: resolvedPath, content: finalizeContent(cleanPath, body) })
      );
      return "";
    });

    // Fallback: undelimited trailing `Text for path/to/file.ext:` or `SAVE_FILE: path/to/file.ext`
    if (toolCalls.length === 0) {
      const draftRe =
        /(?:^|\n)[ \t]*(?:\*\*|`)?(?:Text for|SAVE_FILE:?)[ \t]+`?([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})`?(?:\*\*|`)?[ \t]*:?[ \t]*(\n?[\s\S]+)$/i;
      const m = visibleText.match(draftRe);
      if (m) {
        const cleanPath = m[1].trim();
        const body = m[2].replace(/^\r?\n/, "").trim();
        if (body.length > 0) {
          const resolvedPath =
            cwd && !cleanPath.startsWith("/") ? `${cwd.replace(/\/$/, "")}/${cleanPath}` : cleanPath;
          toolCalls.push(
            makeCall(writeToolName, { [fileParam]: resolvedPath, content: finalizeContent(cleanPath, body) })
          );
          visibleText = visibleText.slice(0, m.index).trim();
        }
      }
    }
  }

  // 2. Explicit RUN_TOOL <name> <key=value | json | positional> (line or inline)
  const runToolRe = /(?:`+)?\bRUN_TOOL[ \t]+([A-Za-z_][A-Za-z0-9_-]*)(?:[ \t]+([^\n`]*))?(?:`+)?/g;
  visibleText = visibleText.replace(runToolRe, (full, name: string, rest?: string) => {
    // Ignore template echoes like "RUN_TOOL name key=value" or unknown names when tool list is known
    if (name === "name" || name === "TOOL" || name === "cmd") return full;
    if (knownNames && !knownNames.has(name)) return full;
    const args = parseKeyValueArgs(rest || "", name, tools);
    toolCalls.push(makeCall(name, args));
    return "";
  });

  // 2. Bracketed format: [[TOOL_CALL {...}]]
  const bracketRe = /\[\[TOOL_CALL\s+([\s\S]*?)\]\]/gi;
  visibleText = visibleText.replace(bracketRe, (full, inner: string) => {
    const parsed = tryParseJsonCall(inner);
    if (parsed) {
      toolCalls.push(parsed);
      return "";
    }
    return full;
  });

  // 3. XML format: <tool_call>{...}</tool_call>
  const xmlRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  visibleText = visibleText.replace(xmlRe, (full, inner: string) => {
    const parsed = tryParseJsonCall(inner);
    if (parsed) {
      toolCalls.push(parsed);
      return "";
    }
    return full;
  });

  // 4. Fenced fallback: ```tool_call\n{...}\n```
  if (toolCalls.length === 0) {
    const fenceRe = /```tool_call\s*([\s\S]*?)\s*```/gi;
    visibleText = visibleText.replace(fenceRe, (full, inner: string) => {
      const parsed = tryParseJsonCall(inner);
      if (parsed) {
        toolCalls.push(parsed);
        return "";
      }
      return full;
    });
  }

  return {
    visibleText: visibleText.replace(/\n{3,}/g, "\n\n").trim(),
    toolCalls,
  };
}

export function formatToolResults(results: ToolResultInput[], maxPerResult = 900): string {
  const allWritesOk =
    results.length > 0 &&
    results.every((r) => !r.isError && (r.name === "write" || r.name === "write_file"));
  if (allWritesOk) {
    return "Thanks, I saved those notes! Briefly confirm what you included in 1-2 sentences without repeating the full file.";
  }

  const blocks = results.map((r) => {
    const cleanOut = r.output.replace(/[<>]/g, "");
    const body =
      cleanOut.length > maxPerResult
        ? `${cleanOut.slice(0, maxPerResult)}...[truncated]`
        : cleanOut;
    const status = r.isError ? "error" : "ok";
    return `Here is the ${r.name} result (${status}):\n${body}`;
  });
  return `${blocks.join("\n")}\nNow answer my question based on that.`;
}
