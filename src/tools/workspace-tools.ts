import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentContext, ToolKind } from "@agentclientprotocol/sdk";
import type { ToolSpec } from "./protocol.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceToolContext {
  cwd: string;
  sessionId: string;
  client?: AgentContext;
  clientSupportsFsRead?: boolean;
  clientSupportsFsWrite?: boolean;
  clientSupportsTerminal?: boolean;
  signal?: AbortSignal;
}

export interface WorkspaceToolExecution {
  output: string;
  isError: boolean;
  kind: ToolKind;
  title: string;
  locations?: Array<{ path: string; line?: number | null }>;
}

export const WORKSPACE_TOOL_SPECS: ToolSpec[] = [
  {
    name: "read_file",
    description: "Read a file from the workspace with optional start_line and end_line (1-based).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative or absolute path to read" },
        start_line: { type: "number" },
        end_line: { type: "number" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative or absolute path to write" },
        content: { type: "string", description: "Full file contents" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace an exact string in a workspace file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "list_files",
    description: "List files in a workspace directory (ignores node_modules and .git).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory relative to cwd (default '.')" },
        max_depth: { type: "number", description: "Max recursion depth (default 3)" },
      },
    },
  },
  {
    name: "grep",
    description: "Search for a regex or text pattern in workspace files.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Optional directory or file to search" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "bash",
    description: "Run a shell command in the workspace directory.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "number" },
      },
      required: ["command"],
    },
  },
];

function resolvePath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
}

export function describeToolCall(
  name: string,
  args: Record<string, unknown>
): { kind: ToolKind; title: string } {
  switch (name) {
    case "read_file":
      return { kind: "read", title: `Read ${String(args.path || "file")}` };
    case "write_file":
      return { kind: "edit", title: `Write ${String(args.path || "file")}` };
    case "edit_file":
      return { kind: "edit", title: `Edit ${String(args.path || "file")}` };
    case "list_files":
      return { kind: "search", title: `List ${String(args.path || ".")}` };
    case "grep":
      return { kind: "search", title: `Search "${String(args.pattern || "")}"` };
    case "bash":
      return { kind: "execute", title: `Run: ${String(args.command || "").slice(0, 60)}` };
    default:
      return { kind: "other", title: name };
  }
}

