#!/usr/bin/env python3
"""Send an article, URL, or pasted text to the reMarkable as a clean PDF.

Sources accepted:
  - A URL            → fetch + extract main article (trafilatura)
  - A .md file       → render markdown
  - A .html file     → extract main article
  - A .txt file      → render as plain paragraphs
  - stdin (--stdin)  → treat piped text as markdown

Output: a reMarkable-tuned PDF (A5-ish, 10pt serif, e-ink friendly), uploaded
to /Articles by default. Same rendering as the profg/ft pipelines.

Usage:
  send.py https://example.com/article
  send.py essay.md --title "My Essay"
  send.py --stdin --title "Pasted note" < note.txt
  send.py article.html --folder "/Articles/FT Tech"
  send.py saved-page.html --url https://example.com/article
  send.py --page-json - < page.json        # from the Safari Shortcut
"""
from __future__ import annotations

import argparse
import datetime as dt
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from weasyprint import HTML, CSS

SKILL_DIR = Path(__file__).resolve().parent
STYLE_CSS = SKILL_DIR / "assets" / "style.css"
DEFAULT_FOLDER = "/Articles"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/17.0 Safari/605.1.15")


def slugify(title: str) -> str:
    s = re.sub(r"[^\w\s-]", "", title).strip()
    s = re.sub(r"\s+", " ", s)
    return s[:90] or "article"


def from_url(url: str) -> tuple[str, str]:
    """Return (title, body_html) extracted from a web article."""
    import trafilatura
    downloaded = trafilatura.fetch_url(url)
    if not downloaded:
        # Fallback to requests (some sites block trafilatura's fetcher).
        r = requests.get(url, headers={"User-Agent": UA}, timeout=30)
        if "charset" not in r.headers.get("Content-Type", ""):
            r.encoding = r.apparent_encoding   # avoid â€“ style mojibake
        downloaded = r.text if r.ok else None
    if not downloaded:
        sys.exit(f"Could not fetch {url}")
    return from_page_html(downloaded, url)


def from_page_html(downloaded: str, url: str) -> tuple[str, str]:
    """Return (title, body_html) from a full page's HTML, as loaded from url.

    Used for fetched URLs and for pages captured in the browser (Safari
    Shortcut), so both produce exactly the same PDF.
    """
    import trafilatura
    # Captions: trafilatura drops <figcaption>, so turn each into a marked
    # paragraph right after its image, and restore the caption class after.
    pre = BeautifulSoup(downloaded, "html.parser")
    for cap in pre.find_all("figcaption"):
        txt = cap.get_text(" ", strip=True)
        fig = cap.find_parent("figure")
        if txt and fig:
            para = pre.new_tag("p"); para.string = CAP_MARK + txt
            fig.insert_after(para)
        cap.decompose()
    page_html = downloaded
    downloaded = str(pre)
    # Extract main content as HTML, keeping images + formatting.
    extracted = trafilatura.extract(
        downloaded, output_format="html",
        include_images=True, include_links=False,
        include_comments=False, include_tables=True,
        favor_precision=True,
    )
    # Title + byline metadata.
    md = trafilatura.extract_metadata(page_html)
    title = (md.title if md and md.title else None) or url
    META.update(page_meta(page_html, md, url))
    if extracted:
        post = BeautifulSoup(extracted, "html.parser")
        for para in post.find_all("p"):
            t = para.get_text()
            if t.startswith(CAP_MARK):
                para.string = t[len(CAP_MARK):]
                para["class"] = "caption"
        extracted = str(post)
    if not extracted:
        # Last resort: dump readable text from <article>/<main>.
        soup = BeautifulSoup(downloaded, "html.parser")
        node = soup.select_one("article") or soup.select_one("main") or soup
        extracted = str(node)
    return title, extracted


META: dict = {}
CAP_MARK = "⁣CAPTION⁣ "


