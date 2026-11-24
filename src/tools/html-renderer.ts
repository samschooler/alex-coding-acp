export interface ShowcaseItem {
  name: string;
  price?: string | number;
  originalPrice?: string | number;
  rating?: string | number;
  reviews?: string | number;
  url?: string;
  asin?: string;
  badge?: string;
  notes?: string;
  highlights?: string[];
  [key: string]: unknown;
}

export interface ShowcaseSection {
  heading?: string;
  title?: string;
  body?: string;
  text?: string;
  bullets?: string[];
  items?: string[];
}

export interface ShowcaseSpec {
  title?: string;
  subtitle?: string;
  intro?: string;
  sections?: ShowcaseSection[];
  items: ShowcaseItem[];
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (/^https?:\/\/\S+$/i.test(trimmed)) return trimmed;
  return null;
}

function formatPrice(val: unknown): string | null {
  if (typeof val === "number" && Number.isFinite(val)) return `$${val.toFixed(2)}`;
  if (typeof val === "string" && val.trim()) {
    const t = val.trim();
    return /^\d+(\.\d+)?$/.test(t) ? `$${t}` : t;
  }
  return null;
}

function tryParseShowcaseJson(raw: string): ShowcaseSpec | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const candidates = [cleaned];
  const firstBrace = cleaned.search(/[\[{]/);
  const lastBrace = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed)) {
        const items = parsed.filter((x): x is ShowcaseItem => Boolean(x && typeof x === "object"));
        if (items.length > 0) return { items };
      }
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const list = obj.items ?? obj.products ?? obj.picks ?? obj.chargers ?? obj.deals ?? obj.filters;
        if (Array.isArray(list)) {
          const items = list.filter((x): x is ShowcaseItem => Boolean(x && typeof x === "object"));
          if (items.length > 0) {
            const sections = Array.isArray(obj.sections)
              ? obj.sections.filter((s): s is ShowcaseSection => Boolean(s && typeof s === "object"))
              : undefined;
            return {
              title: typeof obj.title === "string" ? obj.title : typeof obj.shopName === "string" ? obj.shopName : undefined,
              subtitle:
                typeof obj.subtitle === "string"
                  ? obj.subtitle
                  : typeof obj.tagline === "string"
                    ? obj.tagline
                    : typeof obj.description === "string"
                      ? obj.description
                      : undefined,
              intro:
                typeof obj.intro === "string"
                  ? obj.intro
                  : typeof obj.about === "string"
                    ? obj.about
                    : typeof obj.shopIntro === "string"
                      ? obj.shopIntro
                      : undefined,
              sections,
              items,
            };
          }
        }
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

function renderInlineMarkdown(text: string): string {
  // Escape HTML first, then convert safe markdown links, bold, and inline code.
  let out = escapeHtml(text);
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  // Autolink bare Amazon/https URLs not already inside href="..."
  out = out.replace(
    /(^|[\s(>])(https?:\/\/[^\s<)]+)/g,
    '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>'
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  return out;
}

function renderMarkdownBody(md: string): { title: string; bodyHtml: string } {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let title = "Shopping Showcase";
  const blocks: string[] = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      blocks.push("</ul>");
      inList = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      continue;
    }

    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) {
      closeList();
      title = h1[1].trim();
      blocks.push(`<h1>${renderInlineMarkdown(title)}</h1>`);
      continue;
    }

    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      closeList();
      blocks.push(`<h2>${renderInlineMarkdown(h2[1].trim())}</h2>`);
      continue;
    }

    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      closeList();
      blocks.push(`<h3>${renderInlineMarkdown(h3[1].trim())}</h3>`);
      continue;
    }

    const bullet = line.match(/^(?:[-*•]|\d+\.)\s+(.+)$/);
    if (bullet) {
      if (!inList) {
        blocks.push("<ul>");
        inList = true;
      }
      blocks.push(`<li>${renderInlineMarkdown(bullet[1].trim())}</li>`);
      continue;
    }

    closeList();
    blocks.push(`<p>${renderInlineMarkdown(line)}</p>`);
  }
  closeList();

  return { title, bodyHtml: blocks.join("\n") };
}

