/**
 * Background script for reMarkable Safari Extension
 * Handles authentication and communication with the reMarkable Cloud API.
 *
 * Protocol: reMarkable "sync 1.5" (a.k.a. sync15), as implemented by
 * ddvk/rmapi (api/sync15, config/url.go, transport/transport.go):
 *
 *   Auth   https://webapp-prod.cloud.remarkable.engineering
 *          POST /token/json/2/device/new   one-time code -> device token
 *          POST /token/json/2/user/new     device token  -> user token (JWT)
 *   Sync   https://internal.cloud.remarkable.com
 *          GET  /sync/v4/root              current root hash + generation
 *          PUT  /sync/v3/root              swap root (optimistic, by generation)
 *          GET  /sync/v3/files/{hash}      read a content-addressed blob
 *          PUT  /sync/v3/files/{hash}      write a content-addressed blob
 *
 * The cloud is a content-addressed tree: the root index lists one entry per
 * document (hash of its own index), and each document index lists its files
 * (.metadata, .content, .pdf/.epub). Uploading = write the file blobs, write
 * the document index, write a new root index that includes it, then swap the
 * root pointer. The old document-storage/json/2 endpoints no longer exist.
 */

// API Configuration
const API_CONFIG = {
  AUTH_HOST: 'https://webapp-prod.cloud.remarkable.engineering',
  SYNC_HOST: 'https://internal.cloud.remarkable.com',
  // Codes from my.remarkable.com/device/browser/connect are for browser
  // clients; "browser-chrome" is the device description reMarkable's own
  // browser extension registers with.
  DEVICE_DESC: 'browser-chrome',
  DEVICE_ID: null, // Generated on first use
  CONCURRENCY: 8,
  MAX_SYNC_TRIES: 10
};

const ENDPOINTS = {
  DEVICE_NEW: `${API_CONFIG.AUTH_HOST}/token/json/2/device/new`,
  USER_NEW: `${API_CONFIG.AUTH_HOST}/token/json/2/user/new`,
  ROOT_GET: `${API_CONFIG.SYNC_HOST}/sync/v4/root`,
  ROOT_PUT: `${API_CONFIG.SYNC_HOST}/sync/v3/root`,
  FILES: `${API_CONFIG.SYNC_HOST}/sync/v3/files/`
};

// Index (docSchema) format constants, see rmapi api/sync15/tree.go
const SCHEMA_V3 = '3';
const SCHEMA_V4 = '4';
const FILE_TYPE = '0';
const COLLECTION_TYPE = 'CollectionType';
const DOCUMENT_TYPE = 'DocumentType';
const TRASH_ID = 'trash';

// Storage keys
const STORAGE_KEYS = {
  DEVICE_TOKEN: 'rm_device_token',
  USER_TOKEN: 'rm_user_token',
  DEVICE_ID: 'rm_device_id',
  USER_EMAIL: 'rm_user_email',
  FOLDERS: 'rm_folders',
  DOC_CACHE: 'rm_doc_cache',
  SYNC_HOST: 'rm_sync_host' // legacy (v2 service discovery); only removed
};

// State
let deviceToken = null;
let userToken = null;
let tokenExpiry = null;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Initialize. The service worker can be stopped and restarted at any time,
// so message handling waits for credentials to be loaded first.
let initPromise = null;
function init() {
  if (!initPromise) {
    initPromise = loadStoredCredentials();
  }
  return initPromise;
}

