/**
 * Markdown renderer for chat assistant messages.
 *
 * Adapted from the bossmode project's Markdown.tsx — keeps the same
 * react-markdown + remark-gfm foundation (so GFM tables, task lists,
 * strikethrough, and autolinks all work out of the box) but swaps the
 * Tailwind class-based styling for VulnHunter's CSS-variable + inline-style
 * system (matches the rest of the app).
 *
 * We deliberately do NOT pull in react-syntax-highlighter here — it would
 * add ~400KB to the bundle for a feature the LLM rarely exercises in
 * chat. Fenced code blocks fall back to a plain <pre><code> with monospace
 * styling. If we later want highlighting, we can swap in Prism/Shiki
 * behind the same `code` component.
 */

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CSSProperties } from "react";

/** Inline code: texture, not cards (design-spec-markdown-typography-v1.0). */
const CODE_INLINE: CSSProperties = {
  padding: "1px 4px",
  borderRadius: 4,
  // N9 ~10% light / ~14% dark via token (tokens.css)
  background: "var(--md-code-inline-bg)",
  // no border — was slicing CJK sentences into chips
  fontFamily: "var(--font-mono)",
  fontSize: "0.92em",
};

const CODE_BLOCK: CSSProperties = {
  margin: "6px 0 10px",
  padding: "12px 14px",
  background: "var(--bg-page)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  overflow: "auto",
  fontSize: "12.5px",
  fontFamily: "var(--font-mono)",
  lineHeight: 1.6,
};

const LINK: CSSProperties = {
  color: "var(--brand)",
  textDecoration: "underline",
};

const TABLE_WRAP: CSSProperties = {
  margin: "6px 0 12px",
  overflow: "auto",
  border: "1px solid var(--border)",
  borderRadius: 8,
};

const TABLE: CSSProperties = {
  borderCollapse: "collapse",
  fontSize: "13px",
  width: "100%",
  minWidth: "40%",
};

const TH: CSSProperties = {
  padding: "8px 14px",
  textAlign: "left",
  fontWeight: 600,
  fontSize: 12,
  borderBottom: "1px solid var(--divider)",
  color: "var(--text-primary)",
  whiteSpace: "nowrap",
  background: "var(--bg-header)",
};

const TD: CSSProperties = {
  padding: "8px 14px",
  borderBottom: "1px solid var(--divider)",
  verticalAlign: "top",
};

const BLOCKQUOTE: CSSProperties = {
  margin: "8px 0",
  padding: "2px 0 2px 12px",
  borderLeft: "3px solid var(--divider)",
  color: "var(--text-secondary)",
};

const H1: CSSProperties = {
  fontSize: 20,
  fontWeight: 700,
  margin: "20px 0 10px",
  color: "var(--text-primary)",
};
const H2: CSSProperties = {
  fontSize: 16,
  fontWeight: 650,
  margin: "16px 0 8px",
  paddingBottom: 4,
  borderBottom: "1px solid var(--divider)",
  color: "var(--text-primary)",
};
const H3: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  margin: "12px 0 6px",
  color: "var(--text-primary)",
};
const H4: CSSProperties = { ...H3, fontSize: 13, fontWeight: 600 };

