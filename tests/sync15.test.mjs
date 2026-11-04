// End-to-end test of extension/background.js against a local mock of the
// reMarkable sync 1.5 cloud. The mock enforces the same rules the real cloud
// does as described by ddvk/rmapi: content-addressed blobs (sha256), CRC32C
// upload checksums, sorted v4 root index, v3 document index hashing, and
// optimistic root updates by generation (412 on conflict).
//
// Run: node tests/sync15.test.mjs

import http from 'node:http';
import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'extension', 'background.js'), 'utf8');

const sha = b => createHash('sha256').update(b).digest('hex');

// Bitwise CRC-32C, independent of the table version under test
function crc32cRef(buf) {
  let crc = 0xFFFFFFFF;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0x82F63B78 & -(crc & 1));
  }
  crc = (crc ^ 0xFFFFFFFF) >>> 0;
  const b = Buffer.alloc(4); b.writeUInt32BE(crc);
  return b.toString('base64');
}
assert.equal(Buffer.from(crc32cRef(Buffer.from('123456789')), 'base64').readUInt32BE(), 0xE3069283);

// ---------------------------------------------------------------- mock cloud
function makeCloud() {
  const cloud = {
    blobs: new Map(), // hash -> Buffer
    root: { hash: '', generation: 0 },
    code: 'abcd1234',
    deviceTokens: new Set(),
    userTokens: new Set(),
    log: [],
    hooks: {} // test hooks
  };

  function parseLines(text) {
    return text.split('\n').filter(Boolean);
  }

  function validateDocIndex(buf, hash) {
    const lines = parseLines(buf.toString());
    assert.equal(lines[0], '3', 'doc index must be schema 3');
    const files = lines.slice(1).map(l => l.split(':'));
    const ids = files.map(f => f[2]);
    assert.deepEqual(ids, [...ids].sort(), 'doc index must be sorted by id');
    for (const f of files) {
      assert.equal(f.length, 5);
      assert.equal(f[1], '0');
      assert.ok(cloud.blobs.has(f[0]), `file blob ${f[2]} must exist`);
      assert.equal(Number(f[4]), cloud.blobs.get(f[0]).length, 'file size');
    }
    const raw = Buffer.concat(files.map(f => Buffer.from(f[0], 'hex')));
    assert.equal(sha(raw), hash, 'doc hash = sha256(concat sorted file hashes)');
  }

  function validateRootIndex(buf) {
    const lines = parseLines(buf.toString());
    assert.equal(lines[0], '4', 'root index must be schema 4');
    const [z, dot, count, total] = lines[1].split(':');
    assert.equal(z, '0'); assert.equal(dot, '.');
    const entries = lines.slice(2).map(l => l.split(':'));
    assert.equal(Number(count), entries.length, 'root entry count');
    assert.equal(Number(total), entries.reduce((s, e) => s + Number(e[4]), 0), 'root total size');
    const ids = entries.map(e => e[2]);
    assert.deepEqual(ids, [...ids].sort(), 'invalid root schema: root must be sorted by id');
    for (const e of entries) {
      assert.equal(e[1], '0');
      assert.ok(cloud.blobs.has(e[0]), `doc index ${e[2]} must exist`);
      const docLines = parseLines(cloud.blobs.get(e[0]).toString()).slice(1);
      assert.equal(Number(e[3]), docLines.length, `subfiles for ${e[2]}`);
    }
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const auth = req.headers.authorization || '';
      const send = (status, data, type = 'text/plain') => {
        res.writeHead(status, { 'content-type': type });
        res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
      };
      cloud.log.push(`${req.method} ${url.pathname}`);
      try {
        if (url.pathname === '/token/json/2/device/new' && req.method === 'POST') {
          assert.equal(auth, 'Bearer');
          const j = JSON.parse(body.toString());
          assert.ok(j.deviceDesc && j.deviceID, 'deviceDesc and deviceID required');
          if (j.code !== cloud.code) return send(400, 'Invalid One-time-code\n');
          const tok = 'device-' + j.deviceID;
          cloud.deviceTokens.add(tok);
          return send(200, tok);
        }
        if (url.pathname === '/token/json/2/user/new' && req.method === 'POST') {
          const tok = auth.replace(/^Bearer /, '');
          if (!cloud.deviceTokens.has(tok)) return send(401, 'invalid device token');
          const payload = { exp: Math.floor(Date.now() / 1000) + 3600, 'auth0-profile': { Email: 'reader@example.com' } };
          const jwt = ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig' + cloud.userTokens.size].join('.');
          cloud.userTokens.add(jwt);
          return send(200, jwt);
        }

        // Everything below needs a user token
        const ut = auth.replace(/^Bearer /, '');
        if (!cloud.userTokens.has(ut)) return send(401, 'unauthorized');

        if (url.pathname === '/sync/v4/root' && req.method === 'GET') {
          if (!cloud.root.hash) return send(404, '{"message":"root not found"}', 'application/json');
          return send(200, { hash: cloud.root.hash, generation: cloud.root.generation, schemaVersion: 4 }, 'application/json');
        }
        if (url.pathname === '/sync/v3/root' && req.method === 'PUT') {
          assert.equal(req.headers['rm-filename'], 'roothash');
          assert.equal(req.headers['x-goog-hash'], 'crc32c=' + crc32cRef(body));
          const j = JSON.parse(body.toString());
          if (cloud.hooks.beforeRootPut) cloud.hooks.beforeRootPut(j);
          if (j.generation !== cloud.root.generation) return send(412, 'wrong generation');
          assert.ok(cloud.blobs.has(j.hash), 'root blob must exist');
          validateRootIndex(cloud.blobs.get(j.hash));
          cloud.root = { hash: j.hash, generation: cloud.root.generation + 1 };
          cloud.lastBroadcast = j.broadcast;
          return send(200, { hash: cloud.root.hash, generation: cloud.root.generation }, 'application/json');
        }
        const m = url.pathname.match(/^\/sync\/v3\/files\/([0-9a-f]{64})$/);
        if (m && req.method === 'GET') {
          assert.ok(req.headers['rm-filename'], 'rm-filename header on GET');
          if (!cloud.blobs.has(m[1])) return send(404, 'not found');
          return send(200, cloud.blobs.get(m[1]), 'application/octet-stream');
        }
        if (m && req.method === 'PUT') {
          const name = req.headers['rm-filename'];
          assert.ok(name, 'rm-filename header on PUT');
          assert.equal(req.headers['x-goog-hash'], 'crc32c=' + crc32cRef(body), 'crc32c');
          const isDocIndex = name.endsWith('.docSchema') && name !== 'root.docSchema';
          if (isDocIndex) {
            // v3 document index: addressed by sha256(concat of sorted file hashes)
            validateDocIndex(body, m[1]);
          } else {
            assert.equal(sha(body), m[1], `blob hash = sha256(body) for ${name}`);
          }
          if (name === 'root.docSchema') assert.match(req.headers['content-type'], /^text\/plain/);
          cloud.blobs.set(m[1], body);
          return send(200, '');
        }
        return send(404, 'no route');
      } catch (e) {
        cloud.errors = (cloud.errors || []).concat(e.message);
        return send(400, '{"message":"' + e.message.replace(/"/g, "'") + '"}', 'application/json');
      }
    });
  });

  // Helpers to seed a library the way the tablet would have written it
  cloud.put = buf => { const h = sha(buf); cloud.blobs.set(h, buf); return h; };
  cloud.seedDoc = (id, meta, schema = '4') => {
    const files = [
      { id: `${id}.metadata`, buf: Buffer.from(JSON.stringify(meta)) },
      { id: `${id}.content`, buf: Buffer.from('{}') }
    ].sort((a, b) => (a.id < b.id ? -1 : 1));
    const lines = files.map(f => `${cloud.put(f.buf)}:0:${f.id}:0:${f.buf.length}`);
    const docHash = sha(Buffer.concat(files.map(f => Buffer.from(sha(f.buf), 'hex'))));
    cloud.blobs.set(docHash, Buffer.from(`3\n${lines.join('\n')}\n`));
    return { hash: docHash, id, subfiles: files.length, size: files.reduce((s, f) => s + f.buf.length, 0), schema };
  };
  cloud.setRoot = (entries, schema = '4') => {
    entries = [...entries].sort((a, b) => (a.id < b.id ? -1 : 1));
    let text;
    if (schema === '4') {
      text = `4\n0:.:${entries.length}:${entries.reduce((s, e) => s + e.size, 0)}\n` +
        entries.map(e => `${e.hash}:0:${e.id}:${e.subfiles}:${e.size}\n`).join('');
    } else {
      // v3 root: type 80000000, subfiles field not populated
      text = '3\n' + entries.map(e => `${e.hash}:80000000:${e.id}:0:${e.size}\n`).join('');
    }
    cloud.root = { hash: cloud.put(Buffer.from(text)), generation: cloud.root.generation + 1 };
  };
  cloud.rootEntries = () => {
    const lines = cloud.blobs.get(cloud.root.hash).toString().split('\n').filter(Boolean).slice(2);
    return lines.map(l => { const f = l.split(':'); return { hash: f[0], id: f[2], subfiles: +f[3], size: +f[4] }; });
  };
  cloud.docFiles = entry => {
    const lines = cloud.blobs.get(entry.hash).toString().split('\n').filter(Boolean).slice(1);
    return Object.fromEntries(lines.map(l => { const f = l.split(':'); return [f[2], cloud.blobs.get(f[0])]; }));
  };
  return { cloud, server };
}

