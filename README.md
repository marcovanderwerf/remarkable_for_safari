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
- Xcode (free from App Store) - needed to build Safari extensions
- A reMarkable account

### Quick Install (Terminal)

```bash
cd ~/Others/Coding
git clone https://github.com/marcovanderwerf/remarkable_for_safari.git
cd remarkable_for_safari
./build.sh
```

The script will:
- Convert the extension to Safari format automatically
- Create an Xcode project
- Ask if you want to open it

Then in Xcode:
1. Set your Team (click project → Signing & Capabilities → Team)
2. Press **⌘R** to build and run
3. Enable in **Safari → Settings → Extensions**

That's it!

### Manual Installation

If you prefer to set things up manually, see the [detailed instructions](#manual-setup) below.

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

### reMarkable Cloud API version

The extension uses reMarkable's current **sync 1.5 ("sync15") protocol**, the same
one the [ddvk fork of rmapi](https://github.com/ddvk/rmapi) implements
(`api/sync15`, `config/url.go`); `extension/background.js` is a port of it.

| Purpose | Host | Endpoints |
|---|---|---|
| Pairing / tokens | `webapp-prod.cloud.remarkable.engineering` | `POST /token/json/2/device/new` (one-time code → device token), `POST /token/json/2/user/new` (device token → user token) |
| Library | `internal.cloud.remarkable.com` | `GET /sync/v4/root`, `PUT /sync/v3/root`, `GET`/`PUT /sync/v3/files/{hash}` |

How an upload works: the library is a content-addressed tree. The extension
uploads the document's files (`<id>.epub` or `<id>.pdf`, `<id>.metadata`,
`<id>.content`), then the document index (schema 3), then a new root index
(schema 4, sorted by document ID) that includes it, and finally swaps the root
pointer by generation. If the tablet changed the library in the meantime the
server answers `412` and the extension re-reads the root and retries. Folder
listing reads the root index and each entry's `.metadata`; results are cached
per document hash so only changed entries are fetched again.

The old v2 API (`document-storage-production-dot-remarkable-production.appspot.com`,
`/document-storage/json/2/upload/request`, `/upload/update-status`, `/docs` and
service discovery on `service-manager-production-dot-remarkable-production.appspot.com`)
has been shut down: every path on those hosts now returns HTTP 404. Versions of
this extension from before this change cannot upload anything.

Pairing registers the extension as `browser-chrome`, the device type for codes
from `my.remarkable.com/device/browser/connect`. The device shows up under
*Connected apps* on my.remarkable.com and can be revoked there.

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
├── tests/                       # Mock-cloud test for the sync 1.5 client
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
4. If you used a version of this extension from before the sync 1.5 port, rebuild
   it with `./build.sh`: the old API it used no longer exists

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
- Only sends data to reMarkable's official cloud servers (`webapp-prod.cloud.remarkable.engineering` and `internal.cloud.remarkable.com`)
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

The cloud API code has an end-to-end test against a local mock of the sync 1.5
cloud (pairing, folder listing, PDF and EPUB upload, generation conflicts, token
refresh). It needs only Node.js 18+:

```bash
node tests/sync15.test.mjs
```

To debug the extension in Safari:

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
