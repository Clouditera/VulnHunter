---
name: deveye
description: Browser debugging via DevEye CLI. Use when the user needs to see, inspect, or interact with a Chrome browser page - screenshots, DOM, console, network, performance, accessibility, Lighthouse audits, element picking, JS eval, cookie/storage inspection, and page actions (click, type, scroll, navigate, emulate, etc.).
---

# DevEye CLI - Browser Debugging via CLI

You can see and interact with the user's Chrome browser through the DevEye CLI.
Prerequisite: DevEye Chrome Extension must be installed and running, `deveye` CLI must be in PATH.

## When to Use

Use DevEye when the task involves:
- **Seeing the page**: "what does the page look like", "take a screenshot", "show me the UI"
- **Inspecting state**: "check for errors", "what API calls failed", "is the page accessible"
- **Finding elements**: "what's the selector for...", "where is the button", "find the form"
- **Interacting**: "click the button", "fill in the form", "scroll down", "navigate to URL"
- **Debugging**: "why is the page broken", "the layout looks wrong", "form isn't submitting"
- **Auditing**: "check performance", "run Lighthouse", "SEO audit", "check design tokens"
- **Monitoring**: "watch for console errors", "track network requests"
- **Emulating**: "test on mobile", "simulate slow network", "test responsive design"

## Core Concepts

- **Snapshot-first feedback**: every action command automatically returns an accessibility snapshot (text-based a11y tree), not a screenshot. This is fast and token-efficient. Add `--screenshot` only when you need pixel-level visual verification. Use `-o <path>` to save screenshots to a file.
- **Stable UIDs**: elements in the snapshot get stable unique IDs that survive DOM updates. Use `[uid=N]` selector syntax or `--uid N` to target elements reliably across interactions.
- **Hint field**: unnamed interactive elements include a `hint` with CSS selector and visible text (e.g., `@.next-btn 下一步`), so you can identify them even without an accessible name.
- **Smart completion**: after each action, DevEye waits for in-flight network requests and navigations to settle before returning the snapshot. Settle times are adaptive: type/hover/keyboard 200ms, scroll/select 300ms, click/drag 500ms.
- **Data integrity**: all data (passwords, cookies, headers, DOM) is returned as-is — DevEye never redacts data. AI needs complete data to debug effectively.

## Tool Selection Guide

| Intent | Recommended Command | When to use alternatives |
|--------|-------------------|------------------------|
| Observe page state | `snapshot` (fast, text) | `screenshot` only for pixel verification |
| Find elements | `snapshot --interactive-only` | `pick` for interactive element selection |
| Composite diagnosis | `inspect` | Add `--no-screenshot` for text-only |
| Input text | `type` | `--cdp --enter` for Monaco/xterm.js terminal; `--secure` for passwords |
| Fill multiple fields | `fill-form` | Single command for batch form fill (faster than repeated `type`) |
| Wait for condition | `wait <selector>` | `--text` for text appear; `--text-gone` for text disappear; `--url-contains` / `--title-contains` for URL/title change; `--eval` for JS expression condition |
| Chain commands | `chain "cmd1" "cmd2"` | Single-process sequential execution, reuses IPC connection |
| Captcha solving | `captcha-ocr` / `captcha-slide` | `detect --type captcha` only for detection |
| Export data | `bundle` (multi-capture JSON) | `export har` for HAR 1.2 format |

## Quick Reference

All commands support `--json` for structured output and `-t <tabId>` or `--index N` (1-based) for targeting a specific tab.

### Connectivity

`deveye ping` — test connection; `deveye ping --json` for version info

### Observe

| Command | Description |
|---------|-------------|
| `screenshot` | Capture page screenshot (`-o path`, `--full-page`, `--selector`, `--region`) |
| `dom` | HTML tree (`-s selector`, `--depth N`, `--interactive-only`, `--visible-only`) |
| `console` | Browser console (`--level error`, `--resolve-source-maps`) |
| `network` | Network requests (`--url pattern`, `--method`, `--detail`, `--body-limit`) |
| `performance` | Web Vitals (`--analyze` for AI-friendly diagnostics) |
| `accessibility` | WCAG audit via axe-core (`--standard`, `--selector`) |
| `tabs` | List all open tabs |
| `page-info` | Page metadata (title, URL, meta tags) |
| `snapshot` | A11y tree with UIDs (`--interactive-only`, `--visible-only`, `--viewport-only`) |
| `inspect` | Composite: screenshot + snapshot + console + network + perf (`--no-screenshot` for text-only) |
| `eval` | Execute JS in page context (`--no-snapshot` for pure data queries) |
| `storage` | Read/write cookies, localStorage, sessionStorage (`--set`, `--delete`, `--clear`) |
| `detect` | Smart element detection (`--type captcha/login/form`, `--keyword`, `--all`) |
| `seo` | Rule-based SEO analysis (`--category meta/headings/...`) |
| `animations` | CSS animations/transitions/libraries (`--detailed`) |
| `design-tokens` | Extract colors, fonts, spacing, CSS vars (`--include colors,fonts`) |
| `bookmarks` | Search Chrome bookmarks (`--search`, `--folder`) |
| `history` | Search browsing history (`--search`, `--since 7d`) |
| `download` | List/wait/save downloads (`list --no-url`, `wait -o path`, `save -o path`) |

