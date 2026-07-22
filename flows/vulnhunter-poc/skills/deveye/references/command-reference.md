# DevEye Command Reference

Complete reference for all CLI commands.

## Global Options

| Flag | Description |
|------|-------------|
| `--json` | Output as structured JSON |
| `-t, --tab-id <id>` | Target specific tab by ID |
| `--index <N>` | Target tab by 1-based index |
| `-p, --port <port>` | WebSocket port (default: 9888) |
| `-o, --output <path>` | Save output to file |

## Observation Commands

### screenshot

Capture page screenshot. Use Read tool to view the image.

```bash
deveye screenshot -o /tmp/shot.png
deveye screenshot --full-page -o /tmp/shot.png     # full page
deveye screenshot --selector ".my-element" -o /tmp/shot.png  # element only
deveye screenshot --region -o /tmp/shot.png        # interactively drag to select region
```

| Flag | Description |
|------|-------------|
| `--full-page` | Capture entire scrollable page |
| `--selector <sel>` | Capture specific element |
| `--region` | Interactively drag to select a region |
| `-o <path>` | Output file path (required for viewing) |

### dom

Get formatted HTML tree of the page.

```bash
deveye dom                          # full page DOM
deveye dom -s "#app" --depth 5      # scoped to selector, max depth 5
deveye dom --interactive-only       # only interactive elements (minimal tokens)
deveye dom --visible-only           # only visible elements
deveye dom --interactive-only --compact  # ultra-compact interactive elements
```

| Flag | Description |
|------|-------------|
| `-s, --selector <sel>` | Scope to CSS selector |
| `--depth <n>` | Max tree depth (default: 10) |
| `--interactive-only` | Only return interactive elements (buttons, inputs, links, etc.) |
| `--visible-only` | Only include visible elements (filters display:none, visibility:hidden, etc.) |
| `--compact` | Compact output for AI consumption |

`<script>` and `<style>` content stripped. Whitespace text nodes compressed.

### console

Get browser console output.

```bash
deveye console                      # all logs
deveye console --level error        # errors only
deveye console --limit 20           # last 20 entries
deveye console --resolve-source-maps  # resolve minified stack traces to source
```

| Flag | Description |
|------|-------------|
| `--level <level>` | Filter: log, warn, error, info, debug |
| `--limit <n>` | Max entries (buffer: 1000) |
| `--resolve-source-maps` | Resolve minified stack traces to original source (timeout: 10s) |

### network

Get captured network requests.

```bash
deveye network                              # summary list
deveye network --url "/api" --method POST   # filter by URL and method
deveye network --detail                     # include headers and bodies
deveye network --limit 10                   # limit results
```

| Flag | Description |
|------|-------------|
| `--url <pattern>` | Filter by URL substring |
| `--method <method>` | Filter by HTTP method |
| `--detail` | Include headers and response bodies |
| `--limit <n>` | Max entries (cache: 200, body: 10KB) |

### performance

Get Web Vitals and performance metrics.

```bash
deveye performance                  # Web Vitals (LCP, FID, CLS, etc.)
deveye performance --analyze        # AI-friendly diagnostics with thresholds
deveye performance --analyze --json # JSON with analysis
```

| Flag | Description |
|------|-------------|
| `--analyze` | Add AI-friendly diagnostics with good/needs-improvement/poor ratings |
| `--compact` | Compact output for AI consumption |

### accessibility

Run WCAG accessibility audit (axe-core).

```bash
deveye accessibility                # full WCAG audit
deveye accessibility --standard WCAG2AAA  # stricter standard
deveye accessibility --selector "#main"   # scope to subtree
```

| Flag | Description |
|------|-------------|
| `--standard <level>` | WCAG2A, WCAG2AA (default), WCAG2AAA |
| `--selector <sel>` | CSS selector to scope audit |
| `--compact` | Compact output |

### tabs

List all open Chrome tabs.

```bash
deveye tabs                         # list all tabs with IDs
```

### page-info

Get current page metadata.

```bash
deveye page-info                    # title, URL, meta tags, etc.
deveye page-info --compact          # compact output
```

### snapshot

Get accessibility tree snapshot with element UIDs for AI interaction.

