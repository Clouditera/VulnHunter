# DevEye Workflow Examples

## 1. Form Debugging

User reports: "The login form isn't submitting"

```bash
# 1. See the current state
deveye screenshot -o /tmp/login.png

# 2. Get the form structure
deveye dom -s "form" --depth 5

# 3. Check for JS errors
deveye console --level error

# 4. Fill and submit the form
deveye type "#username" "testuser" --clear
deveye type "#password" "testpass" --clear --enter

# 5. Check what happened
deveye screenshot -o /tmp/after-submit.png
deveye network --url "/api/login" --detail
```

## 2. Broken Page Diagnosis

User reports: "The page looks wrong"

```bash
# 1. Screenshot to see the issue
deveye screenshot --full-page -o /tmp/broken.png

# 2. Check console for errors
deveye console --level error

# 3. Check failed network requests
deveye network --method GET | grep -i "4\|5"

# 4. Check accessibility issues
deveye accessibility
```

## 3. Finding the Right Selector

User asks: "Click the submit button but I don't know the selector"

```bash
# Option A: Interactive picker
deveye pick
# → User clicks the element in Chrome
# → Returns: { selector: "button.btn-primary", ... }

# Option B: Search the DOM
deveye dom -s "form" --depth 3
# → Find the button in the tree, use its selector

# Option C: Smart detection
deveye detect --type button
# → Returns buttons with confidence scores and selectors

# Option D: Inspect by text
deveye annotate inspect --text "Submit"
```

## 4. Full Page Audit

Run comprehensive quality checks on a page.

```bash
# Lighthouse audit (all categories)
deveye audit all --url https://example.com -o /tmp/report.html

# Or audit current tab
deveye audit all --json

# Specific checks
deveye performance          # Web Vitals
deveye accessibility        # WCAG violations
deveye seo                  # SEO health (rule-based)
deveye audit seo            # SEO via Lighthouse
```

## 5. Monitoring Changes

Watch for issues while testing.

```bash
# Before action
deveye console --level error    # baseline errors
deveye network                  # baseline requests

# Perform action
deveye click "#trigger-button"

# After action - check what changed
deveye console --level error    # new errors?
deveye network --url "/api"     # new API calls?
deveye screenshot -o /tmp/after.png
```

## 6. Multi-Tab Workflow

Work with multiple tabs.

```bash
# List all tabs
deveye tabs

# Target specific tab by index
deveye screenshot --index 2 -o /tmp/tab2.png

# Target by tab ID
deveye dom -t 12345

# Open new tab
deveye open "https://example.com"

# Close a tab
deveye close --index 3
```

## 7. Server Mode for Repeated Commands

When running many commands in sequence, use server mode to avoid reconnection overhead.

```bash
# Start persistent server
deveye server start -d

# Now all commands are faster (no reconnection)
deveye screenshot -o /tmp/step1.png
deveye click ".next"
deveye screenshot -o /tmp/step2.png
deveye click ".next"
deveye screenshot -o /tmp/step3.png

# Done - stop server
deveye server stop
```

## 8. Navigation Workflow

Navigate between pages and handle dialogs.

```bash
# Navigate to a URL
deveye navigate goto "https://example.com/dashboard"

# Wait for page to load
deveye wait ".dashboard-container"

# Go back
deveye navigate back

# Handle a confirm dialog
deveye click "#delete-button"
deveye dialog accept

# Reload with cache bypass
deveye navigate reload --bypass-cache
```

## 9. Mobile Testing with Emulation

Test responsive design and mobile behavior.

```bash
# Emulate iPhone 14
deveye emulate device iphone-14
deveye screenshot -o /tmp/mobile.png

# Test different devices
deveye emulate device pixel-7
deveye screenshot -o /tmp/android.png

# Test slow network
deveye emulate network slow-3g
deveye performance --analyze

# Reset to desktop
deveye emulate reset
```

## 10. Design System Analysis

Extract design tokens and inspect visual properties.

```bash
# Extract all design tokens
deveye design-tokens --detailed

# Focus on colors and fonts
deveye design-tokens --include colors,fonts

# Check CSS animations
deveye animations --detailed

# Scope to specific component
deveye design-tokens --selector ".card-component"
deveye animations --selector ".hero-section"
```

## 11. Anti-Bot Testing with Stealth Mode

Test if a site detects automation.

```bash
# Check current stealth status
deveye stealth status

# Enable stealth mode
deveye stealth enable

# Test stealth effectiveness
deveye stealth test

# Navigate to target site
deveye navigate goto "https://target-site.com"

# Verify no detection
deveye screenshot -o /tmp/stealth-test.png
deveye console --level error

# Clean up
deveye stealth disable
```
