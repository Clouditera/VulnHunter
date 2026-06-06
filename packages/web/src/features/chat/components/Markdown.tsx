/**
 * Markdown renderer for chat assistant messages.
 *
 * Adapted from the bossmode project's Markdown.tsx — keeps the same
 * react-markdown + remark-gfm foundation (so GFM tables, task lists,
 * strikethrough, and autolinks all work out of the box) but swaps the
 * Tailwind class-based styling for VulnAgent's CSS-variable + inline-style
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

const CODE_INLINE: CSSProperties = {
  padding: "1px 6px",
  borderRadius: "3px",
  background: "var(--bg-page)",
  border: "1px solid var(--divider)",
  fontFamily: "'SF Mono', Menlo, Consolas, monospace",
  fontSize: "12.5px",
};

const CODE_BLOCK: CSSProperties = {
  margin: "6px 0 10px",
  padding: "12px 14px",
  background: "var(--bg-page)",
  border: "1px solid var(--divider)",
  borderRadius: "6px",
  overflow: "auto",
  fontSize: "12.5px",
  fontFamily: "'SF Mono', Menlo, Consolas, monospace",
  lineHeight: 1.5,
};

const LINK: CSSProperties = {
  color: "var(--brand)",
  textDecoration: "underline",
};

const TABLE_WRAP: CSSProperties = {
  margin: "6px 0 12px",
  overflow: "auto",
};

const TABLE: CSSProperties = {
  borderCollapse: "collapse",
  fontSize: "13px",
  width: "auto",
  minWidth: "40%",
};

const TH: CSSProperties = {
  padding: "6px 12px",
  textAlign: "left",
  fontWeight: 600,
  borderBottom: "2px solid var(--divider)",
  color: "var(--text-primary)",
  whiteSpace: "nowrap",
  background: "var(--bg-page)",
};

const TD: CSSProperties = {
  padding: "6px 12px",
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
  fontSize: "18px",
  fontWeight: 700,
  margin: "12px 0 8px",
  color: "var(--text-primary)",
};
const H2: CSSProperties = {
  fontSize: "16px",
  fontWeight: 700,
  margin: "10px 0 6px",
  color: "var(--text-primary)",
};
const H3: CSSProperties = {
  fontSize: "14.5px",
  fontWeight: 700,
  margin: "10px 0 4px",
  color: "var(--text-primary)",
};
const H4: CSSProperties = { ...H3, fontSize: "13.5px" };

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
  p: ({ children }) => <p style={{ margin: "0 0 8px", lineHeight: 1.7 }}>{children}</p>,
  ul: ({ children }) => (
    <ul style={{ margin: "0 0 8px 20px", padding: 0, listStyle: "disc" }}>
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol style={{ margin: "0 0 8px 22px", padding: 0 }}>{children}</ol>
  ),
  li: ({ children }) => <li style={{ marginBottom: "2px" }}>{children}</li>,
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

/** Build the component map, optionally intercepting relative .md links. */
function buildComponents(onRelativeLink?: (href: string) => void): Components {
  if (!onRelativeLink) return baseComponents;
  return {
    ...baseComponents,
    a: ({ href, children }) => {
      const text = typeof children === "string" ? children : "";
      // Intercept relative links FIRST (before the autolink guard). In the wiki
      // index the link text often equals the href (e.g. `[overview.md](overview.md)`),
      // which would otherwise be swallowed by the autolink → <span> branch.
      // Relative = no scheme, no leading slash, not a pure anchor.
      const isRelative =
        !!href && !/^[a-z]+:\/\//i.test(href) && !href.startsWith("/") && !href.startsWith("#");
      if (isRelative) {
        return (
          <a
            href={href}
            style={{ ...LINK, cursor: "pointer" }}
            onClick={(e) => {
              e.preventDefault();
              onRelativeLink(href!);
            }}
          >
            {children}
          </a>
        );
      }
      // Autolinked URLs inside code blocks: link text IS the URL — render plain.
      if (text === href) return <span>{children}</span>;
      return (
        <a href={href} style={LINK} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
  };
}
export function Markdown({
  content,
  onRelativeLink,
}: {
  content: string;
  onRelativeLink?: (href: string) => void;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
      components={buildComponents(onRelativeLink)}
    >
      {content}
    </ReactMarkdown>
  );
}
