/**
 * Gmail → reMarkable mailroom
 * ---------------------------
 * Email a link (or forward a newsletter / PDF) to remarkable@marcovanderwerf.nl.
 * Every minute this script queues new mail as inbox/<id>.json in your PRIVATE
 * GitHub repo. That push starts the "Send to reMarkable" Action, which renders
 * an e-ink PDF and uploads it to /Articles on the tablet.
 *
 * One-time setup (Project Settings → Script properties):
 *   GITHUB_TOKEN  fine-grained token for the mailroom repo only, with
 *                 Contents: Read and write  +  Workflows: Read and write
 *   GITHUB_REPO   e.g. marcovanderwerf/remarkable-mailroom
 * Then choose install() in the toolbar and click Run.
 */
const ADDRESS = 'remarkable@marcovanderwerf.nl';
// Labels. Pending → sent (archived) or failed (stays in the inbox).
const L = {
  pending: 'reMarkable/pending',
  sent: 'reMarkable/sent',
  failed: 'reMarkable/failed',
  skipped: 'reMarkable/skipped',
  legacy: 'reMarkable/queued',   // from the first version; left alone
};
const CODE_REPO = 'marcovanderwerf/remarkable_for_safari';
const CODE_REF = 'claude/safari-web-clipper-support-CFTtv';
const WORKFLOW_PATH = '.github/workflows/remarkable.yml';

/** Run once. Safe to run again (e.g. after changing settings). */
function install() {
  const { repo } = settings_();
  const me = github_('GET', `/repos/${repo}`);
  if (!me.private) throw new Error(`${repo} is public. Make it private first: your emails go there.`);

  // Install / update the workflow from the public code repo.
  const yml = UrlFetchApp.fetch(
    `https://raw.githubusercontent.com/${CODE_REPO}/${encodeURIComponent(CODE_REF).replace(/%2F/g, '/')}/email-pipeline/mailroom.yml`
  ).getContentText().replace('__CODE_REF__', CODE_REF);
  putFile_(WORKFLOW_PATH, yml, 'Install reMarkable workflow');

  // Only mail that arrives from now on: never sweep up older messages.
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SINCE')) props.setProperty('SINCE', new Date().toISOString());

  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkInbox').timeBased().everyMinutes(1).create();
  console.log(`Installed. Mail to ${ADDRESS} now goes to the reMarkable within ~2 minutes.`);
  checkInbox();
}

/** Runs every minute: queue new mail, then settle finished mail. */
function checkInbox() {
  queueNew_();
  settleFinished_();
}

