/**
 * Background script for reMarkable Safari Extension
 * Handles authentication and communication with reMarkable Cloud API
 */

// API Configuration
const API_CONFIG = {
  AUTH_URL: 'https://webapp-production-dot-remarkable-production.appspot.com',
  SYNC_URL: 'https://document-storage-production-dot-remarkable-production.appspot.com',
  DISCOVERY_URL: 'https://service-manager-production-dot-remarkable-production.appspot.com',
  DEVICE_DESC: 'browser-safari-extension',
  DEVICE_ID: null // Generated on first use
};

// Storage keys
const STORAGE_KEYS = {
  DEVICE_TOKEN: 'rm_device_token',
  USER_TOKEN: 'rm_user_token',
  DEVICE_ID: 'rm_device_id',
  USER_EMAIL: 'rm_user_email',
  FOLDERS: 'rm_folders',
  SYNC_HOST: 'rm_sync_host'
};

// State
let deviceToken = null;
let userToken = null;
let syncHost = null;
let tokenExpiry = null;

// Initialize
async function init() {
  await loadStoredCredentials();
  if (deviceToken) {
    await refreshUserToken();
  }
}

// Credential Management
async function loadStoredCredentials() {
  try {
    const result = await browser.storage.local.get([
      STORAGE_KEYS.DEVICE_TOKEN,
      STORAGE_KEYS.USER_TOKEN,
      STORAGE_KEYS.DEVICE_ID,
      STORAGE_KEYS.SYNC_HOST
    ]);

    deviceToken = result[STORAGE_KEYS.DEVICE_TOKEN] || null;
    userToken = result[STORAGE_KEYS.USER_TOKEN] || null;
    API_CONFIG.DEVICE_ID = result[STORAGE_KEYS.DEVICE_ID] || generateDeviceId();
    syncHost = result[STORAGE_KEYS.SYNC_HOST] || null;

    if (!result[STORAGE_KEYS.DEVICE_ID]) {
      await browser.storage.local.set({
        [STORAGE_KEYS.DEVICE_ID]: API_CONFIG.DEVICE_ID
      });
    }
  } catch (error) {
    console.error('Error loading credentials:', error);
  }
}

async function saveCredentials(deviceTok, userTok, email) {
  try {
    await browser.storage.local.set({
      [STORAGE_KEYS.DEVICE_TOKEN]: deviceTok,
      [STORAGE_KEYS.USER_TOKEN]: userTok,
      [STORAGE_KEYS.USER_EMAIL]: email || ''
    });
    deviceToken = deviceTok;
    userToken = userTok;
  } catch (error) {
    console.error('Error saving credentials:', error);
    throw error;
  }
}

async function clearCredentials() {
  try {
    await browser.storage.local.remove([
      STORAGE_KEYS.DEVICE_TOKEN,
      STORAGE_KEYS.USER_TOKEN,
      STORAGE_KEYS.USER_EMAIL,
      STORAGE_KEYS.FOLDERS,
      STORAGE_KEYS.SYNC_HOST
    ]);
    deviceToken = null;
    userToken = null;
    syncHost = null;
    tokenExpiry = null;
  } catch (error) {
    console.error('Error clearing credentials:', error);
  }
}

function generateDeviceId() {
  // Generate a UUID v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Authentication
async function authenticate(code) {
  try {
    // Step 1: Exchange code for device token
    const deviceTokenResponse = await fetch(`${API_CONFIG.AUTH_URL}/token/json/2/device/new`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        code: code,
        deviceDesc: API_CONFIG.DEVICE_DESC,
        deviceID: API_CONFIG.DEVICE_ID
      })
    });

    if (!deviceTokenResponse.ok) {
      const errorText = await deviceTokenResponse.text();
      throw new Error(`Authentication failed: ${errorText || deviceTokenResponse.statusText}`);
    }

    const newDeviceToken = await deviceTokenResponse.text();

    // Step 2: Get user token
    const userTokenResponse = await fetch(`${API_CONFIG.AUTH_URL}/token/json/2/user/new`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${newDeviceToken}`
      }
    });

    if (!userTokenResponse.ok) {
      throw new Error('Failed to get user token');
    }

    const newUserToken = await userTokenResponse.text();

    // Save credentials
    await saveCredentials(newDeviceToken, newUserToken);

    // Discover sync host
    await discoverSyncHost();

    // Get folders
    const folders = await getFolders();

    return {
      success: true,
      folders: folders
    };
  } catch (error) {
    console.error('Authentication error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

async function refreshUserToken() {
  if (!deviceToken) {
    return false;
  }

  try {
    const response = await fetch(`${API_CONFIG.AUTH_URL}/token/json/2/user/new`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${deviceToken}`
      }
    });

    if (!response.ok) {
      // Device token might be invalid, need to re-authenticate
      await clearCredentials();
      return false;
    }

    userToken = await response.text();
    await browser.storage.local.set({
      [STORAGE_KEYS.USER_TOKEN]: userToken
    });

    // Update token expiry (tokens last ~1 hour)
    tokenExpiry = Date.now() + (55 * 60 * 1000);

    return true;
  } catch (error) {
    console.error('Error refreshing user token:', error);
    return false;
  }
}

