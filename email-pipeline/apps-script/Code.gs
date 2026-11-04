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
const QUEUED = 'reMarkable/queued';
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

  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkInbox').timeBased().everyMinutes(1).create();
  console.log(`Installed. Mail to ${ADDRESS} now goes to the reMarkable within ~2 minutes.`);
  checkInbox();
}

/** Runs every minute. */
function checkInbox() {
  const label = GmailApp.getUserLabelByName(QUEUED) || GmailApp.createLabel(QUEUED);
  const query = `to:${ADDRESS} -label:${QUEUED.replace(/\//g, '-')} newer_than:3d`;
  GmailApp.search(query, 0, 10).forEach(thread => {
    const msgs = thread.getMessages();
    const msg = msgs.filter(m => (m.getTo() + ',' + m.getCc()).toLowerCase().includes(ADDRESS)).pop()
             || msgs[msgs.length - 1];
    const item = toItem_(msg);
    putFile_(`inbox/${item.id}.json`, JSON.stringify(item),
             'Queue ' + (item.url ? 'link' : item.html ? 'article' : 'PDF'));
    thread.addLabel(label);
    thread.markRead();
    console.log('Queued: ' + item.subject);
  });
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
