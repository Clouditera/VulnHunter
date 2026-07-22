# DevEye Error Handling Guide

## Error Categories

### 1. Connection Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Connection timeout` | Extension not running or not connected | Open Chrome, verify Extension is enabled, run `deveye ping` |
| `WebSocket connection failed` | Port conflict or firewall | Check port 9888 is free: `lsof -i :9888` |
| `No response from extension` | Extension crashed or tab closed | Reload Extension at `chrome://extensions` |

### 2. Tab Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Tab not found` | Tab ID is stale | Run `deveye tabs` to get current IDs |
| `No active tab` | No Chrome tabs open | Open a tab in Chrome |
| `Cannot access tab` | chrome:// or extension page | Use a regular web page |

### 3. Screenshot Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Screenshot failed` | Page not fully loaded | Add `deveye wait` before screenshot |
| `Selector not found` | Element doesn't exist | Verify with `deveye dom -s "selector"` |
| `Output path error` | Invalid or unsafe path | Use absolute path, avoid `..` traversal |

### 4. Action Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Element not found` | Wrong selector | Use `deveye pick` to find correct selector |
| `Element not visible` | Hidden or off-screen | Scroll to element first: `deveye scroll` |
| `Element not interactable` | Covered by overlay | Close modals/popups, then retry |
| `Timeout waiting` | Element never appeared | Increase `--timeout`, check page state |

### 5. Navigate Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `URLs pointing to internal/private network` | SSRF protection triggered | Only http/https to public IPs allowed |
| `Invalid URL` | Malformed URL | Check URL format (must include protocol) |
| `Navigation timeout` | Page never finished loading | Check network, try `deveye navigate reload` |

### 6. Dialog Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `No dialog detected` | No active JS dialog | Dialog must be showing when command runs |
| `Debugger attach timeout` | Chrome debugger busy | Close DevTools, retry |

### 7. Emulate Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Unknown device preset` | Invalid preset name | Use: iphone-14, iphone-se, ipad-air, pixel-7, desktop-hd |
| `Unknown network preset` | Invalid preset name | Use: slow-3g, fast-3g, 4g, offline |
| `Both --width and --height must be specified` | Missing dimension | Provide both for custom device |

### 8. Audit Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Lighthouse not available` | Chrome not found | Ensure Chrome is installed and in PATH |
| `URL not accessible` | Invalid URL or auth required | Check URL is reachable, use `--url` flag |

## Performance Budgets

| Command | Budget | Notes |
|---------|--------|-------|
| screenshot | < 2s | Full-page may take longer |
| dom | < 1s | Depth 10 max, scripts/styles stripped |
| console | < 500ms | Ring buffer 1000 entries |
| network | < 500ms | Cache 200 entries, body 10KB |
| performance | < 1s | Web Vitals collection |
| accessibility | < 5s | Full axe-core audit |
| seo | < 2s | Rule-based analysis |
| animations | < 1s | CSS animation detection |
| design-tokens | < 2s | Token extraction |
| detect | < 1s | Heuristic element detection |

## Degradation Strategies

### Connection Lost Mid-Session

```
1. Run `deveye ping` to check connection
2. If timeout → check Chrome Extension is enabled
3. If still failing → reload Extension at chrome://extensions
4. Last resort → restart Chrome
```

### Element Not Found

```
1. Take screenshot to see current page state
2. Get DOM to verify element exists: `deveye dom -s "parent-selector"`
3. Use `deveye pick` to interactively find the right selector
4. Try `deveye detect --keyword "text"` to find by content
5. Check if element is in iframe (not supported)
```

### Slow Page / Timeout

```
1. Use `deveye wait` with increased --timeout before actions
2. Check `deveye performance` for bottlenecks
3. Check `deveye network` for pending requests
4. For server mode: `deveye server start -d` to avoid reconnection overhead
```