```bash
deveye snapshot                         # full a11y tree
deveye snapshot -s "#app" --max-depth 5 # scoped to selector
deveye snapshot --interactive-only      # only interactive elements
deveye snapshot --visible-only          # only visible elements
deveye snapshot --viewport-only         # only elements in viewport
deveye snapshot --compact               # ultra-compact output
```

| Flag | Description |
|------|-------------|
| `-s, --selector <sel>` | CSS selector for root element |
| `--max-depth <n>` | Max tree depth (default: 15) |
| `--interactive-only` | Only show interactive elements |
| `--visible-only` | Only include visible elements |
| `--viewport-only` | Only include elements in the current viewport |
| `--compact` | Ultra-compact output for AI |

### inspect

Composite debug snapshot: screenshot + a11y snapshot + console errors + failed network + performance. One command for full page diagnosis.

```bash
deveye inspect                          # full composite snapshot
deveye inspect -o /tmp/page.png         # save screenshot to file
deveye inspect --no-screenshot          # text-only mode
deveye inspect --no-network --no-performance  # only screenshot+snapshot+console
deveye inspect --compact                # compact AI-friendly output
```

| Flag | Description |
|------|-------------|
| `-o, --output <path>` | Save screenshot to file |
| `--no-screenshot` | Skip screenshot capture |
| `--no-snapshot` | Skip accessibility snapshot |
| `--no-console` | Skip console errors |
| `--no-network` | Skip failed network requests |
| `--no-performance` | Skip performance metrics |
| `--console-limit <n>` | Limit console entries |
| `--network-limit <n>` | Limit network entries |
| `--compact` | Compact output for AI consumption |

### eval

Execute JavaScript in the page context.

```bash
deveye eval "document.title"                         # simple expression
deveye eval "document.title" --no-snapshot           # execute JS only (no snapshot)
deveye eval "document.querySelectorAll('a').length"  # query
deveye eval "await fetch('/api/data').then(r => r.json())"  # async
```

| Flag | Description |
|------|-------------|
| `--no-snapshot` | Skip post-action snapshot (fast path for data queries) |

Uses `chrome.scripting.executeScript` (fast path), auto-falls back to `chrome.debugger` on CSP-strict pages.

### storage

Read/write cookies, localStorage, and sessionStorage.

```bash
deveye storage                               # all storage data
deveye storage --type cookies                # cookies only
deveye storage --type local                  # localStorage only
deveye storage --type session                # sessionStorage only
deveye storage --key "user_token"            # get specific key
deveye storage --set --type local --key "debug" --value "true"  # set value
deveye storage --delete --type cookies --key "sid"              # delete key
deveye storage --clear --type local          # clear all localStorage
```

| Flag | Description |
|------|-------------|
| `--type <type>` | Storage type: cookies, local, session, all (default: all) |
| `--key <key>` | Get/set/delete a specific key |
| `--value <value>` | Value to set (use with --set) |
| `--set` | Set a value |
| `--delete` | Delete a key |
| `--clear` | Clear all entries for the specified type |

### detect

Smart element detection using heuristic rules.

```bash
deveye detect --type captcha                 # detect captcha elements
deveye detect --type login                   # detect login forms
deveye detect --all                          # run all 8 preset detectors
deveye detect --keyword "submit"             # search by keyword
deveye detect --min-confidence 0.5           # higher confidence threshold
```

| Flag | Description |
|------|-------------|
| `--type <type>` | Preset: captcha, login, form, button, input, link, modal, error |
| `--keyword <keyword>` | Custom keyword to detect elements |
| `--all` | Run all preset detectors |
| `--limit <n>` | Max results (default: 20) |
| `--min-confidence <n>` | Min confidence 0-1 (default: 0.3) |
| `--compact` | Compact output |

### animations

Observe CSS animations, transitions, keyframes, and animation libraries.

```bash
deveye animations                            # summary of all animations
deveye animations --detailed                 # include full @keyframes definitions
deveye animations --selector ".hero"         # scope to subtree
```

| Flag | Description |
|------|-------------|
| `--detailed` | Include full @keyframes definitions |
| `--selector <sel>` | Scope to CSS selector subtree |
| `--compact` | Compact output |

### design-tokens

Extract design tokens (colors, fonts, spacing, CSS custom properties).