// ------------------------------------------------ extension runtime sandbox
function loadExtension(port, storageData) {
  let listener = null;
  const storage = {
    async get(keys) { return Object.fromEntries(keys.filter(k => k in storageData).map(k => [k, structuredClone(storageData[k])])); },
    async set(obj) { Object.assign(storageData, structuredClone(obj)); },
    async remove(keys) { for (const k of keys) delete storageData[k]; }
  };
  const browser = {
    storage: { local: storage },
    runtime: { onMessage: { addListener(fn) { listener = fn; } } }
  };
  const rewrite = url => String(url)
    .replace('https://webapp-prod.cloud.remarkable.engineering', `http://127.0.0.1:${port}`)
    .replace('https://internal.cloud.remarkable.com', `http://127.0.0.1:${port}`);
  const context = vm.createContext({
    browser, console: { log() {}, info() {}, warn() {}, error() {} },
    fetch: (url, opts) => {
      assert.ok(/^https:\/\/(webapp-prod\.cloud\.remarkable\.engineering|internal\.cloud\.remarkable\.com)\//.test(url),
        `unexpected host: ${url}`);
      // Bodies come from the sandbox realm; hand undici same-realm bytes
      if (opts && opts.body && ArrayBuffer.isView(opts.body)) {
        opts = { ...opts, body: Buffer.from(opts.body.buffer, opts.body.byteOffset, opts.body.byteLength) };
      }
      return fetch(rewrite(url), opts);
    },
    crypto: webcrypto, TextEncoder, TextDecoder, Blob, atob, btoa, URL, setTimeout, structuredClone
  });
  vm.runInContext(source, context, { filename: 'background.js' });
  // JSON round-trip: like Safari's message passing, and yields same-realm objects
  const send = request => new Promise(resolve =>
    listener(JSON.parse(JSON.stringify(request)), {}, r => resolve(JSON.parse(JSON.stringify(r)))));
  return { send };
}