def page_meta(html: str, md, url: str) -> dict:
    """Author, publication, date, standfirst and lead image for the header."""
    soup = BeautifulSoup(html, "html.parser")

    def og(*names):
        for n in names:
            t = (soup.find("meta", property=n) or soup.find("meta", attrs={"name": n}))
            if t and t.get("content"):
                return t["content"].strip()
        return None

    date = None
    raw = (md.date if md and md.date else None) or og("article:published_time")
    if raw:
        try:
            date = dt.datetime.fromisoformat(raw[:10]).strftime("%B %-d, %Y")
        except ValueError:
            date = raw
    site = (md.sitename if md and md.sitename else None) or og("og:site_name") \
        or urlparse(url).netloc.removeprefix("www.")
    return {
        "author": (md.author if md and md.author else None) or og("author", "article:author"),
        "site": site,
        "date": date,
        "standfirst": (md.description if md and md.description else None)
                      or og("og:description", "description"),
        "image": og("og:image", "twitter:image"),
        "url": url,
    }


def from_markdown(text: str) -> str:
    import markdown
    return markdown.markdown(text, extensions=["extra"])


def from_text(text: str) -> str:
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]
    return "".join(f"<p>{p}</p>" for p in paras)


def from_html_file(html: str) -> tuple[str, str]:
    soup = BeautifulSoup(html, "html.parser")
    title = (soup.title.string.strip() if soup.title and soup.title.string
             else "Article")
    node = soup.select_one("article") or soup.select_one("main") or soup.body or soup
    return title, str(node)


def clean(html: str) -> str:
    """Strip junk + neutralise publisher CSS overlays. Flatten figures."""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "iframe", "svg", "button",
                     "nav", "footer", "aside", "form"]):
        tag.decompose()
    for sel in [".share", ".social", ".comments", "[class*='comment']",
                "[class*='promo']", "[class*='newsletter']", "[class*='related']",
                "[class*='ad-']", ".o-ads"]:
        for el in soup.select(sel):
            el.decompose()
    for el in soup.find_all(True):
        if el.has_attr("style"):
            del el["style"]
    # Lazy-loaded images: promote data-src / srcset to a real src.
    for img in soup.find_all("img"):
        src = img.get("src", "")
        lazy = img.get("data-src") or img.get("data-original") or img.get("data-lazy-src")
        if lazy and (not src or src.startswith("data:")):
            img["src"] = lazy
        elif (not src or src.startswith("data:")) and (img.get("srcset") or img.get("data-srcset")):
            cands = (img.get("srcset") or img.get("data-srcset")).split(",")
            img["src"] = cands[-1].strip().split(" ")[0]   # largest
        for a in ("srcset", "sizes", "loading", "width", "height"):
            img.attrs.pop(a, None)
        if not img.get("src") or img["src"].startswith("data:"):
            img.decompose()
    # Flatten <figure> → <img> + <p class="caption"> so captions never
    # interleave with body text (lesson learned from the FT pipeline).
    for fig in soup.find_all("figure"):
        img = fig.find("img")
        cap = fig.find("figcaption")
        cap_text = cap.get_text(" ", strip=True) if cap else ""
        repl = []
        if img and img.get("src"):
            new = soup.new_tag("img", src=img["src"])
            repl.append(new)
        if cap_text:
            p = soup.new_tag("p"); p["class"] = "caption"; p.string = cap_text
            repl.append(p)
        for el in repl:
            fig.insert_before(el)
        fig.decompose()
    # Drop empty paragraphs.
    for p in soup.find_all("p"):
        if not p.get_text(strip=True) and not p.find("img"):
            p.decompose()
    return str(soup)


def drop_repeated_title(body_html: str, title: str) -> str:
    """Remove a leading heading that just repeats the title (it's in the header)."""
    soup = BeautifulSoup(body_html, "html.parser")
    h = soup.find(["h1", "h2"])
    norm = lambda t: re.sub(r"\W+", " ", t).strip().lower()
    if h and norm(h.get_text()) == norm(title) and not h.find_previous("p"):
        h.decompose()
    return str(soup)