function label_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function queueNew_() {
  const seen = Object.values(L).map(n => '-label:' + n.replace(/\//g, '-')).join(' ');
  const since = new Date(PropertiesService.getScriptProperties().getProperty('SINCE') || Date.now());
  GmailApp.search(`to:${ADDRESS} ${seen} newer_than:3d`, 0, 10).forEach(thread => {
    // Only messages really addressed to remarkable@ (To/Cc/Bcc), sent after
    // install, and not Google's own account mail.
    const msg = thread.getMessages().filter(m =>
      [m.getTo(), m.getCc(), m.getBcc()].join(',').toLowerCase().includes(ADDRESS) &&
      m.getDate() > since &&
      !/@(google|accounts\.google)\.com>?$/i.test(m.getFrom())
    ).pop();
    if (!msg) { thread.addLabel(label_(L.skipped)); return; }   // not for us
    const item = toItem_(msg);
    putFile_(`inbox/${item.id}.json`, JSON.stringify(item),
             'Queue ' + (item.url ? 'link' : item.html ? 'article' : 'PDF'));
    thread.addLabel(label_(L.pending));
    thread.markRead();
    console.log('Queued: ' + item.subject);
  });
}

/** The Action deletes inbox/<id>.json after a successful upload and moves
 *  it to inbox/failed/ when it can't make a proper PDF. */
function settleFinished_() {
  const pending = GmailApp.search(`label:${L.pending.replace(/\//g, '-')}`, 0, 20);
  if (!pending.length) return;
  const waiting = listIds_('inbox'), failed = listIds_('inbox/failed');
  pending.forEach(thread => {
    const ids = thread.getMessages().map(m => m.getId());
    if (ids.some(id => waiting.has(id))) return;               // still being processed
    thread.removeLabel(label_(L.pending));
    if (ids.some(id => failed.has(id))) {
      thread.addLabel(label_(L.failed));                       // keep it in view
      thread.markUnread();
      console.log('Failed: ' + thread.getFirstMessageSubject());
    } else {
      thread.addLabel(label_(L.sent));
      thread.moveToArchive();
      console.log('On the reMarkable, archived: ' + thread.getFirstMessageSubject());
    }
  });
}

function listIds_(dir) {
  const { repo } = settings_();
  let files;
  try { files = github_('GET', `/repos/${repo}/contents/${dir}`); }
  catch (e) { if (/GitHub 404/.test(e.message)) return new Set(); throw e; }
  return new Set((Array.isArray(files) ? files : [])
    .filter(f => f.type === 'file' && f.name.endsWith('.json'))
    .map(f => f.name.slice(0, -5)));
}

/** What to render: a link, the email itself, and/or attached PDFs. */
function toItem_(msg) {
  const text = msg.getPlainBody() || '';
  const urls = (text.match(/https?:\/\/[^\s<>"'()\]]+/g) || [])
    .map(u => u.replace(/[.,;:!?]+$/, ''))
    .filter(u => !/unsubscribe|list-manage|mailchi\.mp|\/maps\b|apple\.com\/.*(iphone|mail)/i.test(u));
  // Words other than links and a typical "Sent from my iPhone" signature.
  const words = text.replace(/https?:\/\/\S+/g, '')
    .replace(/(Sent from|Verzonden (vanaf|met)|Get Outlook)[^\n]*/gi, '')
    .split(/\s+/).filter(Boolean).length;
  const item = {
    id: msg.getId(),
    subject: msg.getSubject() || '',
    from: msg.getFrom(),
    date: msg.getDate().toISOString(),
  };
  const pdfs = msg.getAttachments({ includeInlineImages: false })
    .filter(a => a.getContentType() === 'application/pdf' || /\.pdf$/i.test(a.getName()));
  if (pdfs.length) {
    item.pdfs = pdfs.map(a => ({ name: a.getName(), base64: Utilities.base64Encode(a.getBytes()) }));
  }
  if (urls.length && words < 40) item.url = urls[0];      // shared link
  else if (words >= (pdfs.length ? 150 : 40)) {            // forwarded article / newsletter
    item.html = msg.getBody();                             // (a PDF with a short note: just the PDF)
  }
  return item;
}

function putFile_(path, content, message) {
  const { repo } = settings_();
  let sha;
  try { sha = github_('GET', `/repos/${repo}/contents/${path}`).sha; } catch (e) { /* new file */ }
  github_('PUT', `/repos/${repo}/contents/${path}`, {
    message, sha,
    content: Utilities.base64Encode(content, Utilities.Charset.UTF_8),
  });
}

function github_(method, path, body) {
  const { token } = settings_();
  const res = UrlFetchApp.fetch('https://api.github.com' + path, {
    method, muteHttpExceptions: true, contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
               'X-GitHub-Api-Version': '2022-11-28' },
    payload: body ? JSON.stringify(body) : undefined,
  });
  const code = res.getResponseCode();
  if (code >= 300) {
    const hint = { 401: 'GITHUB_TOKEN is wrong or expired.',
                   403: 'GITHUB_TOKEN lacks Contents/Workflows write access to the repo.',
                   404: 'Repo not found, or the token has no access to it.' }[code] || '';
    throw new Error(`GitHub ${code} on ${method} ${path}. ${hint}`);
  }
  return JSON.parse(res.getContentText() || '{}');
}

function settings_() {
  const p = PropertiesService.getScriptProperties();
  const token = p.getProperty('GITHUB_TOKEN'), repo = p.getProperty('GITHUB_REPO');
  if (!token || !repo) throw new Error('Set GITHUB_TOKEN and GITHUB_REPO under Project Settings → Script properties.');
  return { token, repo: repo.replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '') };
}