```bash
deveye design-tokens                         # all token types
deveye design-tokens --detailed              # include stylesheet custom properties
deveye design-tokens --selector "#main"      # scope to subtree
deveye design-tokens --include colors,fonts  # specific types only
```

| Flag | Description |
|------|-------------|
| `--detailed` | Include CSS custom properties from stylesheets |
| `--selector <sel>` | Scope to CSS selector subtree |
| `--include <types>` | Comma-separated: colors, fonts, spacing, customProperties |
| `--compact` | Compact output |

### seo

Run rule-based SEO analysis on the current page.

```bash
deveye seo                                   # full SEO analysis (8 categories)
deveye seo --category meta                   # single category
deveye seo --compact                         # compact output
```

| Flag | Description |
|------|-------------|
| `--category <cat>` | Single category: meta, headings, structuredData, social, images, links, content, technical |
| `--compact` | Compact output |

## Browser Commands

Browser-level queries (not per-tab). Requires `bookmarks`, `history`, and `downloads` permissions.

### bookmarks

Search and list Chrome bookmarks.

```bash
deveye bookmarks --search "react hooks" # search by title or URL
deveye bookmarks --folder "DevTools"    # list folder contents
deveye bookmarks --limit 20            # limit results
deveye bookmarks --compact             # compact output
```

| Flag | Description |
|------|-------------|
| `--search <query>` | Search bookmarks by title or URL |
| `--folder <name>` | List bookmarks in a specific folder |
| `--limit <n>` | Maximum results (default: 50) |
| `--compact` | Compact output for AI consumption |

### history

Search Chrome browsing history.

```bash
deveye history --search "github.com" --since 7d  # search recent history
deveye history --since 1d                         # last 24 hours
deveye history --limit 20 --json                  # JSON output
deveye history --compact                          # compact output
```

| Flag | Description |
|------|-------------|
| `--search <query>` | Search history by URL or title |
| `--since <duration>` | Time range: 1h, 1d, 7d, 30d (default: 7d) |
| `--limit <n>` | Maximum results (default: 50) |
| `--compact` | Compact output for AI consumption |

### download

List, wait for, and save Chrome downloads.

```bash
deveye download list                         # latest 3, with URLs
deveye download list --no-url                # latest 3, no URLs (token-efficient)
deveye download list --limit 1 --no-url      # just the latest
deveye download list --limit 20              # old behavior (20 items)
deveye download list --state complete --limit 10  # completed downloads
deveye download wait -o /tmp/cert.zip        # wait for next download and save
deveye download wait --timeout 30000 -o /tmp/f.zip  # wait with custom timeout
deveye download save -o /tmp/latest.zip      # save most recent completed download
deveye download save --id 123 -o /tmp/f.zip  # save specific download by ID
```

| Flag | Description |
|------|-------------|
| `--state <state>` | Filter by state: complete, in_progress, interrupted |
| `--limit <n>` | Max results for list (default: 3) |
| `--no-url` | Hide download URLs in output |
| `--search <query>` | Filter downloads by filename pattern |
| `--timeout <ms>` | Timeout for wait (default: 60000) |
| `--id <id>` | Target specific download by ID (save) |
| `--filename <regex>` | Only match downloads with filename matching regex (wait) |
| `--auto-save` | Bypass Chrome save-as dialog for automated downloads (wait) |
| `-o <path>` | Output file path (required for wait/save) |

Actions: `list`, `wait`, `save`

## Action Commands

All action commands return an accessibility snapshot after execution by default. Add `--screenshot` for a PNG screenshot (slower; use only when visual confirmation is needed).

**Shared flags** (available on most action commands):

| Flag | Available on | Description |
|------|-------------|-------------|
| `--screenshot` | all actions | Capture PNG after action (default: snapshot only) |
| `--human` | click, type, scroll, hover, wait, keyboard, drag | Human-like behavior: random delays, curved mouse |
| `--uid <uid>` | click, type, scroll, select, wait, hover, check, drag, upload | Target by snapshot UID (alternative to CSS selector) |

### click

```bash
deveye click "button.submit"        # left click
deveye click "#menu" -b right       # right-click
deveye click ".item" --double       # double-click
deveye click --uid "btn_3"          # click by snapshot UID
deveye click --text "查看"          # click first element with exact text "查看"
deveye click --text "Submit"        # click button/link by text
deveye click --contains-text "登"   # click first element whose text contains "登"
```