def render_pdf(title: str, body_html: str, out: Path) -> None:
    from html import escape
    m = META
    date = m.get("date") or dt.datetime.now().strftime("%B %-d, %Y")
    byline = " · ".join(x for x in (m.get("author"), m.get("site"), date) if x)
    head = f'<h1 class="post-title">{escape(title)}</h1>'
    sf = m.get("standfirst")
    body_text = BeautifulSoup(body_html, "html.parser").get_text(" ", strip=True)
    if sf and sf[:60] not in body_text:          # skip if it's just the first paragraph
        head += f'<p class="standfirst">{escape(sf)}</p>'
    head += f'<p class="post-date">{escape(byline)}</p>'
    # Lead photo: only if the body doesn't already open with an image.
    first = BeautifulSoup(body_html, "html.parser").find(["img", "p"])
    if m.get("image") and not (first and first.name == "img"):
        head += f'<img class="lead" src="{escape(m["image"])}">'
    full = f"""<!doctype html><html><head><meta charset="utf-8">
<title>{escape(title)}</title></head><body>
<header>{head}</header>
<article>{body_html}</article></body></html>"""
    css = [CSS(filename=str(STYLE_CSS))] if STYLE_CSS.exists() else []

    def get(url):
        if url.startswith("//"):
            url = "https:" + url
        r = requests.get(url, timeout=20, headers={"User-Agent": UA})
        r.raise_for_status()
        return url, r

    try:  # WeasyPrint >= 68: fetchers are URLFetcher objects
        from weasyprint.urls import URLFetcher, URLFetcherResponse

        class Fetcher(URLFetcher):
            def fetch(self, url, headers=None):
                if not url.startswith(("http:", "https:", "//")):
                    return super().fetch(url, headers)   # data:, file:
                url, r = get(url)
                return URLFetcherResponse(url, r.content, dict(r.headers), r.status_code)

        fetcher = Fetcher()
    except ImportError:  # older WeasyPrint (the Mac pipelines): dict fetchers
        def fetcher(url):
            url, r = get(url)
            return {"mime_type": r.headers.get("Content-Type", "").split(";")[0],
                    "string": r.content}

    HTML(string=full, base_url="", url_fetcher=fetcher).write_pdf(
        str(out), stylesheets=css)


def upload(pdf: Path, folder: str) -> None:
    # ensure folder exists
    if subprocess.run(["rmapi", "-ni", "ls", folder],
                      capture_output=True).returncode != 0:
        subprocess.run(["rmapi", "-ni", "mkdir", folder], capture_output=True)
    r = subprocess.run(["rmapi", "-ni", "put", "--content-only", str(pdf),
                        folder + "/"], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"rmapi upload failed: {r.stderr.strip()}")


def pdf_title(data: bytes, page: dict, url: str) -> str:
    """Best name for a PDF: the PDF's own Title, Safari's title, then the URL."""
    def usable(t: str | None) -> bool:
        return bool(t) and len(t.strip()) >= 3 and not re.search(
            r"\.(pdf|docx?|cgi|php|aspx?)$|^untitled|^microsoft word", t.strip(), re.I)

    try:
        import io
        from pypdf import PdfReader
        t = (PdfReader(io.BytesIO(data)).metadata or {}).get("/Title")
        if usable(t):
            return str(t).strip()
    except Exception:        # pypdf missing or PDF unreadable: try a plain scan
        pass
    m = re.search(rb"/Title\s*\(((?:[^()\\]|\\.){3,200})\)", data[:200_000])
    if m:
        t = m.group(1)
        if t.startswith(b"\xfe\xff"):
            t = t[2:].decode("utf-16-be", "ignore")
        else:
            t = t.decode("latin-1", "ignore")
        t = re.sub(r"\\(.)", r"\1", t).strip()
        if usable(t):
            return t
    t = (page.get("title") or "").strip()
    if usable(t) and t != url:
        return t
    name = urlparse(url).path.rstrip("/").split("/")[-1]
    if usable(name) or name.lower().endswith(".pdf"):
        return re.sub(r"\.pdf$", "", name, flags=re.I)
    return f"{urlparse(url).netloc.removeprefix('www.')} {dt.date.today():%Y-%m-%d}"


def fetch_if_pdf(url: str) -> bytes | None:
    """If url serves a PDF (papers, reports), return its bytes; else None."""
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=60, stream=True)
    except requests.RequestException:
        return None
    with r:
        if not r.ok:
            return None
        ctype = r.headers.get("Content-Type", "").lower()
        first = next(r.iter_content(1024), b"")
        if "application/pdf" not in ctype and not first.startswith(b"%PDF"):
            return None
        return first + b"".join(r.iter_content(65536))