export async function executeWorkspaceTool(
  name: string,
  args: Record<string, unknown>,
  ctx: WorkspaceToolContext
): Promise<WorkspaceToolExecution> {
  const { kind, title } = describeToolCall(name, args);

  try {
    if (name === "read_file") {
      const target = resolvePath(ctx.cwd, String(args.path || ""));
      let content: string;
      if (ctx.client && ctx.clientSupportsFsRead) {
        const res = await ctx.client.request("fs/read_text_file", {
          sessionId: ctx.sessionId,
          path: target,
          line: typeof args.start_line === "number" ? args.start_line : null,
          limit:
            typeof args.start_line === "number" && typeof args.end_line === "number"
              ? Math.max(1, args.end_line - args.start_line + 1)
              : null,
        });
        content = res.content;
      } else {
        const raw = await fs.readFile(target, "utf8");
        const lines = raw.split("\n");
        const start = Math.max(1, Number(args.start_line) || 1);
        const end = Math.min(lines.length, Number(args.end_line) || lines.length);
        content = lines
          .slice(start - 1, end)
          .map((l, idx) => `${start + idx}: ${l}`)
          .join("\n");
      }
      return {
        output: content,
        isError: false,
        kind,
        title,
        locations: [{ path: target, line: typeof args.start_line === "number" ? args.start_line : 1 }],
      };
    }

    if (name === "write_file") {
      const target = resolvePath(ctx.cwd, String(args.path || ""));
      const content = String(args.content ?? "");
      if (ctx.client && ctx.clientSupportsFsWrite) {
        await ctx.client.request("fs/write_text_file", {
          sessionId: ctx.sessionId,
          path: target,
          content,
        });
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, "utf8");
      }
      return {
        output: `Wrote ${content.length} bytes to ${target}`,
        isError: false,
        kind,
        title,
        locations: [{ path: target, line: 1 }],
      };
    }

    if (name === "edit_file") {
      const target = resolvePath(ctx.cwd, String(args.path || ""));
      const oldStr = String(args.old_string ?? "");
      const newStr = String(args.new_string ?? "");
      const current = await fs.readFile(target, "utf8");
      if (!current.includes(oldStr)) {
        return {
          output: `old_string not found in ${target}`,
          isError: true,
          kind,
          title,
          locations: [{ path: target }],
        };
      }
      const updated = current.replace(oldStr, newStr);
      if (ctx.client && ctx.clientSupportsFsWrite) {
        await ctx.client.request("fs/write_text_file", {
          sessionId: ctx.sessionId,
          path: target,
          content: updated,
        });
      } else {
        await fs.writeFile(target, updated, "utf8");
      }
      return {
        output: `Edited ${target} successfully.`,
        isError: false,
        kind,
        title,
        locations: [{ path: target }],
      };
    }

    if (name === "list_files") {
      const target = resolvePath(ctx.cwd, String(args.path || "."));
      const maxDepth = Math.min(6, Math.max(1, Number(args.max_depth) || 3));
      const results: string[] = [];
      const ignore = new Set(["node_modules", ".git", "dist", ".next", ".turbo"]);

      async function walk(dir: string, depth: number) {
        if (depth > maxDepth || results.length >= 200) return;
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (ignore.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          const rel = path.relative(ctx.cwd, full) || entry.name;
          results.push(entry.isDirectory() ? `${rel}/` : rel);
          if (entry.isDirectory() && depth < maxDepth) {
            await walk(full, depth + 1);
          }
          if (results.length >= 200) break;
        }
      }

      await walk(target, 1);
      return {
        output: results.length > 0 ? results.join("\n") : "(empty directory)",
        isError: false,
        kind,
        title,
      };
    }

    if (name === "grep") {
      const pattern = String(args.pattern || "");
      const target = resolvePath(ctx.cwd, String(args.path || "."));
      try {
        const { stdout } = await execFileAsync(
          "rg",
          ["-n", "--max-count", "20", "--glob", "!node_modules", "--glob", "!.git", pattern, target],
          { cwd: ctx.cwd, timeout: 10_000, maxBuffer: 512 * 1024 }
        );
        return { output: stdout.trim() || "(no matches)", isError: false, kind, title };
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
        if (e.code === 1) {
          return { output: "(no matches)", isError: false, kind, title };
        }
        return { output: e.stderr || e.message || String(err), isError: true, kind, title };
      }
    }

    if (name === "bash") {
      const command = String(args.command || "");
      const timeout = Math.min(60_000, Math.max(1000, Number(args.timeout_ms) || 20_000));
      if (ctx.client && ctx.clientSupportsTerminal) {
        const term = await ctx.client.createTerminal({
          sessionId: ctx.sessionId,
          command: "/bin/zsh",
          args: ["-lc", command],
          cwd: ctx.cwd,
        });
        try {
          const exit = await term.waitForExit();
          const out = await term.currentOutput();
          const isError = typeof exit.exitCode === "number" && exit.exitCode !== 0;
          return {
            output: `${out.output || ""}${exit.exitCode != null ? `\n[exit code: ${exit.exitCode}]` : ""}`.trim(),
            isError,
            kind,
            title,
          };
        } finally {
          await term.release().catch(() => {});
        }
      }

      const { stdout, stderr } = await execFileAsync("/bin/zsh", ["-lc", command], {
        cwd: ctx.cwd,
        timeout,
        maxBuffer: 1024 * 1024,
        signal: ctx.signal,
      });
      const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
      return { output: combined || "(no output)", isError: false, kind, title };
    }

    return { output: `Unknown tool: ${name}`, isError: true, kind, title };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const msg = [e.message, e.stdout, e.stderr].filter(Boolean).join("\n");
    return { output: msg || String(err), isError: true, kind, title };
  }
}