| Flag | Description |
|------|-------------|
| `-b, --button <button>` | left, right, middle |
| `--double` | Double-click |
| `--uid <uid>` | Element UID from snapshot |
| `--text <content>` | Click element by exact visible text content |
| `--contains-text <content>` | Click element whose visible text contains the given substring |
| `--human` | Human-like behavior simulation |

### type

```bash
deveye type "#search" "hello" --enter        # type + Enter
deveye type "#email" "user@test.com" --clear # clear field first
deveye type --uid "input_1" "hello"          # type by UID
deveye type "#input" "text" --cdp            # CDP input for Monaco/xterm.js
deveye type --cdp ".xterm-screen" "echo hello" --enter  # terminal: type + execute
```

| Flag | Description |
|------|-------------|
| `--enter` | Press Enter after typing |
| `--clear` | Clear field before typing |
| `--submit [selector]` | After typing: press Enter (no value) or click selector |
| `--uid <uid>` | Element UID from snapshot |
| `--secure` | Read text from vault (requires --vault-key) |
| `--vault-key <name>` | Vault key name to read text from |
| `--cdp` | Use CDP Input.dispatchKeyEvent (for xterm.js, Monaco, etc.) |
| `--human` | Human-like behavior simulation |

### fill-form

Fill multiple form fields in a single operation.

```bash
deveye fill-form '[{"ref":"e1","value":"Alice"},{"ref":"e2","value":"bob@test.com"}]'
deveye fill-form '[{"selector":"#name","value":"Alice"},{"selector":"#agree","value":"true","type":"checkbox"}]'
deveye fill-form '[{"uid":"input_1","value":"Hello"},{"uid":"select_2","value":"opt1","type":"combobox"}]'
```

| Flag | Description |
|------|-------------|
| `fields` (arg) | JSON array of field objects |

Each field object:
| Property | Description |
|----------|-------------|
| `ref` / `uid` / `selector` | Target element (snapshot UID, UID, or CSS selector) |
| `value` | Value to set |
| `type` | Optional: textbox (default), checkbox, combobox, radio, slider |

### scroll

```bash
deveye scroll down                           # scroll down 300px
deveye scroll up -a 500                      # scroll up 500px
deveye scroll down -s ".container" -a 200    # scroll in element
```

| Flag | Description |
|------|-------------|
| `-a, --amount <px>` | Scroll amount in pixels (default: 300) |
| `-s, --selector <sel>` | Scroll within specific element |
| `--uid <uid>` | Element UID from snapshot |
| `--human` | Human-like behavior simulation |

### select

```bash
deveye select "#country" -l "China"          # by label
deveye select "#country" -v "CN"             # by value
deveye select "#country" -i 3                # by index
```

| Flag | Description |
|------|-------------|
| `-l, --label <text>` | Select by visible label |
| `-v, --value <val>` | Select by option value |
| `-i, --option-index <n>` | Select by 0-based index |
| `--uid <uid>` | Element UID from snapshot |

### wait

```bash
deveye wait ".loading" -s hidden             # wait until hidden
deveye wait "#result" --timeout 10000        # custom timeout
deveye wait --text "Success"                 # wait for text to appear
deveye wait --text-gone "Loading..."         # wait for text to disappear
deveye wait --url-contains "dashboard"       # wait until URL contains text
deveye wait --title-contains "Success"       # wait until page title matches
deveye wait --uid "spinner_1" -s hidden      # wait by UID
deveye wait --eval "document.querySelectorAll('tr').length > 1" --timeout 5000
deveye wait --eval "document.querySelector('.loaded')"
```

| Flag | Description |
|------|-------------|
| `-s, --state <state>` | visible, hidden, attached, detached |
| `--timeout <ms>` | Timeout in ms (default: 5000, max: 300000) |
| `--text <string>` | Wait until page body contains this text |
| `--text-gone <string>` | Wait until page body no longer contains this text |
| `--url-contains <text>` | Wait until page URL contains text (replaces sleep) |
| `--title-contains <text>` | Wait until page title contains text |
| `--eval <expression>` | Wait until JavaScript expression evaluates to truthy |
| `--uid <uid>` | Element UID from snapshot |
| `--human` | Human-like behavior simulation |

### hover

