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
        downloaded = r.text if r.ok else None
    if not downloaded:
        sys.exit(f"Could not fetch {url}")
    # Extract main content as HTML, keeping images + formatting.
    extracted = trafilatura.extract(
        downloaded, output_format="html",
        include_images=True, include_links=False,
        include_comments=False, include_tables=True,
        favor_precision=True,
    )
    # Title from metadata.
    md = trafilatura.extract_metadata(downloaded)
    title = (md.title if md and md.title else None) or url
    if not extracted:
        # Last resort: dump readable text from <article>/<main>.
        soup = BeautifulSoup(downloaded, "html.parser")
        node = soup.select_one("article") or soup.select_one("main") or soup
        extracted = str(node)
    return title, extracted


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


def render_pdf(title: str, body_html: str, out: Path) -> None:
    date = dt.datetime.now().strftime("%B %-d, %Y")
    full = f"""<!doctype html><html><head><meta charset="utf-8">
<title>{title}</title></head><body>
<header><h1 class="post-title">{title}</h1>
<p class="post-date">{date}</p></header>
<article>{body_html}</article></body></html>"""
    css = [CSS(filename=str(STYLE_CSS))] if STYLE_CSS.exists() else []

    def fetcher(url):
        r = requests.get(url, timeout=20, headers={"User-Agent": UA})
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
    args = ap.parse_args()

    title, body = None, None

    if args.stdin:
        text = sys.stdin.read()
        title = args.title or "Note"
        body = from_markdown(text)
    elif args.source and args.source.startswith(("http://", "https://")):
        title, body = from_url(args.source)
    elif args.source:
        path = Path(args.source)
        if not path.exists():
            sys.exit(f"File not found: {path}")
        raw = path.read_text()
        if path.suffix == ".md":
            title, body = (args.title or path.stem), from_markdown(raw)
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
