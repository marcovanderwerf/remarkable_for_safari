# reMarkable for Safari

A Safari Web Extension that lets you send web articles, news, and other content directly to your reMarkable tablet with one click. Clean, ad-free reading on your e-ink device.

## Features

- **One-Click Save**: Click the extension icon to instantly send the current page to your reMarkable
- **Smart Content Extraction**: Uses Readability algorithm to extract just the article content, removing ads, navigation, and clutter
- **Clean Formatting**: Articles are optimized for e-ink display with clear typography
- **Folder Organization**: Choose which folder to save articles to on your reMarkable
- **Image Support**: Optionally include images in your saved articles
- **Dark Mode**: Extension UI supports both light and dark modes

## Installation

### Prerequisites

- macOS 11.0 (Big Sur) or later
- Safari 14 or later
- Xcode 13 or later (for building from source)
- A reMarkable account

### Building from Source

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/remarkable_for_safari.git
   cd remarkable_for_safari
   ```

2. **Create the Xcode project**

   Open Xcode and create a new Safari Web Extension project:
   - File → New → Project
   - Choose "Safari Extension App" template
   - Name it "reMarkable for Safari"
   - Select a location and create

3. **Copy the extension files**

   Replace the generated extension files with the ones from this repository:
   ```bash
   # Copy web extension files to Resources folder
   cp -r extension/* "path/to/your/xcode/project/reMarkable for Safari Extension/Resources/"
   ```

4. **Configure the project**
   - Open the Xcode project
   - Select the extension target
   - Ensure the manifest.json is included in the "Copy Bundle Resources" build phase
   - Set your development team for code signing

5. **Build and Run**
   - Select the main app scheme
   - Build and run (⌘R)
   - This will install the extension and open the host app

6. **Enable in Safari**
   - Open Safari → Preferences → Extensions
   - Enable "reMarkable for Safari"

### Alternative: Using the Project Generator Script

```bash
./scripts/create-xcode-project.sh
```

This script will set up the Xcode project structure automatically.

## Usage

### First-Time Setup

1. Click the reMarkable extension icon in Safari's toolbar
2. Click "Connect Account"
3. Go to [my.remarkable.com/device/browser/connect](https://my.remarkable.com/device/browser/connect)
4. Log in with your reMarkable account
5. Copy the one-time code
6. Paste it into the extension and click "Connect"

### Sending Articles

1. Navigate to any article or webpage you want to save
2. Click the reMarkable extension icon
3. The extension will extract the article content
4. (Optional) Choose a folder to save to
5. Click "Send to reMarkable"
6. Your article will appear on your reMarkable!

### Settings

Click the gear icon to access settings:

- **Include images**: Toggle whether to include images in saved articles
- **Simplify layout**: Optimize formatting for e-ink display
- **Default folder**: Choose a default save location

## How It Works

### Article Extraction

The extension uses a Readability-based algorithm (similar to Firefox's Reader View) to:

1. Identify the main content area of the page
2. Remove ads, navigation, sidebars, and other clutter
3. Extract clean HTML with proper formatting
4. Convert relative URLs to absolute URLs

### reMarkable Integration

The extension communicates with reMarkable's Cloud API to:

1. Authenticate using a one-time code
2. Create EPUB documents from extracted content
3. Upload documents to your reMarkable cloud storage
4. Sync automatically to your tablet

### Document Format

Articles are saved as EPUB files, which reMarkable displays natively. This provides:

- Reflowable text that adapts to your reading preferences
- Support for headings, paragraphs, lists, and quotes
- Optional images with proper sizing
- Source URL attribution

## Project Structure

```
remarkable_for_safari/
├── extension/                    # Web extension source files
│   ├── manifest.json            # Extension manifest
│   ├── background.js            # Background service worker
│   ├── content/
│   │   ├── content.js          # Content script for article extraction
│   │   └── readability.js      # Readability algorithm
│   ├── popup/
│   │   ├── popup.html          # Extension popup UI
│   │   ├── popup.css           # Popup styles
│   │   └── popup.js            # Popup logic
│   └── images/                  # Extension icons
├── safari-extension/            # Xcode project templates
│   ├── reMarkable for Safari/   # Host app
│   └── reMarkable for Safari Extension/  # Safari extension
├── scripts/                     # Build and utility scripts
└── README.md
```

## Troubleshooting

### Extension not appearing in Safari

1. Make sure you've built and run the app at least once
2. Check Safari → Preferences → Extensions
3. Ensure the extension is enabled
4. Try disabling and re-enabling the extension

### Authentication fails

1. Make sure you're getting a fresh code from my.remarkable.com
2. Codes expire after a few minutes
3. Try disconnecting and reconnecting

### Articles not syncing to tablet

1. Ensure your tablet is connected to WiFi
2. Check that cloud sync is enabled on your tablet
3. Try forcing a sync on the tablet (Settings → Storage → Sync Now)

### Content extraction issues

Some websites use complex layouts that may not extract perfectly. If an article doesn't look right:

1. Try selecting the article text before clicking the extension
2. Some paywalled content may not extract properly
3. PDF-based articles won't be extracted

## Privacy

This extension:

- Only activates when you click the extension icon
- Only sends data to reMarkable's official cloud servers
- Stores authentication tokens locally in Safari's secure storage
- Does not track, collect, or share any browsing data

## Development

### Requirements

- Xcode 13+
- macOS 11+
- Node.js (optional, for development scripts)

### Building

```bash
# Install dependencies (optional)
npm install

# Build extension (optional bundling step)
npm run build
```

### Testing

1. Open the Xcode project
2. Edit Scheme → Run → Arguments → Add `-NSExtensionPointIdentifier com.apple.Safari.web-extension`
3. Run the extension target directly for debugging

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- [Mozilla Readability](https://github.com/mozilla/readability) - Article extraction algorithm
- [reMarkable](https://remarkable.com) - For creating an amazing e-ink tablet
- Safari Web Extension documentation by Apple

## Disclaimer

This is an unofficial, community-developed extension. It is not affiliated with, endorsed by, or supported by reMarkable AS. Use at your own risk.
