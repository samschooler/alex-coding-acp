export interface JsonPatch {
  op: "add" | "replace" | "remove" | string;
  path: string;
  groupId?: string;
  value?: unknown;
}

export interface RufusNode {
  id?: string;
  type?: string;
  weight?: string;
  size?: string;
  variant?: string;
  direction?: string;
  children?: string | RufusNode | Array<string | RufusNode>;
  copyTemplate?: {
    prefix?: string;
    suffix?: string;
  };
  onPress?: {
    actionType?: string;
    url?: string;
    payload?: Record<string, unknown>;
  };
  url?: string;
  valueString?: string;
  value?: number;
  count?: string;
  wholeValue?: string;
  fractionalValue?: string;
  currencySymbol?: string;
  decimalSeparator?: string;
  strikethrough?: boolean;
  accessibilityLabel?: string;
  [key: string]: unknown;
}

export function applyJsonPatch(doc: unknown, patch: JsonPatch): unknown {
  const { op, path, value } = patch;
  if (path === "/" || path === "") {
    if (op === "add" || op === "replace") return structuredClone(value);
    if (op === "remove") return null;
    return doc;
  }

  const root = doc == null ? {} : doc;
  const parts = path
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = Array.isArray(cur) ? Number(parts[i]) : parts[i];
    if (cur[key] === undefined || cur[key] === null) {
      cur[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    cur = cur[key];
  }

  const last = parts[parts.length - 1];
  if (Array.isArray(cur)) {
    if (op === "add") {
      if (last === "-") cur.push(structuredClone(value));
      else cur.splice(Number(last), 0, structuredClone(value));
    } else if (op === "replace") {
      cur[Number(last)] = structuredClone(value);
    } else if (op === "remove") {
      cur.splice(Number(last), 1);
    }
  } else if (cur && typeof cur === "object") {
    if (op === "add" || op === "replace") {
      cur[last] = structuredClone(value);
    } else if (op === "remove") {
      delete cur[last];
    }
  }

  return root;
}

function isBlockId(id: string | undefined): boolean {
  if (!id) return false;
  return /^(paragraph|heading|codeBlock|list|bullet|blockquote|markdownSection)-/i.test(id);
}

/**
 * Renders a Rufus JSONSections / JSONPatches tree into clean Markdown text.
 */
export function renderRufusMarkdown(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    return renderChildren(node);
  }
  if (typeof node !== "object") return String(node);

  const n = node as RufusNode;
  const id = n.id || "";

  if (n.type === "price") {
    const val = `${n.currencySymbol || "$"}${n.wholeValue || "0"}${
      n.fractionalValue ? (n.decimalSeparator || ".") + n.fractionalValue : ""
    }`;
    return n.strikethrough ? `~~${val}~~` : val;
  }

  if (n.type === "rating") {
    return `${n.valueString || n.value}★ (${n.count || ""})`;
  }

  if (n.type === "link") {
    const label = renderRufusMarkdown(n.children).trim();
    const url = n.onPress?.url || n.url;
    if (url && label) return `[${label}](${url})`;
    return label;
  }

  if (n.type === "image" || n.type === "icon" || n.type === "asinIcon") {
    return "";
  }

  const prefix = n.copyTemplate?.prefix ?? "";
  const suffix = n.copyTemplate?.suffix ?? "";

  if (Array.isArray(n.children)) {
    const inner = renderChildren(n.children);
    return `${prefix}${inner}${suffix}`;
  }

  const inner = renderRufusMarkdown(n.children);
  if (id.startsWith("code-") && inner && !inner.includes("`")) {
    return `${prefix}\`${inner}\`${suffix}`;
  }
  return `${prefix}${inner}${suffix}`;
}

function renderChildren(children: Array<string | RufusNode>): string {
  let out = "";
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const rendered = renderRufusMarkdown(child);
    if (!rendered) continue;

    const prev = i > 0 ? children[i - 1] : null;
    const prevIsPara =
      typeof prev === "object" && prev !== null && (prev.id || "").startsWith("paragraph-");
    const curIsPara =
      typeof child === "object" && child !== null && (child.id || "").startsWith("paragraph-");

    if (out.length > 0 && prevIsPara && curIsPara && !out.endsWith("\n") && !rendered.startsWith("\n")) {
      out += "\n\n";
    } else if (
      out.length > 0 &&
      typeof child === "object" &&
      child !== null &&
      isBlockId(child.id) &&
      !out.endsWith("\n") &&
      !rendered.startsWith("\n") &&
      !rendered.startsWith(" ")
    ) {
      out += "\n";
    }
    out += rendered;
  }
  return out;
}

/**
 * Extracts readable product card markdown from an `asin_cards_*` tree.
 */