const baseComponents: Components = {
  // Code: inline vs fenced. `className` is "language-xxx" for fenced blocks.
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || "");
    const isInline = !match && !className;
    if (isInline) {
      return (
        <code style={CODE_INLINE} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => <pre style={CODE_BLOCK}>{children}</pre>,
  p: ({ children }) => <p style={{ margin: "0 0 10px", lineHeight: 1.75 }}>{children}</p>,
  ul: ({ children }) => (
    <ul style={{ margin: "0 0 8px 20px", padding: 0, listStyle: "disc" }}>
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol style={{ margin: "0 0 8px 22px", padding: 0 }}>{children}</ol>
  ),
  li: ({ children }) => <li style={{ marginBottom: 4 }}>{children}</li>,
  h1: ({ children }) => <h1 style={H1}>{children}</h1>,
  h2: ({ children }) => <h2 style={H2}>{children}</h2>,
  h3: ({ children }) => <h3 style={H3}>{children}</h3>,
  h4: ({ children }) => <h4 style={H4}>{children}</h4>,
  a: ({ href, children }) => {
    // Detect autolinked URLs inside code blocks: if the link text IS the URL,
    // render as plain code text to avoid breaking code block styling.
    const text = typeof children === "string" ? children : "";
    const isAutolink = text === href;
    if (isAutolink) {
      return <span>{children}</span>;
    }
    return (
      <a href={href} style={LINK} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  blockquote: ({ children }) => (
    <blockquote style={BLOCKQUOTE}>{children}</blockquote>
  ),
  table: ({ children }) => (
    <div style={TABLE_WRAP}>
      <table style={TABLE}>{children}</table>
    </div>
  ),
  th: ({ children }) => <th style={TH}>{children}</th>,
  td: ({ children }) => <td style={TD}>{children}</td>,
  hr: () => (
    <hr
      style={{
        border: "none",
        borderTop: "1px solid var(--divider)",
        margin: "12px 0",
      }}
    />
  ),
  del: ({ children }) => (
    <del style={{ color: "var(--text-secondary)" }}>{children}</del>
  ),
  strong: ({ children }) => <strong>{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
};

export type MarkdownLinkOptions = {
  /** Wiki: navigate among known wiki pages. */
  onRelativeLink?: (href: string) => void;
  /** Wiki: only these relative targets become links; others plain text (VULNHUN-165). */
  isRelativeLinkAllowed?: (href: string) => boolean;
  /** Chat: workspace/file paths open artifact panel instead of browser nav (VULNHUN-159). */
  onWorkspaceLink?: (href: string) => void;
};

function isHttpUrl(href: string): boolean {
  return /^https?:\/\//i.test(href) || href.startsWith("mailto:");
}

function isRelativeMd(href: string): boolean {
  return !/^[a-z]+:\/\//i.test(href) && !href.startsWith("/") && !href.startsWith("#");
}

function isWorkspacePath(href: string): boolean {
  if (!href) return false;
  if (href.startsWith("/workspace/") || href.startsWith("workspace/")) return true;
  // bare relative file-ish paths (reports, attachments)
  if (isRelativeMd(href) && /\.(md|txt|json|ya?ml|csv|log|pdf|docx?|xlsx?|zip|png|jpe?g|gif|webp)$/i.test(href))
    return true;
  return false;
}

/** Build the component map with optional link policies. */
function buildComponents(opts: MarkdownLinkOptions = {}): Components {
  const { onRelativeLink, isRelativeLinkAllowed, onWorkspaceLink } = opts;
  return {
    ...baseComponents,
    a: ({ href, children }) => {
      const text = typeof children === "string" ? children : "";
      const h = href ?? "";

      // Relative wiki-style links
      if (h && isRelativeMd(h)) {
        const allowed = isRelativeLinkAllowed ? isRelativeLinkAllowed(h) : !!onRelativeLink;
        if (allowed && onRelativeLink) {
          return (
            <a
              href={h}
              style={{ ...LINK, cursor: "pointer" }}
              onClick={(e) => {
                e.preventDefault();
                onRelativeLink(h);
              }}
            >
              {children}
            </a>
          );
        }
        // Outside wiki set or no handler → plain text (no dead link)
        return <span data-testid="md-plain-link">{children}</span>;
      }

      // Workspace / file paths in chat → artifact handler or plain text
      if (h && isWorkspacePath(h)) {
        if (onWorkspaceLink) {
          return (
            <a
              href={h}
              style={{ ...LINK, cursor: "pointer" }}
              onClick={(e) => {
                e.preventDefault();
                onWorkspaceLink(h);
              }}
            >
              {children}
            </a>
          );
        }
        return <span data-testid="md-plain-link">{children}</span>;
      }

      // Autolinked URLs that equal link text inside code-ish contexts
      if (text === h && !isHttpUrl(h)) return <span>{children}</span>;

      if (h && isHttpUrl(h)) {
        return (
          <a href={h} style={LINK} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      }

      // Unknown schemes / anchors: plain text to avoid broken navigation
      if (h.startsWith("#")) {
        return (
          <a href={h} style={LINK}>
            {children}
          </a>
        );
      }
      return <span data-testid="md-plain-link">{children}</span>;
    },
  };
}

export function Markdown({
  content,
  onRelativeLink,
  isRelativeLinkAllowed,
  onWorkspaceLink,
}: {
  content: string;
} & MarkdownLinkOptions) {
  return (
    <ReactMarkdown
      remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
      components={buildComponents({ onRelativeLink, isRelativeLinkAllowed, onWorkspaceLink })}
    >
      {content}
    </ReactMarkdown>
  );
}