```bash
deveye hover ".tooltip-trigger"              # hover over element
```

| Flag | Description |
|------|-------------|
| `--uid <uid>` | Element UID from snapshot |
| `--human` | Human-like behavior simulation |

### keyboard

```bash
deveye keyboard Enter                        # single key
deveye keyboard "Control+a"                  # key combination
deveye keyboard "Control+a" --cdp            # CDP mode for Monaco/xterm.js
```

| Flag | Description |
|------|-------------|
| `--cdp` | Use CDP Input.dispatchKeyEvent (for xterm.js, Monaco, CodeMirror) |
| `--human` | Human-like behavior simulation |

### check

```bash
deveye check "#agree" --checked              # set checked
deveye check "#newsletter" --unchecked       # set unchecked
```

| Flag | Description |
|------|-------------|
| `--checked` | Set to checked state |
| `--unchecked` | Set to unchecked state |
| `--uid <uid>` | Element UID from snapshot |

### drag

```bash
deveye drag ".draggable" ".drop-zone"        # drag and drop
deveye drag --source-uid "item_1" --target-uid "zone_1"  # drag by UID
```

| Flag | Description |
|------|-------------|
| `--source-uid <uid>` | Source element UID from snapshot |
| `--target-uid <uid>` | Target element UID from snapshot |
| `--human` | Human-like behavior simulation |

### upload

```bash
deveye upload "#file-input" ./test.pdf       # upload file
deveye upload --uid "file_1" ./test.pdf      # upload by UID
```

| Flag | Description |
|------|-------------|
| `--uid <uid>` | Element UID from snapshot |
| `--mime <type>` | MIME type of the file |

### open

Open a new tab with the specified URL.

```bash
deveye open "https://example.com"            # open in new tab
deveye open "https://example.com" --background  # open in background
deveye open "https://example.com" --position 0  # open as first tab
```

| Flag | Description |
|------|-------------|
| `--background` | Open tab in background |
| `--position <n>` | Tab position in tab bar (0-based) |

### pause-animations

Pause all CSS animations, transitions, and media for stable screenshots.

```bash
deveye pause-animations                      # freeze all animations
```

No flags. Use before `screenshot` to freeze animated pages.

### resume-animations

Resume previously paused animations, transitions, and media.

```bash
deveye resume-animations                     # resume paused animations
```

No flags. Call after taking screenshots to restore animation playback.

### navigate

Navigate the current page (goto URL, back, forward, reload).

```bash
deveye navigate goto "https://example.com"   # navigate to URL
deveye navigate back                         # browser back
deveye navigate forward                      # browser forward
deveye navigate reload                       # reload page
deveye navigate reload --bypass-cache        # hard reload (bypass cache)
deveye navigate goto "https://example.com" --wait-for ".content"  # navigate + wait for element
```

| Flag | Description |
|------|-------------|
| `--bypass-cache` | Bypass cache on reload |
| `--wait-for <selector>` | After navigation, wait for element to appear (10s timeout) |

Actions: `goto`, `back`, `forward`, `reload`. SSRF protection blocks private/internal IPs.

### close

Close a tab.

```bash
deveye close                                 # close active tab
deveye close -t 12345                        # close specific tab
deveye close --index 3                       # close tab by index
```

### dialog

Handle JavaScript dialogs (alert, confirm, prompt).

```bash
deveye dialog accept                         # accept alert/confirm
deveye dialog dismiss                        # dismiss/cancel dialog
deveye dialog accept "response text"         # accept prompt with text
```

Actions: `accept`, `dismiss`. Text argument only valid for `accept` (prompt response).

## Utility Commands

### annotate

Manage page annotations.

```bash
deveye annotate list                         # list all
deveye annotate list --status pending        # filter by status
deveye annotate get -a <id>                  # get details
deveye annotate create -s ".el" -c "Bug"     # create
deveye annotate inspect -s ".my-element"     # inspect element
deveye annotate inspect --text "Submit"      # inspect by text
deveye annotate acknowledge -a <id>          # acknowledge
deveye annotate resolve -a <id> --summary "Fixed"
deveye annotate dismiss -a <id> --reason "N/A"
deveye annotate delete -a <id>              # delete
deveye annotate clear                        # clear resolved/dismissed
```

### pick

