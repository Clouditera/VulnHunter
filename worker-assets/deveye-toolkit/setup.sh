#!/bin/bash
# DeVeye Server Setup Script — VulnAgent v1.0
# Run this on a machine with desktop + Chrome

set -e

echo "=== DeVeye Server Setup ==="
echo ""

# Detect platform
OS=$(uname -s)
ARCH=$(uname -m)
echo "Platform: $OS $ARCH"

# Check Chrome
CHROME=""
for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "$candidate" &>/dev/null; then
    CHROME="$candidate"
    break
  fi
done

if [ -z "$CHROME" ]; then
  echo "⚠ Chrome not found. Please install Google Chrome first."
  echo "  https://www.google.com/chrome/"
  exit 1
fi
echo "✓ Chrome found: $CHROME"

# Install CLI
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_BIN="$SCRIPT_DIR/deveye"

if [ ! -f "$CLI_BIN" ]; then
  echo "✗ DeVeye CLI binary not found at $CLI_BIN"
  exit 1
fi

chmod +x "$CLI_BIN"

# Check if already in PATH
if command -v deveye &>/dev/null; then
  echo "✓ deveye already in PATH: $(command -v deveye)"
else
  # Try to symlink to /usr/local/bin
  if [ -w /usr/local/bin ]; then
    ln -sf "$CLI_BIN" /usr/local/bin/deveye
    echo "✓ Installed deveye to /usr/local/bin/deveye"
  else
    echo "⚠ Cannot write to /usr/local/bin. Run with sudo or add $SCRIPT_DIR to PATH:"
    echo "  export PATH=\"$SCRIPT_DIR:\$PATH\""
  fi
fi

# Verify
"$CLI_BIN" --version

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Start the server with:"
echo ""
echo "  deveye server start \\"
echo "    --host 0.0.0.0 \\"
echo "    --port 9888 \\"
echo "    --token <your-token> \\"
echo "    --extension-path $SCRIPT_DIR/extension-dist \\"
echo "    --daemon"
echo ""
echo "Then in VulnAgent Settings → POC/EXP:"
echo "  Server URL: ws://<this-machine-ip>:9888"
echo "  Token: <your-token>"