async function ensureValidToken() {
  if (!deviceToken || !userToken) {
    return false;
  }

  // Refresh if token is expired or will expire soon
  if (!tokenExpiry || Date.now() > tokenExpiry) {
    return await refreshUserToken();
  }

  return true;
}

// Service Discovery
async function discoverSyncHost() {
  try {
    const response = await fetch(`${API_CONFIG.DISCOVERY_URL}/service/json/1/document-storage?environment=production&group=auth0%7C`, {
      headers: {
        'Authorization': `Bearer ${userToken}`
      }
    });

    if (response.ok) {
      const data = await response.json();
      syncHost = data.Host || API_CONFIG.SYNC_URL.replace('https://', '');
      await browser.storage.local.set({
        [STORAGE_KEYS.SYNC_HOST]: syncHost
      });
    } else {
      // Fallback to default
      syncHost = API_CONFIG.SYNC_URL.replace('https://', '');
    }
  } catch (error) {
    console.error('Service discovery error:', error);
    syncHost = API_CONFIG.SYNC_URL.replace('https://', '');
  }
}

function getSyncUrl() {
  return syncHost ? `https://${syncHost}` : API_CONFIG.SYNC_URL;
}

// Folder Management
async function getFolders() {
  if (!await ensureValidToken()) {
    return [];
  }

  try {
    const response = await fetch(`${getSyncUrl()}/document-storage/json/2/docs`, {
      headers: {
        'Authorization': `Bearer ${userToken}`
      }
    });

    if (!response.ok) {
      throw new Error('Failed to fetch documents');
    }

    const docs = await response.json();

    // Filter for folders (type: CollectionType)
    const folders = docs
      .filter(doc => doc.Type === 'CollectionType')
      .map(doc => ({
        id: doc.ID,
        name: doc.VissibleName || doc.VisibleName || 'Untitled',
        parent: doc.Parent || ''
      }));

    // Save folders for later use
    await browser.storage.local.set({
      [STORAGE_KEYS.FOLDERS]: folders
    });

    return folders;
  } catch (error) {
    console.error('Error fetching folders:', error);
    return [];
  }
}

// Document Upload
async function sendToRemarkable(article, options = {}) {
  if (!await ensureValidToken()) {
    return { success: false, error: 'Not authenticated' };
  }

  try {
    const docId = generateDeviceId();
    const timestamp = Date.now();

    // Generate clean HTML content
    const htmlContent = generateEpubHtml(article, options);

    // Create EPUB
    const epubBlob = await createEpub(docId, article.title, htmlContent, article.images, options);

    // Step 1: Request upload URL
    const uploadRequest = [{
      ID: docId,
      Type: 'DocumentType',
      Version: 1
    }];

    const uploadResponse = await fetch(`${getSyncUrl()}/document-storage/json/2/upload/request`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(uploadRequest)
    });

    if (!uploadResponse.ok) {
      throw new Error('Failed to get upload URL');
    }

    const uploadData = await uploadResponse.json();

    if (!uploadData[0] || !uploadData[0].BlobURLPut) {
      throw new Error('Invalid upload response');
    }

    // Step 2: Upload the EPUB/zip file
    const blobUrl = uploadData[0].BlobURLPut;

    const blobUploadResponse = await fetch(blobUrl, {
      method: 'PUT',
      body: epubBlob
    });

    if (!blobUploadResponse.ok) {
      throw new Error('Failed to upload document');
    }

    // Step 3: Update metadata
    const metadata = {
      ID: docId,
      Type: 'DocumentType',
      VissibleName: article.title.substring(0, 128),
      Version: 1,
      Parent: options.folderId || '',
      ModifiedClient: new Date().toISOString(),
      CurrentPage: 0,
      Bookmarked: false
    };

    const metadataResponse = await fetch(`${getSyncUrl()}/document-storage/json/2/upload/update-status`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([metadata])
    });

    if (!metadataResponse.ok) {
      console.warn('Metadata update returned non-200, but document may still be uploaded');
    }

    return { success: true, documentId: docId };
  } catch (error) {
    console.error('Error sending to reMarkable:', error);
    return { success: false, error: error.message };
  }
}

