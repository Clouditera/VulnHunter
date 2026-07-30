/**
 * Toolbar filter dropdown — design-spec-filter-dropdown-v1.0.md
 * Shared by tasks page size / sort / user filter.
 */

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Icon } from "./Icon.js";

export type FilterOption = { value: string; label: string };

export function FilterDropdown({
  value,
  options,
  onChange,
  testid,
  width,
}: {
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
  testid: string;
  width?: number | string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value) ?? options[0];
  const activeIdx = Math.max(0, options.findIndex((o) => o.value === value));

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(v: string) {
    onChange(v);
    setOpen(false);
  }

  function onTriggerKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onListKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = options[Math.min(options.length - 1, activeIdx + 1)];
      if (next) onChange(next.value);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = options[Math.max(0, activeIdx - 1)];
      if (prev) onChange(prev.value);
    } else if (e.key === "Enter") {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        data-testid={testid}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKey}
        style={{
          ...TRIGGER,
          width: width ?? "auto",
          minWidth: width ?? 108,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected?.label ?? value}
        </span>
        <Icon
          name="chevron-down"
          size={12}
          style={{
            color: "var(--icon-muted, var(--text-secondary))",
            flexShrink: 0,
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 0.15s",
          }}
        />
      </button>
      {open ? (
        <ul
          id={listId}
          role="listbox"
          tabIndex={-1}
          onKeyDown={onListKey}
          data-testid={`${testid}-menu`}
          style={MENU}
        >
          {options.map((o) => {
            const sel = o.value === value;
            return (
              <li
                key={o.value}
                role="option"
                aria-selected={sel}
                data-testid={`${testid}-option-${o.value}`}
                onClick={() => pick(o.value)}
                style={{
                  ...OPTION,
                  background: sel ? "var(--bg-active-filter)" : "transparent",
                  color: sel ? "var(--brand)" : "var(--text-primary)",
                  fontWeight: 400,
                }}
                onMouseEnter={(e) => {
                  if (!sel) e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = sel ? "var(--bg-active-filter)" : "transparent";
                }}
              >
                <span style={{ flex: 1 }}>{o.label}</span>
                {sel ? (
                  <Icon name="check" size={14} style={{ color: "var(--brand)", flexShrink: 0 }} />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

const TRIGGER: CSSProperties = {
  height: 30,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "0 10px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  fontSize: 12,
  fontWeight: 400,
  fontFamily: "inherit",
  cursor: "pointer",
  outline: "none",
};

const MENU: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  left: 0,
  zIndex: 50,
  minWidth: "100%",
  margin: 0,
  padding: 4,
  listStyle: "none",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
  maxHeight: 280,
  overflowY: "auto",
};

const OPTION: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 28,
  padding: "0 10px",
  borderRadius: 6,
  fontSize: 12,
  cursor: "pointer",
  userSelect: "none",
};
