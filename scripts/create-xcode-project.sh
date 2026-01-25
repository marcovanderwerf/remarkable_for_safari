#!/bin/bash

# create-xcode-project.sh
# Creates an Xcode project for the reMarkable Safari Extension

set -e

PROJECT_NAME="reMarkable for Safari"
BUNDLE_ID_PREFIX="com.remarkable.safari"
PROJECT_DIR="$(dirname "$0")/../build"

echo "Creating Xcode project for reMarkable Safari Extension..."
echo ""

# Check for Xcode
if ! command -v xcodebuild &> /dev/null; then
    echo "Error: Xcode command line tools not found."
    echo "Please install Xcode from the App Store and run:"
    echo "  xcode-select --install"
    exit 1
fi

# Create build directory
mkdir -p "$PROJECT_DIR"

echo "==================================="
echo "  Setup Instructions"
echo "==================================="
echo ""
echo "To create the Safari Extension project:"
echo ""
echo "1. Open Xcode"
echo ""
echo "2. Create new project:"
echo "   - File → New → Project"
echo "   - Choose 'Safari Extension App' template"
echo "   - Product Name: '$PROJECT_NAME'"
echo "   - Bundle Identifier: '$BUNDLE_ID_PREFIX'"
echo "   - Language: Swift"
echo "   - Click Next and save to: $PROJECT_DIR"
echo ""
echo "3. After creation, copy extension files:"
echo ""
echo "   # From the project root directory, run:"
echo "   cp -r extension/* '$PROJECT_DIR/$PROJECT_NAME Extension/Resources/'"
echo ""
echo "4. In Xcode:"
echo "   - Select the Extension target"
echo "   - Go to Build Phases → Copy Bundle Resources"
echo "   - Verify all files are included"
echo ""
echo "5. Replace the Swift files:"
echo "   - Copy safari-extension contents to your project"
echo ""
echo "6. Configure code signing:"
echo "   - Select your development team"
echo "   - Set bundle identifiers"
echo ""
echo "7. Build and Run (⌘R)"
echo ""
echo "8. Enable in Safari:"
echo "   - Safari → Settings → Extensions"
echo "   - Enable 'reMarkable for Safari'"
echo ""
echo "==================================="
echo ""
echo "For detailed instructions, see README.md"