// EPUB Generation
function generateEpubHtml(article, options) {
  const simplify = options.simplifyLayout !== false;

  let styles = `
    body {
      font-family: serif;
      line-height: 1.6;
      margin: 1em;
    }
    h1 { font-size: 1.5em; margin-bottom: 0.5em; }
    h2 { font-size: 1.3em; }
    h3 { font-size: 1.1em; }
    p { margin: 0.8em 0; text-align: justify; }
    blockquote {
      margin: 1em 0;
      padding-left: 1em;
      border-left: 2px solid #666;
      font-style: italic;
    }
    img { max-width: 100%; height: auto; }
    .byline { font-size: 0.9em; color: #666; margin-bottom: 1em; }
    .source { font-size: 0.8em; color: #888; margin-top: 2em; padding-top: 1em; border-top: 1px solid #ccc; }
  `;

  if (simplify) {
    styles += `
      * { color: #000 !important; background: #fff !important; }
      a { text-decoration: underline; }
    `;
  }

  // Clean up the content
  let content = article.content || '';

  // Remove images if requested
  if (options.includeImages === false) {
    content = content.replace(/<img[^>]*>/gi, '');
    content = content.replace(/<figure[^>]*>.*?<\/figure>/gi, '');
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeXml(article.title)}</title>
  <style>${styles}</style>
</head>
<body>
  <h1>${escapeXml(article.title)}</h1>
  ${article.byline ? `<p class="byline">${escapeXml(article.byline)}</p>` : ''}
  ${content}
  <p class="source">Source: ${escapeXml(article.url)}</p>
</body>
</html>`;
}

async function createEpub(docId, title, htmlContent, images, options) {
  // Create a minimal EPUB structure as a zip file
  // reMarkable accepts EPUB files which are essentially zip archives

  const JSZip = await loadJSZip();
  const zip = new JSZip();

  // Sanitize title for filename
  const safeTitle = title.replace(/[^a-zA-Z0-9\s]/g, '').substring(0, 50) || 'Article';

  // EPUB mimetype (must be first and uncompressed)
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  // Container XML
  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
  zip.file('META-INF/container.xml', containerXml);

  // Content OPF
  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${docId}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="article" href="article.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    <itemref idref="article"/>
  </spine>
</package>`;
  zip.file('OEBPS/content.opf', contentOpf);

  // Navigation document
  const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <meta charset="UTF-8"/>
  <title>Navigation</title>
</head>
<body>
  <nav epub:type="toc">
    <h1>Contents</h1>
    <ol>
      <li><a href="article.xhtml">${escapeXml(title)}</a></li>
    </ol>
  </nav>
</body>
</html>`;
  zip.file('OEBPS/nav.xhtml', navXhtml);

  // Article content
  zip.file('OEBPS/article.xhtml', htmlContent);

  // Generate the zip blob
  return await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  });
}

// JSZip loader (inline minimal implementation or load from CDN)
async function loadJSZip() {
  // Check if JSZip is already loaded
  if (typeof JSZip !== 'undefined') {
    return JSZip;
  }

  // Minimal zip implementation for creating EPUBs
  return {
    file(name, content, options = {}) {
      this._files = this._files || {};
      this._files[name] = { content, options };
      return this;
    },
    async generateAsync(options) {
      // Use the browser's Compression Streams API if available
      // For Safari, we'll create a simple uncompressed zip
      const files = this._files;
      const entries = Object.entries(files);

      // Calculate total size for buffer
      let totalSize = 22; // End of central directory
      const fileHeaders = [];

      for (const [name, { content }] of entries) {
        const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
        const nameBytes = new TextEncoder().encode(name);
        totalSize += 30 + nameBytes.length + data.length; // Local file header
        totalSize += 46 + nameBytes.length; // Central directory header
        fileHeaders.push({ name, nameBytes, data });
      }

      const buffer = new ArrayBuffer(totalSize);
      const view = new DataView(buffer);
      const bytes = new Uint8Array(buffer);
      let offset = 0;
      let centralDirOffset = 0;
      const centralDirEntries = [];

      // Write local file headers and data
      for (const { name, nameBytes, data } of fileHeaders) {
        const headerOffset = offset;

        // Local file header
        view.setUint32(offset, 0x04034b50, true); offset += 4; // Signature
        view.setUint16(offset, 20, true); offset += 2; // Version needed
        view.setUint16(offset, 0, true); offset += 2; // Flags
        view.setUint16(offset, 0, true); offset += 2; // Compression (store)
        view.setUint16(offset, 0, true); offset += 2; // Mod time
        view.setUint16(offset, 0, true); offset += 2; // Mod date
        view.setUint32(offset, crc32(data), true); offset += 4; // CRC32
        view.setUint32(offset, data.length, true); offset += 4; // Compressed size
        view.setUint32(offset, data.length, true); offset += 4; // Uncompressed size
        view.setUint16(offset, nameBytes.length, true); offset += 2; // Name length
        view.setUint16(offset, 0, true); offset += 2; // Extra length

        bytes.set(nameBytes, offset);
        offset += nameBytes.length;

        bytes.set(data, offset);
        offset += data.length;

        centralDirEntries.push({ nameBytes, data, headerOffset });
      }

      centralDirOffset = offset;

      // Write central directory
      for (const { nameBytes, data, headerOffset } of centralDirEntries) {
        view.setUint32(offset, 0x02014b50, true); offset += 4; // Signature
        view.setUint16(offset, 20, true); offset += 2; // Version made by
        view.setUint16(offset, 20, true); offset += 2; // Version needed
        view.setUint16(offset, 0, true); offset += 2; // Flags
        view.setUint16(offset, 0, true); offset += 2; // Compression
        view.setUint16(offset, 0, true); offset += 2; // Mod time
        view.setUint16(offset, 0, true); offset += 2; // Mod date
        view.setUint32(offset, crc32(data), true); offset += 4; // CRC32
        view.setUint32(offset, data.length, true); offset += 4; // Compressed size
        view.setUint32(offset, data.length, true); offset += 4; // Uncompressed size
        view.setUint16(offset, nameBytes.length, true); offset += 2; // Name length
        view.setUint16(offset, 0, true); offset += 2; // Extra length
        view.setUint16(offset, 0, true); offset += 2; // Comment length
        view.setUint16(offset, 0, true); offset += 2; // Disk number
        view.setUint16(offset, 0, true); offset += 2; // Internal attrs
        view.setUint32(offset, 0, true); offset += 4; // External attrs
        view.setUint32(offset, headerOffset, true); offset += 4; // Header offset

        bytes.set(nameBytes, offset);
        offset += nameBytes.length;
      }

      const centralDirSize = offset - centralDirOffset;

      // End of central directory
      view.setUint32(offset, 0x06054b50, true); offset += 4; // Signature
      view.setUint16(offset, 0, true); offset += 2; // Disk number
      view.setUint16(offset, 0, true); offset += 2; // Central dir disk
      view.setUint16(offset, centralDirEntries.length, true); offset += 2; // Entries on disk
      view.setUint16(offset, centralDirEntries.length, true); offset += 2; // Total entries
      view.setUint32(offset, centralDirSize, true); offset += 4; // Central dir size
      view.setUint32(offset, centralDirOffset, true); offset += 4; // Central dir offset
      view.setUint16(offset, 0, true); offset += 2; // Comment length

      return new Blob([buffer.slice(0, offset)], { type: options.mimeType || 'application/zip' });
    }
  };
}

// CRC32 implementation
function crc32(data) {
  const table = getCrc32Table();
  let crc = 0xFFFFFFFF;

  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
  }

  return (crc ^ 0xFFFFFFFF) >>> 0;
}

let crc32Table = null;
function getCrc32Table() {
  if (crc32Table) return crc32Table;

  crc32Table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crc32Table[i] = c;
  }
  return crc32Table;
}

// Utility functions
function escapeXml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Message Handler
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request).then(sendResponse);
  return true; // Keep the message channel open for async response
});

async function handleMessage(request) {
  switch (request.action) {
    case 'checkAuth':
      const isAuth = !!(deviceToken && userToken);
      let email = '';
      let folders = [];

      if (isAuth) {
        const stored = await browser.storage.local.get([STORAGE_KEYS.USER_EMAIL, STORAGE_KEYS.FOLDERS]);
        email = stored[STORAGE_KEYS.USER_EMAIL] || '';
        folders = stored[STORAGE_KEYS.FOLDERS] || [];
      }

      return {
        isAuthenticated: isAuth,
        email: email,
        folders: folders
      };

    case 'authenticate':
      return await authenticate(request.code);

    case 'disconnect':
      await clearCredentials();
      return { success: true };

    case 'sendToRemarkable':
      return await sendToRemarkable(request.article, request.options);

    case 'getFolders':
      return { folders: await getFolders() };

    default:
      return { error: 'Unknown action' };
  }
}

// Initialize on load
init();