export function renderProductCardMarkdown(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as RufusNode;

  // Category headers have a clean copyTemplate
  if (n.id?.startsWith("categoryHeader-") && n.copyTemplate) {
    const title = (n.copyTemplate.prefix || "").trim();
    return title ? `### ${title}` : "";
  }

  // Extract product title, price, rating, url, summary from nested children
  const texts: string[] = [];
  let price = "";
  let rating = "";
  let linkUrl = "";

  function walk(cur: unknown) {
    if (!cur || typeof cur !== "object") return;
    if (Array.isArray(cur)) {
      for (const item of cur) walk(item);
      return;
    }
    const obj = cur as RufusNode;
    if (!linkUrl && obj.onPress?.url && obj.onPress.url.includes("/dp/")) {
      linkUrl = obj.onPress.url;
    }
    if (obj.type === "price" && !obj.strikethrough && !price) {
      price = renderRufusMarkdown(obj);
      return;
    }
    if (obj.type === "rating" && !rating) {
      rating = renderRufusMarkdown(obj);
      return;
    }
    if (obj.type === "button") return; // skip "Add to cart" / "More details" buttons
    if (obj.type === "text" && typeof obj.children === "string") {
      const t = obj.children.trim();
      if (t && t.length > 1) texts.push(t);
      return;
    }
    if (obj.children) walk(obj.children);
  }

  walk(n);
  if (texts.length === 0) return "";
  const title = texts[0];
  const meta = [price, rating].filter(Boolean).join(" · ");
  const header = linkUrl ? `- **[${title}](${linkUrl})**` : `- **${title}**`;
  return meta ? `${header} — ${meta}` : header;
}

export function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export class RufusPatchTracker {
  private docs = new Map<string, unknown>();
  private emittedText = new Map<string, string>();
  private order: string[] = [];

  applyPatch(patch: JsonPatch): { groupId: string; isMarkdown: boolean; delta: string; fullText: string } {
    const groupId = patch.groupId || "default";
    if (!this.docs.has(groupId)) {
      this.order.push(groupId);
    }
    const updated = applyJsonPatch(this.docs.get(groupId) ?? null, patch);
    this.docs.set(groupId, updated);

    const isMarkdown = groupId.startsWith("markdown_processor");
    if (!isMarkdown) {
      return { groupId, isMarkdown: false, delta: "", fullText: "" };
    }

    // Strip trailing container suffix newline while streaming so partial words never get extra "\n"s.
    const fullText = renderRufusMarkdown(updated).replace(/\n+$/, "");
    const prev = this.emittedText.get(groupId) ?? "";

    // Stream monotonic appends; if Amazon rewrites an earlier span (e.g. wrapping a word in
    // inline code/link/bold), anchor on the tail of `prev` so we never duplicate OR drop text.
    let delta = "";
    if (fullText.startsWith(prev) && fullText.length > prev.length) {
      delta = fullText.slice(prev.length);
      this.emittedText.set(groupId, fullText);
    } else if (fullText.length > prev.length) {
      const anchorLen = Math.min(20, prev.length);
      const anchor = anchorLen >= 4 ? prev.slice(-anchorLen) : "";
      const anchorIdx = anchor ? fullText.lastIndexOf(anchor) : -1;
      if (anchorIdx >= 0) {
        const afterAnchor = anchorIdx + anchor.length;
        if (afterAnchor < fullText.length) {
          delta = fullText.slice(afterAnchor);
          this.emittedText.set(groupId, fullText);
        }
      } else if (prev.length === 0) {
        delta = fullText;
        this.emittedText.set(groupId, fullText);
      }
    }

    return { groupId, isMarkdown: true, delta, fullText };
  }

  getUnemittedTail(groupId: string): string {
    const doc = this.docs.get(groupId);
    if (!doc || !groupId.startsWith("markdown_processor")) return "";
    const fullText = renderRufusMarkdown(doc).replace(/\n+$/, "");
    const prev = this.emittedText.get(groupId) ?? "";
    if (fullText.startsWith(prev) && fullText.length > prev.length) {
      this.emittedText.set(groupId, fullText);
      return fullText.slice(prev.length);
    }
    return "";
  }

  getAllMarkdown(): string {
    const parts: string[] = [];
    for (const gid of this.order) {
      if (gid.startsWith("markdown_processor")) {
        const rendered = renderRufusMarkdown(this.docs.get(gid)).trim();
        if (rendered) parts.push(rendered);
      }
    }
    return parts.join("\n\n");
  }

  getProductCardsMarkdown(): string[] {
    const cards: string[] = [];
    for (const gid of this.order) {
      if (gid.startsWith("asin_cards_")) {
        const rendered = renderProductCardMarkdown(this.docs.get(gid)).trim();
        if (rendered) cards.push(rendered);
      }
    }
    return cards;
  }
}
