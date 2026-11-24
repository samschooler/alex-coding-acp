import crypto from "node:crypto";
import { loadCookieHeader } from "./cookies.js";
import { RufusPatchTracker, stripHtmlToText, type JsonPatch } from "./patch-renderer.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36";

/** Amazon's /rufus/cl/streaming endpoint enforces the #rufus-text-area maxlength of 500 chars. */
export const ALEXA_MAX_QUERY_CHARS = 500;

export function splitQueryIntoChunks(query: string, maxChars = 460): string[] {
  const normalized = query.trim();
  if (normalized.length <= ALEXA_MAX_QUERY_CHARS) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  // Reserve room for "[Part X/Y] " prefix (~16 chars)
  const sliceLen = Math.min(maxChars, 440);
  while (remaining.length > sliceLen) {
    let cut = remaining.lastIndexOf("\n", sliceLen);
    if (cut < sliceLen * 0.5) cut = remaining.lastIndexOf(" ", sliceLen);
    if (cut < sliceLen * 0.5) cut = sliceLen;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export interface AlexaRenderSession {
  csrfToken: string;
  impressionsContextKey: string;
  fetchedAt: number;
}

export interface AlexaPromptOptions {
  query: string;
  threadId?: string | null;
  tabId?: string;
  previousRequestId?: string | null;
  sessionId?: string | null;
  includeProductCards?: boolean;
  signal?: AbortSignal;
}

export type AlexaStreamEvent =
  | { type: "context"; requestId: string; sessionId: string }
  | { type: "thread"; threadId: string }
  | { type: "thought"; text: string }
  | { type: "text_delta"; text: string; groupId: string }
  | { type: "cards"; markdown: string }
  | { type: "done"; fullText: string; threadId: string | null; requestId: string | null; sessionId: string | null };

export interface AlexaPromptResult {
  text: string;
  cardsMarkdown: string;
  thoughts: string[];
  threadId: string | null;
  requestId: string | null;
  sessionId: string | null;
}

export interface AlexaClientOptions {
  cookieHeader?: string;
  userAgent?: string;
  baseUrl?: string;
}

export class AlexaClient {
  private cookieHeaderOverride?: string;
  private userAgent: string;
  private baseUrl: string;
  private sessionCache: AlexaRenderSession | null = null;
  private readonly cacheTtlMs = 15 * 60 * 1000;

  constructor(options: AlexaClientOptions = {}) {
    this.cookieHeaderOverride = options.cookieHeader;
    this.userAgent = options.userAgent || DEFAULT_UA;
    this.baseUrl = (options.baseUrl || "https://www.amazon.com").replace(/\/$/, "");
  }

  private getCookieHeader(): string {
    return this.cookieHeaderOverride || loadCookieHeader();
  }

  async ensureSession(forceRefresh = false): Promise<AlexaRenderSession> {
    if (
      !forceRefresh &&
      this.sessionCache &&
      Date.now() - this.sessionCache.fetchedAt < this.cacheTtlMs
    ) {
      return this.sessionCache;
    }

    const cookie = this.getCookieHeader();
    const res = await fetch(`${this.baseUrl}/rufus/cl/render?ref=nl_cl_dsk_rend`, {
      method: "GET",
      headers: {
        cookie,
        "user-agent": this.userAgent,
        accept: "text/html,*/*",
        referer: `${this.baseUrl}/`,
      },
    });

    if (!res.ok) {
      throw new Error(
        `Amazon /rufus/cl/render failed (${res.status}). Your cookies may have expired — run "alex-coding-acp login".`
      );
    }

    const html = await res.text();
    const csrfToken =
      html.match(/anti-csrftoken-a2z[^>]*content="([^"]+)"/i)?.[1] ||
      html.match(/content="([^"]+)"[^>]*anti-csrftoken-a2z/i)?.[1] ||
      html.match(/name="anti-csrftoken-a2z"\s+value="([^"]+)"/i)?.[1];

    const impressionsContextKey =
      html.match(/name="impressionsContextKey"\s+value="([^"]+)"/i)?.[1] || "";

    if (!csrfToken) {
      throw new Error(
        `Could not extract anti-csrftoken-a2z from /rufus/cl/render (got ${html.length} bytes). You may need to sign in again with "alex-coding-acp login".`
      );
    }

    this.sessionCache = {
      csrfToken,
      impressionsContextKey,
      fetchedAt: Date.now(),
    };
    return this.sessionCache;
  }

  async *streamPrompt(options: AlexaPromptOptions): AsyncGenerator<AlexaStreamEvent> {
    const chunks = splitQueryIntoChunks(options.query);
    if (chunks.length === 1) {
      yield* this.streamSingleTurn(options);
      return;
    }

    // Multi-chunk continuation across the same Alexa threadId when query exceeds Amazon's 500-char cap.
    const tabId = options.tabId || crypto.randomUUID();
    let threadId = options.threadId ?? null;
    let previousRequestId = options.previousRequestId ?? null;
    let sessionId = options.sessionId ?? null;

    for (let i = 0; i < chunks.length - 1; i++) {
      const partText = `[Part ${i + 1}/${chunks.length} - wait for next part]\n${chunks[i]}`.slice(
        0,
        ALEXA_MAX_QUERY_CHARS
      );
      for await (const ev of this.streamSingleTurn({
        ...options,
        query: partText,
        tabId,
        threadId,
        previousRequestId,
        sessionId,
        includeProductCards: false,
      })) {
        if (ev.type === "context") {
          previousRequestId = ev.requestId;
          sessionId = ev.sessionId;
        } else if (ev.type === "thread") {
          threadId = ev.threadId;
        }
      }
    }

    const finalText = `[Part ${chunks.length}/${chunks.length} - respond now]\n${
      chunks[chunks.length - 1]
    }`.slice(0, ALEXA_MAX_QUERY_CHARS);

    yield* this.streamSingleTurn({
      ...options,
      query: finalText,
      tabId,
      threadId,
      previousRequestId,
      sessionId,
    });
  }

  private async *streamSingleTurn(options: AlexaPromptOptions): AsyncGenerator<AlexaStreamEvent> {
    const session = await this.ensureSession();
    const tabId = options.tabId || crypto.randomUUID();
    const cookie = this.getCookieHeader();
    const safeQuery = options.query.slice(0, ALEXA_MAX_QUERY_CHARS);

    const payload: Record<string, unknown> = {
      queryContext: {
        query: safeQuery,
        actionType: "SEARCH",
        qis: "NileCLTextInput",
      },
      pageContext: {
        pageType: "GATEWAY",
        targetPageType: "GATEWAY",
        originPageType: "GATEWAY",
        targetUrl: `${this.baseUrl}/`,
        originUrl: `${this.baseUrl}/`,
      },
      bottomSheetContext: {
        bottomSheetEmpty: false,
        previousTurnsBottomSheetSize: "expanded",
      },
      impressionsContext: {
        IMPRESSIONS_CONTEXT_KEY: session.impressionsContextKey,
        FIRST_TIME_USER_MESSAGE_SEEN_STATUS: "SEEN",
      },
      isDebug: "n",
      historyThreadContext: {
        threadId: options.threadId ?? null,
        threadState: "THREAD_STATE_UNKNOWN",
      },
    };

    if (options.previousRequestId && options.sessionId) {
      payload.requestCancellationTokens = [
        {
          requestId: options.previousRequestId,
          sessionId: options.sessionId,
          requestCompleted: true,
        },
      ];
    }

    const url = `${this.baseUrl}/rufus/cl/streaming?tabId=${encodeURIComponent(
      tabId
    )}&ref=nl_cl_dsk_csq&programId=NILE_CLASSIC%3Adesktop-cl`;

    const doRequest = (csrfToken: string) =>
      fetch(url, {
        method: "POST",
        headers: {
          cookie,
          "user-agent": this.userAgent,
          "content-type": "application/json",
          accept: "text/event-stream",
          referer: `${this.baseUrl}/`,
          origin: this.baseUrl,
          "anti-csrftoken-a2z": csrfToken,
          "x-amz-is-papyrus": "true",
        },
        body: JSON.stringify(payload),
        signal: options.signal,
      });

    let res = await doRequest(session.csrfToken);
    if (res.status === 401 || res.status === 403) {
      const refreshed = await this.ensureSession(true);
      res = await doRequest(refreshed.csrfToken);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `Amazon /rufus/cl/streaming failed (${res.status}): ${errText.slice(0, 300)}`
      );
    }

    if (!res.body) {
      throw new Error("Amazon /rufus/cl/streaming returned an empty body");
    }

    const tracker = new RufusPatchTracker();
    const decoder = new TextDecoder();
    let buffer = "";
    let threadId: string | null = options.threadId ?? null;
    let requestId: string | null = null;
    let sessionId: string | null = options.sessionId ?? null;
    let lastMarkdownGroupId: string | null = null;

    const reader = res.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Split on blank line (LF or CRLF)
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          const parsed = parseSseBlock(block);
          if (!parsed) continue;
          yield* this.handleSseEvent(
            parsed.event,
            parsed.data,
            tracker,
            {
              onContext: (rId, sId) => {
                requestId = rId;
                sessionId = sId;
              },
              onThread: (tId) => {
                threadId = tId;
              },
              getLastGroup: () => lastMarkdownGroupId,
              setLastGroup: (g) => {
                lastMarkdownGroupId = g;
              },
            }
          );
        }
      }

      if (buffer.trim()) {
        const parsed = parseSseBlock(buffer);
        if (parsed) {
          yield* this.handleSseEvent(
            parsed.event,
            parsed.data,
            tracker,
            {
              onContext: (rId, sId) => {
                requestId = rId;
                sessionId = sId;
              },
              onThread: (tId) => {
                threadId = tId;
              },
              getLastGroup: () => lastMarkdownGroupId,
              setLastGroup: (g) => {
                lastMarkdownGroupId = g;
              },
            }
          );
        }
      }
    } finally {
      reader.releaseLock();
    }

    const cards = tracker.getProductCardsMarkdown();
    if (options.includeProductCards && cards.length > 0) {
      yield { type: "cards", markdown: cards.join("\n") };
    }

    yield {
      type: "done",
      fullText: tracker.getAllMarkdown(),
      threadId,
      requestId,
      sessionId,
    };
  }

  private *handleSseEvent(
    event: string,
    data: string,
    tracker: RufusPatchTracker,
    hooks: {
      onContext: (requestId: string, sessionId: string) => void;
      onThread: (threadId: string) => void;
      getLastGroup: () => string | null;
      setLastGroup: (g: string) => void;
    }
  ): Generator<AlexaStreamEvent> {
    if (!data) return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    if (event === "context") {
      const rc = obj.requestContext as { requestId?: string; sessionId?: string } | undefined;
      if (rc?.requestId && rc?.sessionId) {
        hooks.onContext(rc.requestId, rc.sessionId);
        yield { type: "context", requestId: rc.requestId, sessionId: rc.sessionId };
      }
      return;
    }

    if (event === "conversation_metadata") {
      if (typeof obj.threadId === "string" && obj.threadId) {
        hooks.onThread(obj.threadId);
        yield { type: "thread", threadId: obj.threadId };
      }
      return;
    }

    if (event === "interim") {
      const sections = obj.sections as Array<{ content?: { data?: string } }> | undefined;
      const html = sections?.[0]?.content?.data;
      if (html) {
        const text = stripHtmlToText(html);
        if (text) {
          yield { type: "thought", text };
        }
      }
      return;
    }

    if (event === "inference" && obj.type === "JSONPatches" && Array.isArray(obj.patches)) {
      for (const patch of obj.patches as JsonPatch[]) {
        const res = tracker.applyPatch(patch);
        if (res.isMarkdown && res.delta) {
          const prevGroup = hooks.getLastGroup();
          let delta = res.delta;
          if (prevGroup && prevGroup !== res.groupId && !delta.startsWith("\n")) {
            delta = `\n\n${delta}`;
          }
          hooks.setLastGroup(res.groupId);
          yield { type: "text_delta", text: delta, groupId: res.groupId };
        }
      }
    }
  }

  async prompt(options: AlexaPromptOptions): Promise<AlexaPromptResult> {
    let text = "";
    let cardsMarkdown = "";
    const thoughts: string[] = [];
    let threadId: string | null = options.threadId ?? null;
    let requestId: string | null = null;
    let sessionId: string | null = options.sessionId ?? null;

    for await (const ev of this.streamPrompt(options)) {
      if (ev.type === "thought") thoughts.push(ev.text);
      else if (ev.type === "cards") cardsMarkdown = ev.markdown;
      else if (ev.type === "done") {
        text = ev.fullText;
        threadId = ev.threadId;
        requestId = ev.requestId;
        sessionId = ev.sessionId;
      }
    }

    return { text, cardsMarkdown, thoughts, threadId, requestId, sessionId };
  }
}

function parseSseBlock(block: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine.startsWith("event:")) {
      event = rawLine.slice(6).trim();
    } else if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}
