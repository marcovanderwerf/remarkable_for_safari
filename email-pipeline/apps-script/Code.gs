/**
 * Gmail → reMarkable mailroom.
 * Every minute: finds new mail to remarkable@marcovanderwerf.nl and drops it
 * as inbox/<id>.json into the private GitHub repo, which triggers the
 * "Send to reMarkable" Action. Then labels the thread "reMarkable/queued".
 *
 * Setup: Project Settings → Script properties:
 *   GITHUB_TOKEN = fine-grained token, Contents: read & write on the repo
 *   GITHUB_REPO  = marcovanderwerf/remarkable-mailroom
 * Then run install() once and approve the permissions.
 */
const ADDRESS = 'remarkable@marcovanderwerf.nl';
const LABEL = 'reMarkable/queued';

function install() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkInbox').timeBased().everyMinutes(1).create();
  checkInbox();
}

function checkInbox() {
  const label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  const threads = GmailApp.search(`to:${ADDRESS} -label:${LABEL.replace('/', '-')} newer_than:2d`, 0, 10);
  threads.forEach(thread => {
    const msg = thread.getMessages().filter(m => m.getTo().concat(m.getCc()).includes(ADDRESS)).pop()
             || thread.getMessages().pop();
    pushToGitHub(toItem(msg));
    thread.addLabel(label);
    thread.markRead();
  });
}

function toItem(msg) {
  const text = msg.getPlainBody() || '';
  const urls = (text.match(/https?:\/\/[^\s<>"')\]]+/g) || [])
    .filter(u => !/unsubscribe|list-manage|mailchi\.mp|google\.com\/maps/i.test(u));
  // "Basically a link": short body with a URL in it → render the web page.
  const words = text.replace(/https?:\/\/\S+/g, '').split(/\s+/).filter(Boolean).length;
  const item = {
    id: msg.getId(), subject: msg.getSubject(), from: msg.getFrom(),
    date: msg.getDate().toISOString(),
  };
  if (urls.length && words < 40) item.url = urls[0];
  else item.html = msg.getBody();
  const pdfs = msg.getAttachments().filter(a => a.getContentType() === 'application/pdf');
  if (pdfs.length) item.pdfs = pdfs.map(a => ({
    name: a.getName(), base64: Utilities.base64Encode(a.getBytes()) }));
  return item;
}

function pushToGitHub(item) {
  const props = PropertiesService.getScriptProperties();
  const repo = props.getProperty('GITHUB_REPO');
  const res = UrlFetchApp.fetch(
    `https://api.github.com/repos/${repo}/contents/inbox/${item.id}.json`, {
      method: 'put', muteHttpExceptions: true, contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + props.getProperty('GITHUB_TOKEN'),
                 Accept: 'application/vnd.github+json' },
      payload: JSON.stringify({
        message: 'Queue: ' + item.subject.slice(0, 60),
        content: Utilities.base64Encode(JSON.stringify(item), Utilities.Charset.UTF_8),
      }),
    });
  if (res.getResponseCode() >= 300 && res.getResponseCode() !== 422) {
    throw new Error('GitHub ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  }
}