def send_pdf_as_is(page: dict, args) -> int:
    import base64
    data = page["pdf_bytes"] if "pdf_bytes" in page else base64.b64decode(page["pdf"])
    if not data.startswith(b"%PDF"):
        sys.exit("Safari returned something that isn't a PDF "
                 "(a login or 'checking your browser' page?). Open the PDF and try again.")
    title = args.title or pdf_title(data, page, page.get("url", ""))
    size_kb = len(data) // 1024
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / f"{slugify(title)}.pdf"
        out.write_bytes(data)
        if args.out:
            Path(args.out).write_bytes(data)
        if args.no_upload:
            print(f"PDF '{title}' ({size_kb}KB){' → ' + args.out if args.out else ''}")
            return 0
        upload(out, args.folder)
    print(f"✓ Sent PDF '{title}' ({size_kb}KB) → {args.folder}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("source", nargs="?", help="URL or path to .md/.html/.txt")
    ap.add_argument("--stdin", action="store_true", help="Read markdown from stdin")
    ap.add_argument("--title", help="Override the document title")
    ap.add_argument("--folder", default=DEFAULT_FOLDER,
                    help=f"reMarkable folder (default {DEFAULT_FOLDER})")
    ap.add_argument("--out", help="Also save the PDF to this local path")
    ap.add_argument("--no-upload", action="store_true",
                    help="Render only; don't upload (for previewing)")
    ap.add_argument("--url", help="With an .html source: the page's URL. The file "
                    "is then treated as a full web page, exactly like a fetched URL")
    ap.add_argument("--page-json", metavar="FILE",
                    help='Page captured in the browser as JSON {"url": ..., "html": ...}; '
                    '"-" reads stdin (used by the Safari Shortcut)')
    args = ap.parse_args()

    title, body = None, None

    if args.page_json:
        import json
        raw = sys.stdin.read() if args.page_json == "-" else Path(args.page_json).read_text()
        page = json.loads(raw)
        if page.get("error"):
            sys.exit(f"Safari couldn't read the page: {page['error']}")
        if page.get("pdf"):
            # Safari was showing a PDF: send the file itself, untouched
            return send_pdf_as_is(page, args)
        if not page.get("html") or not page.get("url"):
            sys.exit("--page-json needs \"url\" and either \"html\" or \"pdf\"")
        title, body = from_page_html(page["html"], page["url"])
    elif args.stdin:
        text = sys.stdin.read()
        title = args.title or "Note"
        body = from_markdown(text)
    elif args.source and args.source.startswith(("http://", "https://")):
        pdf = fetch_if_pdf(args.source)
        if pdf:
            # A link to a PDF: send the file itself, untouched
            return send_pdf_as_is({"url": args.source, "pdf_bytes": pdf}, args)
        title, body = from_url(args.source)
    elif args.source:
        path = Path(args.source)
        if not path.exists():
            sys.exit(f"File not found: {path}")
        raw = path.read_text()
        if path.suffix == ".md":
            title, body = (args.title or path.stem), from_markdown(raw)
        elif path.suffix in (".html", ".htm") and args.url:
            title, body = from_page_html(raw, args.url)
        elif path.suffix in (".html", ".htm"):
            t, body = from_html_file(raw)
            title = args.title or t
        else:
            title, body = (args.title or path.stem), from_text(raw)
    else:
        sys.exit("Provide a URL, a file path, or --stdin.")

    if args.title:
        title = args.title

    body = clean(body)
    body = drop_repeated_title(body, title)
    from_web = bool(args.page_json or (args.source and args.source.startswith(("http://", "https://"))))
    words = len(BeautifulSoup(body, "html.parser").get_text(" ", strip=True).split())
    if from_web and words < 50:
        # Never upload an empty page (blocked fetch, cookie wall, odd format)
        sys.exit(f"No article text found ({words} words): not sent. "
                 "If it's a PDF or paywalled, open it in Safari and use the Mac Shortcut, "
                 "or attach the PDF to an email.")
    with tempfile.TemporaryDirectory() as td:
        fname = f"{slugify(title)}.pdf"
        out = Path(td) / fname
        render_pdf(title, body, out)
        size_kb = out.stat().st_size // 1024
        if args.out:
            Path(args.out).write_bytes(out.read_bytes())
        if args.no_upload:
            print(f"Rendered '{title}' ({size_kb}KB){' → ' + args.out if args.out else ''}")
            return 0
        upload(out, args.folder)
        print(f"✓ Sent '{title}' ({size_kb}KB) → {args.folder}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