Eval notes: uses `chrome.scripting.executeScript` (fast path), auto-falls back to `chrome.debugger` on CSP-strict pages. Supports async expressions.

### Act

Action commands share: `--screenshot` (capture PNG after action), `--human` (human-like behavior), `--uid <uid>` (target by snapshot UID).

#### click — click an element
```bash
deveye click "button.submit"                 # left click by selector
deveye click --text "Submit"                 # click by exact visible text
deveye click --contains-text "登"            # click by text substring
```
Key options: `--text`, `--contains-text`, `-b right/middle`, `--double`, `--uid`

#### type — fill an input field
```bash
deveye type "#search" "hello" --enter        # type + Enter
deveye type --cdp ".xterm-screen" "echo hello" --enter  # terminal: type command + execute
deveye type --secure --vault-key "pwd" "#password" --clear  # secure fill from vault
```
Key options: `--clear`, `--enter`, `--submit [selector]`, `--secure --vault-key`, `--cdp` (Monaco/xterm.js — combine with `--enter` for terminal commands)

#### fill-form — batch fill multiple fields
`deveye fill-form '[{"ref":"e1","value":"John"},{"ref":"e2","value":"john@example.com"}]'`
Field object: `ref`/`uid`/`selector` + `value` + optional `type` (textbox/checkbox/combobox/radio/slider)

#### wait — wait for a condition
```bash
deveye wait ".loading" -s hidden             # wait until element hidden
deveye wait --text "Success"                 # wait for text to appear
deveye wait --url-contains "dashboard"       # wait for URL change (replaces sleep)
deveye wait --eval "document.querySelectorAll('tr').length > 1" --timeout 5000
```
Key options: `--text`, `--text-gone`, `--url-contains`, `--title-contains`, `--eval`, `-s visible/hidden/attached/detached`, `--timeout`

#### scroll — scroll the page or element
`deveye scroll down` / `deveye scroll down -s ".container" -a 200`
Key options: `-a amount`, `-s selector`

#### select — select dropdown option
`deveye select "#country" -l "China"` / `deveye select "#country" -v "CN"`
Key options: `-l label`, `-v value`, `-i index`

#### keyboard — send keyboard shortcuts
`deveye keyboard "Control+a"` — use `--cdp` for Monaco/xterm.js

#### Other actions

| Command | Usage |
|---------|-------|
| `hover` | `deveye hover ".tooltip-trigger"` |
| `check` | `deveye check "#agree" --checked` / `--unchecked` |
| `drag` | `deveye drag ".draggable" ".drop-zone"` |
| `upload` | `deveye upload "#file-input" ./test.pdf` |
| `open` | `deveye open "https://example.com"` (`--background`) |
| `navigate` | `goto URL`, `back`, `forward`, `reload` (`--wait-for selector`, `--bypass-cache`) |
| `close` | `deveye close` / `deveye close -t 12345` |
| `dialog` | `deveye dialog accept` / `dismiss` / `accept "text"` |
| `pause-animations` | Freeze CSS animations for stable screenshots |
| `resume-animations` | Resume paused animations |

### Discover & Utility

| Command | Usage |
|---------|-------|
| `pick` | Interactive element picker (`--detail detailed`, `-o /tmp/picked.png`) |
| `annotate` | Page annotations (`create -s ".el" -c "Bug"`, `list`, `resolve -a <id>`, `clear`) |
| `stealth` | Bot detection bypass (`enable`, `disable`, `test`, `status`) |
| `emulate` | Device/network emulation (`device iphone-14`, `network slow-3g`, `reset`) |

Devices: `iphone-14`, `iphone-se`, `ipad-air`, `pixel-7`, `desktop-hd` | Networks: `slow-3g`, `fast-3g`, `4g`, `offline`

### Captcha (AI Recognition)

`captcha-ocr --selector ".captcha-img"` (OCR) | `captcha-slide --target ".slider" --background ".bg"` (slider) | `captcha-detect --selector ".img"` (YOLOX)

### Data Export

`deveye bundle -o /tmp/page.json` (multi-capture JSON) | `deveye export har -o /tmp/trace.har` (HAR 1.2)

### Audit (Lighthouse)

