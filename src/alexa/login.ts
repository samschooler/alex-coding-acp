import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getConfigDir, saveCookies, type StoredCookie } from "./cookies.js";

const CHROME_MAC_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface LoginOptions {
  port?: number;
  chromePath?: string;
  timeoutMs?: number;
}

export async function runChromeLogin(options: LoginOptions = {}): Promise<string> {
  const port = options.port || 9223;
  const chromePath = options.chromePath || process.env.CHROME_PATH || CHROME_MAC_PATH;
  const timeoutMs = options.timeoutMs || 5 * 60 * 1000;

  if (!fs.existsSync(chromePath)) {
    throw new Error(`Google Chrome not found at ${chromePath}. Set CHROME_PATH if installed elsewhere.`);
  }

  const profileDir = path.join(getConfigDir(), "chrome-profile");
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  console.error(`Launching Chrome on debug port ${port}...`);
  console.error("Sign in to https://www.amazon.com/ in the opened Chrome window.");

  const child = spawn(
    chromePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "https://www.amazon.com/",
    ],
    { stdio: "ignore" }
  );

  try {
    // Wait for CDP endpoint
    let pageWsUrl: string | null = null;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        if (res.ok) {
          const targets = (await res.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
          const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
          if (page?.webSocketDebuggerUrl) {
            pageWsUrl = page.webSocketDebuggerUrl;
            break;
          }
        }
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!pageWsUrl) {
      throw new Error(`Timed out waiting for Chrome DevTools on port ${port}`);
    }

    const ws = new WebSocket(pageWsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", (e) => reject(e));
    });

    let nextId = 1;
    const send = <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const handler = (ev: MessageEvent) => {
          const msg = JSON.parse(String(ev.data)) as { id?: number; result?: T; error?: { message: string } };
          if (msg.id === id) {
            ws.removeEventListener("message", handler);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result as T);
          }
        };
        ws.addEventListener("message", handler);
        ws.send(JSON.stringify({ id, method, params }));
      });

    console.error("Waiting for Amazon sign-in (x-main cookie)...");
    while (Date.now() < deadline) {
      const { cookies } = await send<{ cookies: StoredCookie[] }>("Network.getCookies", {
        urls: ["https://www.amazon.com"],
      });
      const hasMain = cookies.some((c) => c.name === "x-main" && c.value);
      if (hasMain) {
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        const check = await fetch("https://www.amazon.com/rufus/cl/render?ref=nl_cl_dsk_rend", {
          headers: { cookie: cookieHeader, referer: "https://www.amazon.com/" },
        });
        const html = await check.text();
        if (check.ok && /anti-csrftoken-a2z/i.test(html)) {
          const savedPath = saveCookies(cookies);
          ws.close();
          console.error(`Saved ${cookies.length} Amazon cookies to ${savedPath}`);
          return savedPath;
        }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    ws.close();
    throw new Error("Timed out waiting for Amazon sign-in.");
  } finally {
    child.kill("SIGTERM");
  }
}
