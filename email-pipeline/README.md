# Email → reMarkable

Email a link, a newsletter or a PDF to **remarkable@marcovanderwerf.nl**. About
two minutes later it's in **/Articles** on the reMarkable as a clean e-ink PDF.
It uses the same look as the FT and Prof G pipelines: Literata or Iowan serif,
a title with author · publication · date, a lead photo, and charts with their
captions.

```
Gmail ──(Apps Script, every minute)──▶ private GitHub repo: inbox/<id>.json
                                          │ push triggers
                                          ▼
                     GitHub Action: send.py renders → rmapi uploads → /Articles
```

## What you can send

| You send | You get |
|---|---|
| A link: Share → Mail, or paste it, with a short note if you like | The article from the web page |
| A forwarded newsletter or article email | The email itself, laid out as an article |
| A PDF attachment | That PDF, unchanged |
| A Medium link | The full post, read from Medium's RSS feed (Medium blocks page scraping) |

If a page can't be read (a paywall, a bot check, or an empty page), the email is
set aside in `inbox/failed/` and GitHub emails you that the run failed. Forward
the newsletter email itself instead of the link.

## Setup (once, about 10 minutes)

1. **Private repo.** Create an empty **private** GitHub repository, for example
   `remarkable-mailroom`.
2. **reMarkable token.** In that repo, go to *Settings → Secrets and variables →
   Actions → New repository secret* and add the name `RMAPI_DEVICE_TOKEN`. For
   the value, use what comes after `devicetoken:` in `~/.rmapi` (or
   `~/.config/rmapi/rmapi.conf`) on the Mac.
3. **GitHub token for Gmail.** Go to github.com → Settings → Developer settings →
   *Fine-grained tokens → Generate*.
   - Repository access: **Only select repositories** → `remarkable-mailroom`.
   - Permissions: **Contents: Read and write** and **Workflows: Read and write**.
   - Set an expiry you're comfortable with; you'll repeat this step when it
     expires.
4. **Gmail script.** Go to [script.google.com](https://script.google.com),
   signed in as `mail@marcovanderwerf.nl`, and click *New project*.
   - Replace the code with [`apps-script/Code.gs`](apps-script/Code.gs).
   - Under ⚙ *Project Settings → Script properties*, add
     `GITHUB_TOKEN` = the token from step 3 and
     `GITHUB_REPO` = `marcovanderwerf/remarkable-mailroom`.
   - Back in the editor, pick **install** in the function menu and click
     **Run**. Approve the Gmail and external-request permissions.

`install()` checks that the repo is private, adds the GitHub Action to it, and
starts the one-minute check. To test it, email a link to `remarkable@`.

## Files

| File | What it does |
|---|---|
| `send.py` | Renders a URL, HTML, Markdown or text to a reMarkable PDF; `--no-upload` to only render |
| `assets/style.css` | The e-ink stylesheet (shared with the Mac pipelines) |
| `process_inbox.py` | Turns `inbox/*.json` into PDFs, checks them, uploads them with rmapi |
| `mailroom.yml` | The GitHub Action that `install()` puts in the private repo |
| `apps-script/Code.gs` | The Gmail side |
| `setup.sh` | Prepares a Claude cloud session to run `send.py` and `rmapi` by hand |

## When something goes wrong

- **No PDF after 5 minutes.** Open the private repo's *Actions* tab. A red run
  shows which email failed and why.
- **"rmapi upload failed" / HTTP 400 or 429.** reMarkable's cloud sometimes has
  hiccups. Re-run the job, or move the JSON from `inbox/failed/` back to
  `inbox/`.
- **Gmail script errors.** In script.google.com → *Executions*, the error says
  whether the token, repo name or permissions are wrong.
- **Pausing it.** In script.google.com → *Triggers*, delete the `checkInbox`
  trigger.