No Extension needed if `--url` is provided. `deveye audit all --url https://example.com` | `audit performance` | `audit all -o /tmp/report.html`

### Chain (Sequential Multi-Command)

`deveye chain "navigate goto \"https://example.com\"" "wait \".main\"" "snapshot"`
Key options: `--delay ms`, `--continue-on-error`

### Server Mode

`deveye server start -d` (daemon) | `deveye server stop` | `deveye server status`
Key options: `-p port`, `-H host`, `--token secret`, `--extension-path <dir>`, `--chrome-path <path>`, `--session-timeout <sec>`

### Remote Browser Mode

For headless containers or remote machines without Chrome — connect to a remote server that manages browser instances.

**Remote server setup (GUI machine, one-time):**
```bash
deveye server start --host 0.0.0.0 --port 9888 --token my-secret --extension-path /path/to/extension/dist
```

**Container/client usage:**
```bash
export DEVEYE_SERVER=ws://remote-host:9888
export DEVEYE_TOKEN=my-secret

# Create a browser instance
BROWSER_ID=$(deveye browser create --json | jq -r .browserId)

# Use all commands with --browser-id
deveye --browser-id $BROWSER_ID open "https://example.com"
deveye --browser-id $BROWSER_ID screenshot -o /tmp/shot.png
deveye --browser-id $BROWSER_ID click "#login"

# Destroy when done
deveye browser destroy --browser-id $BROWSER_ID
```

**Browser management commands:**
| Command | Description |
|---------|-------------|
| `browser create` | Create browser instance (`--headless`, `--json`) |
| `browser destroy` | Destroy instance (`--browser-id <id>`) |
| `browser list` | List all active instances (`--json`) |

**Environment variables:**
| Variable | Description |
|----------|-------------|
| `DEVEYE_SERVER` | Remote server URL (`ws://host:port`) |
| `DEVEYE_TOKEN` | Authentication token |
| `DEVEYE_BROWSER_ID` | Default browser instance ID (avoids `--browser-id` on every command) |

### TOTP (Time-based One-Time Password)

`totp register --name "github"` | `totp get --name "github"` | `totp autofill --name "github" --submit "button"` | `totp list`
Accounts stored in vault (`~/.deveye/vault.enc`), encrypted with AES-256-GCM.

### Vault (Secure Storage)

`vault init` | `vault add --key "pwd" --from-env SECRET` | `vault list`
Use `type --secure --vault-key <name>` to fill passwords without exposing them to AI.

## Anti-patterns

- **Don't manually call `snapshot` after actions** — every action command already returns a snapshot automatically
- **Don't use `screenshot` to find elements** — use `snapshot` (text, fast, structured) or `pick` (interactive)
- **Don't use `sleep`/delay to wait for page changes** — use `wait --url-contains`, `wait --text`, or `wait --eval`
- **Don't use `type` for keyboard shortcuts** — use `keyboard "Control+a"` (type needs a target element, keyboard sends to active focus)
- **Don't repeat `type` for multiple fields** — use `fill-form` for batch fill in one command

## Workflows

### Debugger Mode

1. **Observe**: `inspect` (or `console --level error` + `network --url "/api"`)
2. **Hypothesize**: list 3-5 possible root causes, narrow to 1-2
3. **Collect targeted data**: `dom -s "selector"`, `network --detail`, `performance`
4. **Fix and verify**: apply fix → `inspect` again → confirm errors resolved
5. **Regression check**: `accessibility` + `performance` + confirm no new console errors

### Audit Mode

1. `deveye audit all --json` — get scores across all categories
2. Cross-reference: `accessibility` (live axe-core), `seo` (rule-based), `design-tokens --detailed`
3. Prioritize fixes by impact, apply in order, re-run specific audits to measure improvement
4. Final report: `deveye audit all -o /tmp/audit-report.html`

## Tips

- `eval` returns post-action snapshot by default; use `--no-snapshot` for pure data queries
- `download list` defaults to 3 items; use `--no-url` to save tokens on long signed URLs
- Use `fill-form` to batch-fill multiple fields in one command instead of repeated `type` calls
- `deveye pick` to find the right selector interactively
- Console errors are the fastest way to diagnose issues
- For repeated commands, start `deveye server start -d` to avoid reconnection delay
- Use `deveye pause-animations` before screenshot for pages with heavy animations
- Use `navigate --wait-for` to navigate and wait for a key element in one step
- Use `--submit` with `type` or `totp autofill` to combine input + submit in one command
- Use `deveye download wait -o <path>` after triggering a download button to capture the file

## References

| Document | Content |
|----------|---------|
| [Command Reference](references/command-reference.md) | All commands with full flags and options |
| [Error Handling](references/error-handling.md) | Error categories, performance budgets, degradation strategies |
| [Examples](references/examples.md) | End-to-end debugging workflow examples |