Interactive element picker. User clicks an element in Chrome, returns selector/attributes/coordinates.

```bash
deveye pick                                  # pick element (30s timeout)
deveye pick --timeout 60000                  # custom timeout (max 120s)
deveye pick --detail detailed                # detailed element info
deveye pick -o /tmp/picked.png               # screenshot of picked element
```

### ping

Test connection to Chrome Extension.

```bash
deveye ping                                  # test connection
deveye ping --json                           # JSON with version info
```

### stealth

Manage bot detection bypass (anti-fingerprinting).

```bash
deveye stealth status                        # check current status
deveye stealth enable                        # enable all stealth features
deveye stealth enable --no-webdriver         # skip navigator.webdriver removal
deveye stealth enable --user-agent "..."     # custom user agent
deveye stealth disable                       # disable stealth mode
deveye stealth test                          # test stealth effectiveness
```

| Flag | Description |
|------|-------------|
| `--no-webdriver` | Disable navigator.webdriver removal |
| `--no-gpu` | Disable GPU fingerprint spoofing |
| `--no-ua` | Disable user agent cleaning |
| `--user-agent <ua>` | Custom user agent string |
| `--gpu-vendor <vendor>` | Custom GPU vendor |
| `--gpu-renderer <renderer>` | Custom GPU renderer |

Actions: `status`, `enable`, `disable`, `test`

### emulate

Emulate device viewport, user agent, or network conditions.

```bash
deveye emulate device iphone-14              # preset device
deveye emulate device pixel-7                # Android device
deveye emulate device --width 1920 --height 1080  # custom viewport
deveye emulate device --width 375 --height 812 --mobile --scale 3  # custom mobile
deveye emulate network slow-3g               # slow network
deveye emulate network offline               # offline mode
deveye emulate reset                         # reset all emulation
```

| Flag | Description |
|------|-------------|
| `--width <n>` | Viewport width (custom device) |
| `--height <n>` | Viewport height (custom device) |
| `--scale <n>` | Device scale factor |
| `--mobile` | Enable mobile mode |
| `--user-agent <ua>` | Custom user agent string |

Device presets: `iphone-14`, `iphone-se`, `ipad-air`, `pixel-7`, `desktop-hd`
Network presets: `slow-3g`, `fast-3g`, `4g`, `offline`
Actions: `device`, `network`, `reset`

## Captcha Commands

AI-powered captcha recognition using ddddocr Python backend.

### captcha-ocr

Recognize text from a captcha image element on the page.

```bash
deveye captcha-ocr --selector ".captcha-img"              # OCR text recognition
deveye captcha-ocr --selector ".captcha" --range 0        # digits only
deveye captcha-ocr --selector ".captcha" --png-fix        # fix transparent PNG background
```

| Flag | Description |
|------|-------------|
| `--selector <sel>` | CSS selector for the captcha image element (required) |
| `--range <n>` | Character range: 0=digits, 1=lower, 2=upper, 3=letters, 4=lower+digits, 5=upper+digits, 6=all (default: 6) |
| `--png-fix` | Fix PNG transparent background before recognition |

### captcha-slide

Match slider captcha position by comparing target and background images.

```bash
deveye captcha-slide --target ".slider" --background ".bg-img"  # edge algorithm (default)
deveye captcha-slide --target ".slider" --background ".bg" --algorithm diff  # diff algorithm
```

| Flag | Description |
|------|-------------|
| `--target <sel>` | CSS selector for the slider piece element (required) |
| `--background <sel>` | CSS selector for the background image element (required) |
| `--algorithm <type>` | Matching algorithm: edge (default) or diff |

### captcha-detect

Detect objects in captcha image using YOLOX model.

```bash
deveye captcha-detect --selector ".captcha-img"           # object detection
```

| Flag | Description |
|------|-------------|
| `--selector <sel>` | CSS selector for the captcha image element (required) |

## Data Export Commands

### bundle

Bundle page captures into a single JSON file.

```bash
deveye bundle -o /tmp/page-bundle.json       # bundle all captures into one JSON
deveye bundle --include screenshot,console   # specific captures only
deveye bundle --exclude performance          # exclude specific captures
deveye bundle --full-page -o /tmp/full.json  # use full-page screenshot
deveye bundle --json                         # output to stdout instead of file
```