// Credential Management
async function loadStoredCredentials() {
  try {
    const result = await browser.storage.local.get([
      STORAGE_KEYS.DEVICE_TOKEN,
      STORAGE_KEYS.USER_TOKEN,
      STORAGE_KEYS.DEVICE_ID
    ]);

    deviceToken = result[STORAGE_KEYS.DEVICE_TOKEN] || null;
    userToken = result[STORAGE_KEYS.USER_TOKEN] || null;
    tokenExpiry = userToken ? jwtExpiry(userToken) : null;
    API_CONFIG.DEVICE_ID = result[STORAGE_KEYS.DEVICE_ID] || generateUuid();

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
  await browser.storage.local.set({
    [STORAGE_KEYS.DEVICE_TOKEN]: deviceTok,
    [STORAGE_KEYS.USER_TOKEN]: userTok,
    [STORAGE_KEYS.USER_EMAIL]: email || ''
  });
  deviceToken = deviceTok;
  userToken = userTok;
  tokenExpiry = jwtExpiry(userTok);
}

async function clearCredentials() {
  try {
    await browser.storage.local.remove([
      STORAGE_KEYS.DEVICE_TOKEN,
      STORAGE_KEYS.USER_TOKEN,
      STORAGE_KEYS.USER_EMAIL,
      STORAGE_KEYS.FOLDERS,
      STORAGE_KEYS.DOC_CACHE,
      STORAGE_KEYS.SYNC_HOST
    ]);
  } catch (error) {
    console.error('Error clearing credentials:', error);
  }
  deviceToken = null;
  userToken = null;
  tokenExpiry = null;
}

function generateUuid() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Kept for compatibility with the EPUB code below
function generateDeviceId() {
  return generateUuid();
}

function decodeJwt(token) {
  try {
    const part = token.split('.')[1];
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    return null;
  }
}

function jwtExpiry(token) {
  const payload = decodeJwt(token);
  if (payload && typeof payload.exp === 'number') {
    return payload.exp * 1000;
  }
  // Unknown format: assume the documented ~1h lifetime
  return Date.now() + 55 * 60 * 1000;
}

function emailFromToken(token) {
  const payload = decodeJwt(token) || {};
  const profile = payload['auth0-profile'] || {};
  return profile.Email || profile.email || payload.email || '';
}

// Authentication
async function authenticate(code) {
  try {
    await init();
    const cleanCode = (code || '').trim();
    if (!cleanCode) {
      throw new Error('Please enter a code');
    }

    // Step 1: Exchange one-time code for a device token (rmapi newDeviceToken)
    const deviceTokenResponse = await fetch(ENDPOINTS.DEVICE_NEW, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        code: cleanCode,
        deviceDesc: API_CONFIG.DEVICE_DESC,
        deviceID: API_CONFIG.DEVICE_ID
      })
    });

    if (!deviceTokenResponse.ok) {
      const errorText = (await deviceTokenResponse.text()).trim();
      throw new Error(`Authentication failed: ${errorText || deviceTokenResponse.statusText || deviceTokenResponse.status}`);
    }

    const newDeviceToken = (await deviceTokenResponse.text()).trim();
    if (!newDeviceToken) {
      throw new Error('Authentication failed: empty device token');
    }

    // Step 2: Get user token (rmapi newUserToken)
    const newUserToken = await requestUserToken(newDeviceToken);

    await saveCredentials(newDeviceToken, newUserToken, emailFromToken(newUserToken) || 'reMarkable account');

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