function renderShowcaseCards(spec: ShowcaseSpec, fallbackTitle: string): { title: string; bodyHtml: string } {
  const title = spec.title || fallbackTitle;
  const headerHtml = [
    `<header class="hero">`,
    `  <span class="eyebrow">Curated with Alexa for Shopping</span>`,
    `  <h1>${escapeHtml(title)}</h1>`,
    spec.subtitle ? `  <p class="subtitle">${escapeHtml(spec.subtitle)}</p>` : "",
    spec.intro ? `  <p class="intro">${escapeHtml(spec.intro)}</p>` : "",
    `</header>`,
  ]
    .filter(Boolean)
    .join("\n");

  const promotedSections: ShowcaseSection[] = [...(spec.sections || [])];
  const productItems: ShowcaseItem[] = [];
  for (const item of spec.items) {
    const itemType = typeof item.type === "string" ? item.type.toLowerCase() : "";
    const isEditorial =
      ["intro", "section", "editorial", "about", "hero", "text"].includes(itemType) ||
      (!item.price && !item.priceUSD && !item.price_usd && !item.url && !item.link && !item.asin && (item.heading || item.body));
    if (isEditorial) {
      promotedSections.push({
        heading: typeof item.heading === "string" ? item.heading : typeof item.title === "string" ? item.title : typeof item.name === "string" ? item.name : undefined,
        body: typeof item.body === "string" ? item.body : typeof item.text === "string" ? item.text : typeof item.description === "string" ? item.description : typeof item.notes === "string" ? item.notes : undefined,
        bullets: Array.isArray(item.bullets) ? item.bullets.map(String) : undefined,
      });
    } else {
      productItems.push(item);
    }
  }

  const sectionsHtml = promotedSections
    .map((sec) => {
      const heading = sec.heading || sec.title;
      const body = sec.body || sec.text;
      const bullets = Array.isArray(sec.bullets) ? sec.bullets : Array.isArray(sec.items) ? sec.items : [];
      return [
        `<section class="editorial">`,
        heading ? `  <h2>${escapeHtml(heading)}</h2>` : "",
        body ? `  <p>${escapeHtml(body)}</p>` : "",
        bullets.length > 0
          ? `  <ul>\n${bullets.map((b) => `    <li>${escapeHtml(String(b))}</li>`).join("\n")}\n  </ul>`
          : "",
        `</section>`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  const cardsHtml = productItems
    .map((item) => {
      const name = String(item.name || item.title || item.heading || item.product || "Amazon Pick");
      const price = formatPrice(item.price ?? item.priceUSD ?? item.price_usd ?? item.dealPrice);
      const origPrice = formatPrice(item.originalPrice ?? item.listPrice ?? item.typicalPrice);
      const rating = item.rating != null ? String(item.rating) : null;
      const reviews = item.reviews != null ? String(item.reviews) : null;
      const url =
        safeUrl(item.url ?? item.link) ||
        (typeof item.asin === "string" && /^[A-Z0-9]{10}$/i.test(item.asin.trim())
          ? `https://www.amazon.com/dp/${item.asin.trim()}`
          : null);
      const badge = typeof item.badge === "string" ? item.badge : null;
      const notes =
        typeof item.notes === "string"
          ? item.notes
          : typeof item.description === "string"
            ? item.description
            : typeof item.body === "string"
              ? item.body
              : typeof item.why === "string"
                ? item.why
                : typeof item.highlights === "string"
                  ? item.highlights
                  : null;

      // Collect any extra structured attributes (wattage, ports, brand, etc.) as clean pills
      const skipKeys = new Set([
        "type",
        "kind",
        "name",
        "title",
        "heading",
        "product",
        "price",
        "priceUSD",
        "price_usd",
        "dealPrice",
        "originalPrice",
        "listPrice",
        "typicalPrice",
        "rating",
        "reviews",
        "url",
        "link",
        "asin",
        "badge",
        "notes",
        "description",
        "body",
        "why",
        "highlights",
      ]);
      const highlights: string[] = Array.isArray(item.highlights)
        ? item.highlights.map((h) => String(h))
        : [];
      for (const [k, v] of Object.entries(item)) {
        if (skipKeys.has(k) || v == null || typeof v === "object") continue;
        const label = k.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim();
        highlights.push(`${label}: ${String(v)}`);
      }

      return [
        `<article class="card">`,
        badge ? `  <span class="badge">${escapeHtml(badge)}</span>` : "",
        `  <h2>${escapeHtml(name)}</h2>`,
        `  <div class="meta">`,
        price ? `    <span class="price">${escapeHtml(price)}</span>` : "",
        origPrice ? `    <span class="orig-price">${escapeHtml(origPrice)}</span>` : "",
        rating
          ? `    <span class="rating">★ ${escapeHtml(rating)}${reviews ? ` (${escapeHtml(reviews)})` : ""}</span>`
          : "",
        `  </div>`,
        notes ? `  <p class="notes">${escapeHtml(notes)}</p>` : "",
        highlights.length > 0
          ? `  <ul class="specs">\n${highlights
              .map((h) => `    <li>${escapeHtml(h)}</li>`)
              .join("\n")}\n  </ul>`
          : "",
        url
          ? `  <a class="cta" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">View on Amazon →</a>`
          : "",
        `</article>`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  return {
    title,
    bodyHtml: [headerHtml, sectionsHtml, `<section class="grid">\n${cardsHtml}\n</section>`]
      .filter(Boolean)
      .join("\n"),
  };
}

/**
 * Converts structured JSON or Markdown drafted by Alexa into a standalone, responsive HTML page.
 * If `raw` already looks like an HTML document, returns it as-is.
 */
export function renderShoppingHtml(raw: string, filename = "index.html"): string {
  const trimmed = raw.trim();
  if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return `${trimmed}\n`;
  }

  const baseTitle = filename
    .replace(/^.*\//, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const fallbackTitle = baseTitle && baseTitle.toLowerCase() !== "index" ? baseTitle : "Shopping Picks";

  const jsonSpec = tryParseShowcaseJson(trimmed);
  const { title, bodyHtml } = jsonSpec
    ? renderShowcaseCards(jsonSpec, fallbackTitle)
    : renderMarkdownBody(trimmed);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #fafafa;
      --surface: #ffffff;
      --text: #111827;
      --muted: #6b7280;
      --border: #e5e7eb;
      --accent: #f59e0b;
      --accent-ink: #111827;
      --link: #0369a1;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b0d12;
        --surface: #141821;
        --text: #f3f4f6;
        --muted: #9ca3af;
        --border: #262c3a;
        --accent: #fbbf24;
        --accent-ink: #111827;
        --link: #38bdf8;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 2.5rem 1.25rem;
    }
    main {
      max-width: 960px;
      margin: 0 auto;
    }
    .hero { margin-bottom: 2rem; }
    .eyebrow {
      display: inline-block;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 0.5rem;
    }
    h1 { font-size: clamp(1.75rem, 3.5vw, 2.5rem); margin: 0 0 0.5rem; line-height: 1.2; }
    h2 { font-size: 1.15rem; margin: 0 0 0.75rem; line-height: 1.35; }
    .subtitle { color: var(--muted); margin: 0; font-size: 1.05rem; }
    .intro { margin: 1rem 0 0; font-size: 1rem; max-width: 68ch; }
    .editorial {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 1.35rem;
      margin-bottom: 1.25rem;
    }
    .editorial p { margin: 0.4rem 0 0; color: var(--muted); }
    .editorial ul { margin: 0.6rem 0 0; padding-left: 1.15rem; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1.25rem;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 1.35rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .badge {
      align-self: flex-start;
      background: var(--accent);
      color: var(--accent-ink);
      font-size: 0.72rem;
      font-weight: 700;
      padding: 0.2rem 0.55rem;
      border-radius: 999px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.65rem; }
    .price { font-size: 1.35rem; font-weight: 700; }
    .orig-price { color: var(--muted); text-decoration: line-through; font-size: 0.9rem; }
    .rating { color: var(--muted); font-size: 0.9rem; }
    .notes { margin: 0; color: var(--muted); font-size: 0.95rem; }
    .specs { margin: 0; padding-left: 1.15rem; font-size: 0.9rem; color: var(--text); }
    .specs li { margin-bottom: 0.25rem; }
    .cta {
      margin-top: auto;
      display: inline-block;
      text-align: center;
      text-decoration: none;
      background: var(--accent);
      color: var(--accent-ink);
      font-weight: 600;
      padding: 0.6rem 1rem;
      border-radius: 10px;
    }
    .cta:hover { filter: brightness(0.95); }
    a { color: var(--link); }
    .markdown {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 1.75rem;
    }
    footer {
      margin-top: 2.5rem;
      font-size: 0.82rem;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <main class="${jsonSpec ? "showcase" : "markdown"}">
${bodyHtml}
    <footer>Prices and availability are from Amazon listings at generation time and may change.</footer>
  </main>
</body>
</html>
`;
}