| Flag | Description |
|------|-------------|
| `-o <path>` | Output JSON file (default: bundle-\<timestamp\>.json) |
| `--include <captures>` | Comma-separated captures to include |
| `--exclude <captures>` | Comma-separated captures to exclude |
| `--full-page` | Use full-page screenshot instead of viewport |
| `--body-limit <bytes>` | Network body truncation limit (default: 10240) |
| `--json` | Output to stdout instead of file |

### export

Export captured data in standard formats.

```bash
deveye export har -o /tmp/trace.har          # export network as HAR 1.2
deveye export har --url "/api" --limit 50    # filtered HAR export
deveye export har --method POST -o /tmp/api.har  # filter by method
```

| Flag | Description |
|------|-------------|
| `-o <path>` | Save HAR to file (default: stdout) |
| `--url <pattern>` | Filter by URL pattern |
| `--method <method>` | Filter by HTTP method |
| `--limit <n>` | Limit number of entries |
| `--body-limit <bytes>` | Max body size in bytes (default: 10240) |

Subcommands: `har`

## Audit Command

### audit (Lighthouse)

Run Lighthouse audits locally. No Extension needed if `--url` is provided.

```bash
deveye audit performance                     # performance audit
deveye audit accessibility                   # accessibility audit
deveye audit seo                             # SEO audit
deveye audit best-practices                  # best practices
deveye audit all                             # all audits
deveye audit all --url https://example.com   # audit specific URL
deveye audit all --json                      # JSON output
deveye audit all -o /tmp/report.html         # save HTML report
```

| Flag | Description |
|------|-------------|
| `--url <url>` | Audit specific URL (no Extension needed) |
| `-o <path>` | Save HTML report |

## Chain Command

Execute multiple commands sequentially in a single process, reusing the IPC connection.

### chain

```bash
deveye chain "navigate goto \"https://example.com\"" "wait \".main\"" "snapshot"
deveye chain --delay 500 "click \".btn\"" "wait --url-contains dashboard"
deveye chain --continue-on-error "cmd1" "cmd2" "cmd3"
```

| Flag | Description |
|------|-------------|
| `--delay <ms>` | Delay between commands in milliseconds (default: 0) |
| `--continue-on-error` | Continue execution even if a command fails |

Each command string is parsed and executed through the existing Commander.js command infrastructure. Output includes per-command status and a final summary.

## Server Mode

Persistent server keeps WebSocket connection alive, avoiding reconnection overhead.

```bash
deveye server start                          # foreground server
deveye server start -d                       # daemon (background)
deveye server start -p 9999                  # custom port
deveye server start -H 0.0.0.0              # bind to all interfaces
deveye server start --token <secret>         # auth token for remote
deveye server start --extension-path <dir>   # Extension dist directory (for remote browser mode)
deveye server start --chrome-path <path>     # Chrome executable path (auto-detect if omitted)
deveye server start --session-timeout 600    # idle timeout in seconds (default: 600)
deveye server stop                           # stop server
deveye server status                         # check status
```

## Remote Browser Management

Manage browser instances on a remote server. Requires `DEVEYE_SERVER` environment variable or `--server` flag.

### browser create

```bash
deveye browser create                        # create browser instance
deveye browser create --headless             # headless mode
deveye browser create --json                 # JSON output (for scripting)
```

| Flag | Description |
|------|-------------|
| `--headless` | Launch Chrome in headless mode |
| `--json` | Output browserId as JSON |

### browser destroy

```bash
deveye browser destroy --browser-id <id>     # destroy specific instance
```

| Flag | Description |
|------|-------------|
| `--browser-id <id>` | Browser instance ID to destroy |

### browser list

```bash
deveye browser list                          # list all active instances
deveye browser list --json                   # JSON output
```

### Remote connection

```bash
# Environment variables
export DEVEYE_SERVER=ws://remote-host:9888   # remote server URL
export DEVEYE_TOKEN=my-secret                # authentication token
export DEVEYE_BROWSER_ID=b-a1b2c3d4          # default browser instance ID

# Or use command-line flags (override env vars)
deveye --server ws://remote:9888 --browser-id b-a1b2c3d4 screenshot -o /tmp/shot.png
```

All 49 commands work transparently in remote mode — just set `DEVEYE_BROWSER_ID` or pass `--browser-id`.