// --------------------------------------------------------------------- tests
const { cloud, server } = makeCloud();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const FOLDER = '11111111-1111-4111-8111-111111111111';
const SUB = '22222222-2222-4222-8222-222222222222';
const TRASHED = '33333333-3333-4333-8333-333333333333';
const DELETED = '44444444-4444-4444-8444-444444444444';
const EXISTING_DOC = '55555555-5555-4555-8555-555555555555';
const seed = [
  cloud.seedDoc(FOLDER, { visibleName: 'Articles', type: 'CollectionType', parent: '' }),
  cloud.seedDoc(SUB, { visibleName: 'Longreads', type: 'CollectionType', parent: FOLDER }),
  cloud.seedDoc(TRASHED, { visibleName: 'Old', type: 'CollectionType', parent: 'trash' }),
  cloud.seedDoc(DELETED, { visibleName: 'Gone', type: 'CollectionType', parent: '', deleted: true }),
  cloud.seedDoc(EXISTING_DOC, { visibleName: 'Notes', type: 'DocumentType', parent: FOLDER })
];
cloud.setRoot(seed);

const storageData = {};
let ext = loadExtension(port, storageData);
let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack}`); }
}

await test('not connected before pairing', async () => {
  const r = await ext.send({ action: 'checkAuth' });
  assert.equal(r.isAuthenticated, false);
});

await test('pairing rejects a wrong one-time code', async () => {
  const r = await ext.send({ action: 'authenticate', code: 'wrong123' });
  assert.equal(r.success, false);
  assert.match(r.error, /Invalid One-time-code/);
});

await test('pairing with a valid code returns folders (paths, no trash/deleted)', async () => {
  const r = await ext.send({ action: 'authenticate', code: ' abcd1234 ' });
  assert.equal(r.success, true, r.error);
  assert.deepEqual(r.folders.map(f => [f.id, f.name]), [[FOLDER, 'Articles'], [SUB, 'Articles/Longreads']]);
  const c = await ext.send({ action: 'checkAuth' });
  assert.equal(c.isAuthenticated, true);
  assert.equal(c.email, 'reader@example.com');
});

await test('PDF upload lands in the chosen folder and keeps existing docs', async () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const gen = cloud.root.generation;
  const r = await ext.send({ action: 'uploadFile', name: 'Paper', folderId: SUB, fileType: 'pdf', dataBase64: pdf.toString('base64') });
  assert.equal(r.success, true, r.error || cloud.errors);
  assert.equal(cloud.root.generation, gen + 1);
  assert.equal(cloud.lastBroadcast, true);
  const entries = cloud.rootEntries();
  assert.equal(entries.length, seed.length + 1);
  for (const s of seed) assert.ok(entries.find(e => e.id === s.id && e.hash === s.hash), 'existing doc preserved');
  const e = entries.find(x => x.id === r.documentId);
  const files = cloud.docFiles(e);
  assert.deepEqual(files[`${e.id}.pdf`], pdf);
  const meta = JSON.parse(files[`${e.id}.metadata`]);
  assert.equal(meta.visibleName, 'Paper');
  assert.equal(meta.parent, SUB);
  assert.equal(meta.type, 'DocumentType');
  assert.equal(JSON.parse(files[`${e.id}.content`]).fileType, 'pdf');
});

await test('article (EPUB) upload via sendToRemarkable', async () => {
  const article = { title: 'Hello <World>', byline: 'Me', url: 'https://example.com/a', content: '<p>Body</p>' };
  const r = await ext.send({ action: 'sendToRemarkable', article, options: { folderId: FOLDER } });
  assert.equal(r.success, true, r.error || cloud.errors);
  const e = cloud.rootEntries().find(x => x.id === r.documentId);
  const files = cloud.docFiles(e);
  const epub = files[`${e.id}.epub`];
  assert.equal(epub.subarray(0, 2).toString(), 'PK');
  assert.equal(epub.subarray(30, 38).toString(), 'mimetype');
  assert.equal(JSON.parse(files[`${e.id}.metadata`]).parent, FOLDER);
  assert.equal(JSON.parse(files[`${e.id}.content`]).fileType, 'epub');
});

await test('retries when the tablet changes the root mid-upload (412)', async () => {
  let fired = false;
  const tabletDoc = cloud.seedDoc('66666666-6666-4666-8666-666666666666', { visibleName: 'From tablet', type: 'DocumentType', parent: '' });
  cloud.hooks.beforeRootPut = () => {
    if (fired) return;
    fired = true;
    cloud.setRoot([...cloud.rootEntries(), tabletDoc]); // bumps generation
  };
  const r = await ext.send({ action: 'uploadFile', name: 'Race', fileType: 'pdf', dataBase64: Buffer.from('%PDF-1.4 race').toString('base64') });
  cloud.hooks.beforeRootPut = null;
  assert.equal(r.success, true, r.error || cloud.errors);
  assert.ok(fired);
  const ids = cloud.rootEntries().map(e => e.id);
  assert.ok(ids.includes(tabletDoc.id), 'concurrent tablet change preserved');
  assert.ok(ids.includes(r.documentId));
});

await test('expired/revoked user token is refreshed transparently', async () => {
  cloud.userTokens.clear();
  const r = await ext.send({ action: 'getFolders' });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.folders.length, 2);
});

await test('service worker restart keeps the session', async () => {
  ext = loadExtension(port, storageData);
  const c = await ext.send({ action: 'checkAuth' });
  assert.equal(c.isAuthenticated, true);
  const r = await ext.send({ action: 'uploadFile', name: 'After restart', fileType: 'pdf', dataBase64: Buffer.from('%PDF-1.4 x').toString('base64') });
  assert.equal(r.success, true, r.error);
});

await test('v3 root is rewritten as a valid v4 root with real file counts', async () => {
  cloud.setRoot(seed, '3');
  delete storageData.rm_doc_cache;
  const r = await ext.send({ action: 'uploadFile', name: 'V3', fileType: 'pdf', dataBase64: Buffer.from('%PDF-1.4 v3').toString('base64') });
  assert.equal(r.success, true, r.error || cloud.errors);
  const entries = cloud.rootEntries();
  assert.equal(entries.length, seed.length + 1);
  assert.ok(entries.filter(e => e.id !== r.documentId).every(e => e.subfiles === 2));
});

await test('empty cloud (no root yet)', async () => {
  cloud.root = { hash: '', generation: 0 };
  const f = await ext.send({ action: 'getFolders' });
  assert.deepEqual(f.folders, []);
  const r = await ext.send({ action: 'uploadFile', name: 'First', fileType: 'pdf', dataBase64: Buffer.from('%PDF-1.4 1').toString('base64') });
  assert.equal(r.success, true, r.error || cloud.errors);
  assert.equal(cloud.rootEntries().length, 1);
});

await test('revoked device token clears the session', async () => {
  cloud.deviceTokens.clear();
  cloud.userTokens.clear();
  const r = await ext.send({ action: 'uploadFile', name: 'X', fileType: 'pdf', dataBase64: Buffer.from('%PDF').toString('base64') });
  assert.equal(r.success, false);
  assert.match(r.error, /connect again/);
  const c = await ext.send({ action: 'checkAuth' });
  assert.equal(c.isAuthenticated, false);
});

await test('mock cloud saw no protocol violations', async () => {
  assert.deepEqual(cloud.errors || [], []);
});

server.close();
console.log(failures ? `\n${failures} test(s) failed` : '\nall tests passed');
process.exit(failures ? 1 : 0);