async function requestUserToken(devTok) {
  const response = await fetch(ENDPOINTS.USER_NEW, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${devTok}`
    }
  });

  if (!response.ok) {
    const text = (await response.text().catch(() => '')).trim();
    throw new HttpError(response.status, `Failed to get user token (${response.status})${text ? ': ' + text : ''}`);
  }

  const token = (await response.text()).trim();
  if (!token) {
    throw new Error('Failed to get user token: empty response');
  }
  return token;
}

async function refreshUserToken() {
  if (!deviceToken) {
    throw new HttpError(401, 'Not connected to reMarkable');
  }

  try {
    userToken = await requestUserToken(deviceToken);
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      // Device token revoked or invalid: the user has to pair again
      await clearCredentials();
      throw new HttpError(401, 'Your reMarkable session has expired. Please connect again.');
    }
    throw error;
  }

  tokenExpiry = jwtExpiry(userToken);
  await browser.storage.local.set({
    [STORAGE_KEYS.USER_TOKEN]: userToken
  });
  return userToken;
}

async function ensureValidToken() {
  await init();
  if (!deviceToken) {
    throw new HttpError(401, 'Not connected to reMarkable');
  }
  // Refresh if missing, expired, or expiring within 5 minutes
  if (!userToken || !tokenExpiry || Date.now() > tokenExpiry - 5 * 60 * 1000) {
    await refreshUserToken();
  }
  return userToken;
}

// HTTP helpers (mirror rmapi transport.HttpClientCtx)
async function syncFetch(url, options = {}, retried = false) {
  const token = await ensureValidToken();
  const headers = Object.assign({}, options.headers, {
    'Authorization': `Bearer ${token}`
  });

  const response = await fetch(url, Object.assign({}, options, { headers }));

  if (response.status === 401 && !retried) {
    await refreshUserToken();
    return syncFetch(url, options, true);
  }

  if (!response.ok) {
    const text = (await response.text().catch(() => '')).trim();
    const path = url.replace(API_CONFIG.SYNC_HOST, '');
    throw new HttpError(response.status,
      `${options.method || 'GET'} ${path} failed (${response.status})${text ? ': ' + text.slice(0, 200) : ''}`);
  }

  return response;
}

async function getRoot() {
  let response;
  try {
    response = await syncFetch(ENDPOINTS.ROOT_GET);
  } catch (error) {
    if (error.status === 404) {
      return { hash: '', generation: 0 }; // empty cloud
    }
    throw error;
  }
  const data = await response.json();
  return {
    hash: data.hash || '',
    generation: data.generation || 0,
    schemaVersion: data.schemaVersion
  };
}

async function getBlob(hash, filename) {
  const response = await syncFetch(ENDPOINTS.FILES + hash, {
    headers: { 'rm-filename': filename }
  });
  return response.text();
}

async function putBlob(hash, filename, bytes, contentType) {
  await syncFetch(ENDPOINTS.FILES + hash, {
    method: 'PUT',
    headers: {
      'rm-filename': filename,
      'x-goog-hash': `crc32c=${crc32c(bytes)}`,
      'Content-Type': contentType || 'application/octet-stream'
    },
    body: bytes
  });
}

// Returns the new generation, or null if the root changed in the meantime
async function putRoot(hash, generation, broadcast) {
  const body = new TextEncoder().encode(JSON.stringify({ broadcast, hash, generation }));
  let response;
  try {
    response = await syncFetch(ENDPOINTS.ROOT_PUT, {
      method: 'PUT',
      headers: {
        'rm-filename': 'roothash',
        'x-goog-hash': `crc32c=${crc32c(body)}`,
        'Content-Type': 'application/octet-stream'
      },
      body
    });
  } catch (error) {
    if (error.status === 412) {
      return null; // wrong generation
    }
    throw error;
  }
  const data = await response.json();
  if (data.hash !== hash) {
    throw new Error('Root hash mismatch after update');
  }
  return data.generation;
}

// Index (docSchema) parsing / serialization (rmapi tree.go, blobdoc.go)
function parseIndex(text) {
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
  const schema = lines[0];
  let start;
  if (schema === SCHEMA_V4) {
    start = 2; // second line is "0:.:<count>:<totalSize>"
  } else if (schema === SCHEMA_V3) {
    start = 1;
  } else {
    throw new Error(`Unsupported index schema "${schema}"`);
  }

  const entries = [];
  for (const line of lines.slice(start)) {
    if (!line) continue;
    const f = line.split(':').filter(x => x !== '');
    if (f.length !== 5) {
      throw new Error(`Malformed index line "${line}"`);
    }
    entries.push({
      hash: f[0],
      type: f[1],
      id: f[2],
      subfiles: parseInt(f[3], 10),
      size: parseInt(f[4], 10)
    });
  }
  return { schema, entries };
}

function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Root index, always written as schema v4 (servers reject new v3 roots)
function serializeRootIndex(entries) {
  const sorted = entries.slice().sort(byId);
  const total = sorted.reduce((sum, e) => sum + e.size, 0);
  let out = `${SCHEMA_V4}\n0:.:${sorted.length}:${total}\n`;
  for (const e of sorted) {
    out += `${e.hash}:${FILE_TYPE}:${e.id}:${e.subfiles}:${e.size}\n`;
  }
  return out;
}

// Document index, schema v3 (as rmapi writes it)
function serializeDocIndex(files) {
  const sorted = files.slice().sort(byId);
  let out = `${SCHEMA_V3}\n`;
  for (const f of sorted) {
    out += `${f.hash}:${FILE_TYPE}:${f.id}:0:${f.size}\n`;
  }
  return out;
}

// Document hash = sha256 over the concatenated raw file hashes, sorted by name
async function hashDocFiles(files) {
  const sorted = files.slice().sort(byId);
  const raw = new Uint8Array(sorted.length * 32);
  sorted.forEach((f, i) => raw.set(fromHex(f.hash), i * 32));
  return sha256Hex(raw);
}

// Folder Management
async function readRootIndex() {
  const root = await getRoot();
  if (!root.hash) {
    return { root, schema: SCHEMA_V4, entries: [] };
  }
  const index = parseIndex(await getBlob(root.hash, 'root.docSchema'));
  return { root, schema: index.schema, entries: index.entries };
}

async function loadDocCache() {
  const stored = await browser.storage.local.get([STORAGE_KEYS.DOC_CACHE]);
  return stored[STORAGE_KEYS.DOC_CACHE] || {};
}

// Reads (or reuses from cache) the index + metadata of one document
async function describeDoc(entry, cache) {
  const cached = cache[entry.id];
  if (cached && cached.hash === entry.hash) {
    return cached;
  }

  const index = parseIndex(await getBlob(entry.hash, `${entry.id}.docSchema`));
  const info = { hash: entry.hash, files: index.entries.length };

  const metaEntry = index.entries.find(f => f.id.endsWith('.metadata'));
  if (metaEntry) {
    try {
      const meta = JSON.parse(await getBlob(metaEntry.hash, metaEntry.id));
      info.type = meta.type;
      info.deleted = !!meta.deleted;
      if (meta.type === COLLECTION_TYPE) {
        info.name = meta.visibleName || 'Untitled';
        info.parent = meta.parent || '';
      }
    } catch (error) {
      console.warn(`Unreadable metadata for ${entry.id}:`, error);
    }
  }
  return info;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function getFolders() {
  const { entries } = await readRootIndex();
  const cache = await loadDocCache();

  // One unreadable document must not break the whole list
  const infos = await mapLimit(entries, API_CONFIG.CONCURRENCY, e =>
    describeDoc(e, cache).catch(error => {
      console.warn(`Skipping unreadable entry ${e.id}:`, error.message);
      return null;
    }));
  const newCache = {};
  entries.forEach((e, i) => { if (infos[i]) newCache[e.id] = infos[i]; });

  // Build folder list with full paths, skipping deleted and trashed folders
  const byFolderId = {};
  entries.forEach((e, i) => {
    const info = infos[i];
    if (info && info.type === COLLECTION_TYPE && !info.deleted) {
      byFolderId[e.id] = info;
    }
  });

  function pathOf(id, seen = new Set()) {
    const info = byFolderId[id];
    if (!info || seen.has(id)) return null;
    seen.add(id);
    if (!info.parent) return info.name;
    if (info.parent === TRASH_ID) return null;
    const parentPath = pathOf(info.parent, seen);
    return parentPath === null ? null : `${parentPath}/${info.name}`;
  }

  const folders = Object.keys(byFolderId)
    .map(id => ({ id, name: pathOf(id), parent: byFolderId[id].parent }))
    .filter(f => f.name !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  await browser.storage.local.set({
    [STORAGE_KEYS.DOC_CACHE]: newCache,
    [STORAGE_KEYS.FOLDERS]: folders
  });

  return folders;
}

// Document Upload (rmapi ApiCtx.UploadDocument + archive.Prepare + Sync)
function buildMetadata(name, parentId) {
  // Field order matches rmapi archive.MetadataFile
  return JSON.stringify({
    visibleName: name,
    type: DOCUMENT_TYPE,
    parent: parentId || '',
    lastModified: String(Date.now()),
    lastOpened: '',
    lastOpenedPage: 0,
    version: 0,
    pinned: false,
    synced: true,
    modified: false,
    deleted: false,
    metadatamodified: false
  });
}

function buildContent(fileType) {
  // Matches rmapi archive.createZipContent
  return JSON.stringify({
    dummyDocument: false,
    extraMetadata: {
      LastBrushColor: '',
      LastBrushThicknessScale: '',
      LastColor: '',
      LastEraserThicknessScale: '',
      LastEraserTool: '',
      LastPen: 'Finelinerv2',
      LastPenColor: '',
      LastPenThicknessScale: '',
      LastPencil: '',
      LastPencilColor: '',
      LastPencilThicknessScale: '',
      LastTool: 'Finelinerv2',
      ThicknessScale: '',
      LastFinelinerv2Size: '1'
    },
    fileType: fileType,
    fontName: '',
    lastOpenedPage: 0,
    lineHeight: -1,
    margins: 180,
    orientation: '',
    pageCount: 0,
    pages: null,
    pageTags: null,
    tags: null,
    redirectionPageMap: null,
    textScale: 1
  });
}

/**
 * Upload a PDF or EPUB as a new document.
 * @param {string} name       visible name on the tablet
 * @param {string} parentId   folder ID, '' for root
 * @param {Uint8Array} bytes  file contents
 * @param {'pdf'|'epub'} fileType
 */
async function uploadDocument(name, parentId, bytes, fileType) {
  if (fileType !== 'pdf' && fileType !== 'epub') {
    throw new Error(`Unsupported file type: ${fileType}`);
  }
  const encoder = new TextEncoder();
  const id = generateUuid();
  const visibleName = (name || 'Untitled').substring(0, 128);

  const parts = [
    { id: `${id}.${fileType}`, bytes },
    { id: `${id}.metadata`, bytes: encoder.encode(buildMetadata(visibleName, parentId)) },
    { id: `${id}.content`, bytes: encoder.encode(buildContent(fileType)) }
  ];

  // 1. Upload the document's files
  const files = [];
  for (const part of parts) {
    const hash = await sha256Hex(part.bytes);
    await putBlob(hash, part.id, part.bytes);
    files.push({ id: part.id, hash, size: part.bytes.length });
  }

  // 2. Upload the document index
  const docHash = await hashDocFiles(files);
  const docIndex = encoder.encode(serializeDocIndex(files));
  await putBlob(docHash, `${id}.docSchema`, docIndex);

  const newEntry = {
    hash: docHash,
    type: FILE_TYPE,
    id,
    subfiles: files.length,
    size: files.reduce((sum, f) => sum + f.size, 0)
  };

  // 3. Add it to the root index and swap the root; retry if someone else
  //    (e.g. the tablet) changed the root in the meantime.
  for (let attempt = 1; attempt <= API_CONFIG.MAX_SYNC_TRIES; attempt++) {
    const { root, schema, entries } = await readRootIndex();

    let rootEntries = entries.filter(e => e.id !== id);
    if (schema === SCHEMA_V3) {
      // v3 roots don't reliably carry per-document file counts; v4 needs them
      const cache = await loadDocCache();
      rootEntries = await mapLimit(rootEntries, API_CONFIG.CONCURRENCY, async e => {
        const info = await describeDoc(e, cache);
        return Object.assign({}, e, { subfiles: info.files });
      });
    }
    rootEntries.push(newEntry);

    const rootIndex = encoder.encode(serializeRootIndex(rootEntries));
    const rootHash = await sha256Hex(rootIndex);
    await putBlob(rootHash, 'root.docSchema', rootIndex, 'text/plain; charset=UTF-8');

    const generation = await putRoot(rootHash, root.generation, true);
    if (generation !== null) {
      return { documentId: id, generation };
    }
    console.info(`Root changed during upload (attempt ${attempt}), retrying`);
  }
  throw new Error('Could not update the reMarkable library: it kept changing. Please try again.');
}

async function sendToRemarkable(article, options = {}) {
  try {
    await ensureValidToken();

    const docId = generateUuid();

    // Generate clean HTML content
    const htmlContent = generateEpubHtml(article, options);

    // Create EPUB
    const epubBlob = await createEpub(docId, article.title, htmlContent, article.images, options);
    const bytes = new Uint8Array(await epubBlob.arrayBuffer());

    const result = await uploadDocument(article.title || 'Untitled', options.folderId || '', bytes, 'epub');
    return { success: true, documentId: result.documentId };
  } catch (error) {
    console.error('Error sending to reMarkable:', error);
    return { success: false, error: error.message };
  }
}

async function uploadFile(request) {
  try {
    const bytes = base64ToBytes(request.dataBase64 || '');
    if (!bytes.length) {
      throw new Error('No file data');
    }
    const fileType = (request.fileType || 'pdf').toLowerCase();
    const result = await uploadDocument(request.name, request.folderId || '', bytes, fileType);
    return { success: true, documentId: result.documentId };
  } catch (error) {
    console.error('Error uploading file:', error);
    return { success: false, error: error.message };
  }
}

// Hashing / encoding helpers
function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

async function sha256Hex(bytes) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

let crc32cTable = null;
// CRC-32C (Castagnoli), base64 of the big-endian value, as GCS expects
function crc32c(bytes) {
  if (!crc32cTable) {
    crc32cTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0x82F63B78 ^ (c >>> 1)) : (c >>> 1);
      }
      crc32cTable[i] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ crc32cTable[(crc ^ bytes[i]) & 0xFF];
  }
  crc = (crc ^ 0xFFFFFFFF) >>> 0;
  const be = String.fromCharCode((crc >>> 24) & 0xFF, (crc >>> 16) & 0xFF, (crc >>> 8) & 0xFF, crc & 0xFF);
  return btoa(be);
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

  // Minimal zip implementation for creating EPUBs. Returned as a constructor
  // because createEpub() calls `new JSZip()`.
  return function MiniZip() { return {
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
  }; };
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
  await init();

  switch (request.action) {
    case 'checkAuth': {
      const isAuth = !!deviceToken;
      let email = '';
      let folders = [];

      if (isAuth) {
        const stored = await browser.storage.local.get([STORAGE_KEYS.USER_EMAIL, STORAGE_KEYS.FOLDERS]);
        email = stored[STORAGE_KEYS.USER_EMAIL] || 'reMarkable account';
        folders = stored[STORAGE_KEYS.FOLDERS] || [];
        // Refresh the stored folder list in the background for next time
        getFolders().catch(error => console.warn('Folder refresh failed:', error.message));
      }

      return {
        isAuthenticated: isAuth,
        email: email,
        folders: folders
      };
    }

    case 'authenticate':
      return await authenticate(request.code);

    case 'disconnect':
      await clearCredentials();
      return { success: true };

    case 'sendToRemarkable':
      return await sendToRemarkable(request.article, request.options);

    case 'uploadFile':
      return await uploadFile(request);

    case 'getFolders':
      try {
        return { folders: await getFolders() };
      } catch (error) {
        console.error('Error fetching folders:', error);
        return { folders: [], error: error.message };
      }

    default:
      return { error: 'Unknown action' };
  }
}

// Initialize on load
init();
