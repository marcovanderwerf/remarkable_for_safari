#!/bin/bash

# build.sh - Build reMarkable for Safari extension
# This script uses Apple's safari-web-extension-converter tool

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSION_DIR="$SCRIPT_DIR/extension"
OUTPUT_DIR="$SCRIPT_DIR/build"
APP_NAME="reMarkable for Safari"
BUNDLE_ID="com.marcovanderwerf.remarkable-safari"

echo ""
echo "══════════════════════════════════════════════════════"
echo "  reMarkable for Safari - Build Script"
echo "══════════════════════════════════════════════════════"
echo ""

# Check for Xcode command line tools
if ! command -v xcrun &> /dev/null; then
    echo "❌ Xcode Command Line Tools not found."
    echo ""
    echo "Install them by running:"
    echo "  xcode-select --install"
    echo ""
    exit 1
fi

# Check for the converter tool
if ! xcrun --find safari-web-extension-converter &> /dev/null; then
    echo "❌ Safari Web Extension Converter not found."
    echo ""
    echo "Please install Xcode from the App Store:"
    echo "  https://apps.apple.com/app/xcode/id497799835"
    echo ""
    exit 1
fi

echo "✓ Xcode tools found"
echo ""

# Clean previous build
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

echo "Converting extension to Safari format..."
echo ""

# Convert the extension
xcrun safari-web-extension-converter "$EXTENSION_DIR" \
    --project-location "$OUTPUT_DIR" \
    --app-name "$APP_NAME" \
    --bundle-identifier "$BUNDLE_ID" \
    --swift \
    --macos-only \
    --no-open

echo ""
echo "✓ Xcode project created!"

# Copy Icon.png to the main app's Resources folder
echo "Copying icons..."
APP_RESOURCES="$OUTPUT_DIR/$APP_NAME/$APP_NAME"
if [ -d "$APP_RESOURCES" ]; then
    cp "$EXTENSION_DIR/images/Icon.png" "$APP_RESOURCES/Icon.png" 2>/dev/null || true
    # Also copy to Assets if it exists
    mkdir -p "$APP_RESOURCES/Assets.xcassets/AppIcon.appiconset" 2>/dev/null || true
fi

echo "✓ Icons copied!"
echo ""
echo "══════════════════════════════════════════════════════"
echo "  Next Steps"
echo "══════════════════════════════════════════════════════"
echo ""
echo "1. Open the project:"
echo "   open '$OUTPUT_DIR/$APP_NAME/$APP_NAME.xcodeproj'"
echo ""
echo "2. In Xcode:"
echo "   • Select your Apple ID team (Xcode → Settings → Accounts)"
echo "   • Click the project in the sidebar"
echo "   • Select BOTH targets and set 'Team' under Signing"
echo "   • Press ⌘R to build and run"
echo ""
echo "3. Enable in Safari:"
echo "   • Safari → Settings → Extensions"
echo "   • Check 'reMarkable for Safari'"
echo ""
echo "══════════════════════════════════════════════════════"
echo ""

# Ask if user wants to open the project
read -p "Open Xcode project now? [Y/n] " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
    open "$OUTPUT_DIR/$APP_NAME/$APP_NAME.xcodeproj"
fi
