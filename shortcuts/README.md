# Shortcuts: send the current page to the reMarkable

Every route ends in the same renderer, `email-pipeline/send.py` with
`email-pipeline/assets/style.css`, so a page looks identical on the tablet
however you sent it.

| From | How | Speed |
|---|---|---|
| Mac Safari | **Send to reMarkable** Shortcut: renders on your Mac and uploads with `rmapi` | Seconds |
| Email | Mail a link (or forward a newsletter) to remarkable@marcovanderwerf.nl | Up to an hour |
| iPhone / iPad | **Send to reMarkable** Shortcut: emails the link to that address | Up to an hour |

The Mac Shortcut sends the page **as Safari has it loaded**, logins and
subscriptions included, so paywalled sites you subscribe to work. The iOS
Shortcut and email send only the link, which the pipeline fetches itself. For
pages it can't load (paywalls, logins) you get a reply asking you to forward
the full text instead.

## Mac

### One-time setup

1. Clone this repo (the build instructions use `~/Others/Coding/remarkable_for_safari`).
2. Install the renderer's dependencies:
   `python3 -m pip install weasyprint trafilatura beautifulsoup4 markdown requests pypdf`
   (WeasyPrint also needs `brew install pango`).
3. Install [rmapi](https://github.com/ddvk/rmapi) (ddvk fork) and log in once
   with `rmapi ls`. If your Mac pipelines already use rmapi, this is done.
4. Make the script executable:
   `chmod +x ~/Others/Coding/remarkable_for_safari/shortcuts/send-from-safari.sh`
5. Test it from Terminal without uploading:
   ```bash
   printf '{"url":"https://example.com/","html":"<html><head><title>Test</title></head><body><article><p>Hello from the Mac.</p></article></body></html>"}' | RM_NO_UPLOAD=1 ~/Others/Coding/remarkable_for_safari/shortcuts/send-from-safari.sh
   ```
   It should print `Rendered 'Test' …` and leave `reMarkable-test.pdf` on your
   Desktop. Without `RM_NO_UPLOAD=1` it uploads and prints
   `✓ Sent '…' → /Articles`. If the Python with the
   dependencies isn't the first `python3` on your PATH, set
   `RM_PYTHON=/path/to/python3` in the Shortcut's shell script line.

### Build the Shortcut

In the Shortcuts app, create a new Shortcut named **Send to reMarkable**:

1. Open the Shortcut's details (ⓘ) and turn on **Show in Share Sheet** and
   **Use as Quick Action** (Services Menu). Set *Receive* to **Safari web pages**.
2. Add **Run JavaScript on Web Page** with:
   ```js
   (async () => {
     try {
       if (document.contentType === 'application/pdf') {
         // A PDF open in Safari: send the file itself (with Safari's cookies)
         const r = await fetch(location.href, { credentials: 'include' });
         const b = new Uint8Array(await r.arrayBuffer());
         let s = '';
         for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
         completion(JSON.stringify({ url: location.href, title: document.title, pdf: btoa(s) }));
       } else {
         completion(JSON.stringify({ url: location.href, html: document.documentElement.outerHTML }));
       }
     } catch (e) {
       completion(JSON.stringify({ url: location.href, error: String(e) }));
     }
   })();
   ```
   Web pages are rendered into the reMarkable PDF style. PDFs (papers,
   reports) are sent as they are, like PDFs attached to an email.
3. Add **Run Shell Script**:
   - Shell: `bash`, Input: *JavaScript result*, Pass Input: **to stdin**
   - Script: `~/Others/Coding/remarkable_for_safari/shortcuts/send-from-safari.sh`
4. Add **Show Notification** with the *Shell Script Result*.

Then:
- In Shortcuts → Settings → Advanced, turn on **Allow Running Scripts**.
- The first run asks for permission to run JavaScript on the site; allow it.
- For a keyboard shortcut: in the Shortcut's details, **Add Keyboard
  Shortcut** (for example ⌃⌥⌘R), or System Settings → Keyboard → Keyboard
  Shortcuts → Services.

To send to another folder, put it after the script path, for example
`… send-from-safari.sh "/Articles/Longreads"`. The folder is created if needed.

## iPhone / iPad

Create a Shortcut named **Send to reMarkable**:

1. Details (ⓘ): **Show in Share Sheet**, *Receive* **Safari web pages** and **URLs**.
2. Add **Get Details of Safari Web Page** → *Page URL*. (When shared from
   another app the input is already a URL; Shortcuts passes it through.)
3. Add **Get Details of Safari Web Page** → *Name*.
4. Add **Send Email**:
   - To: remarkable@marcovanderwerf.nl
   - Subject: *Name*
   - Body: *Page URL* (nothing else)
   - Turn off **Show Compose Sheet** so it sends straight away.

The pipeline treats a mail whose body is just a link as "render this URL" and
uses the subject as the title. The PDF appears in /Articles after the next
hourly run.
