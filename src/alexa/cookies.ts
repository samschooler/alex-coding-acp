import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StoredCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
}

export interface CookieStoreFile {
  savedAt: string;
  domain: string;
  cookies: StoredCookie[];
}

export function getConfigDir(): string {
  return process.env.ALEXA_CONFIG_DIR || path.join(os.homedir(), ".config", "alex-coding-acp");
}

export function getCookiesPath(): string {
  if (process.env.ALEXA_COOKIES_PATH) return process.env.ALEXA_COOKIES_PATH;
  const primary = path.join(getConfigDir(), "cookies.json");
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(os.homedir(), ".config", "alexa-coding-mcp", "cookies.json");
  if (fs.existsSync(legacy)) return legacy;
  return primary;
}

export function loadCookieHeader(explicitPath?: string): string {
  if (process.env.ALEXA_COOKIE_HEADER?.trim()) {
    return process.env.ALEXA_COOKIE_HEADER.trim();
  }
  const filePath = explicitPath || getCookiesPath();
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Amazon cookies not found at ${filePath}. Run "alex-coding-acp login" to sign in via Chrome.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as CookieStoreFile | StoredCookie[];
  const cookies = Array.isArray(raw) ? raw : raw.cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new Error(`Cookie file ${filePath} is empty. Run "alex-coding-acp login" again.`);
  }
  const hasAuth = cookies.some((c) => c.name === "x-main" && c.value);
  if (!hasAuth) {
    throw new Error(
      `Cookie file ${filePath} is missing Amazon auth cookie "x-main". Run "alex-coding-acp login" to sign in.`
    );
  }
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

export function saveCookies(cookies: StoredCookie[]): string {
  const filePath = path.join(getConfigDir(), "cookies.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const payload: CookieStoreFile = {
    savedAt: new Date().toISOString(),
    domain: "www.amazon.com",
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
    })),
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return filePath;
}
