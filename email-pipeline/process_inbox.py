#!/usr/bin/env python3
"""Turn queued emails (inbox/*.json, written by the Gmail Apps Script) into
e-ink PDFs and upload them to the reMarkable with rmapi.

Each JSON file: {"id", "subject", "from", "date", "url"?, "html"?,
                 "pdfs"?: [{"name", "base64"}]}

Processed files are deleted. Exit code is non-zero if any item failed, so
GitHub emails a failure notice; the failed item stays in inbox/failed/.
"""
from __future__ import annotations

import base64
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SEND = HERE / "send.py"
FOLDER = "/Articles"
JUNK = re.compile(r"(enable javascript|just a moment|verify you are human|"
                  r"subscribe to (continue|read)|access denied|captcha)", re.I)


def clean_subject(s: str) -> str:
    s = re.sub(r"^\s*((fwd?|fw|doorst|tr)\s*:\s*)+", "", s or "", flags=re.I)
    return s.strip()


def pdf_text(pdf: Path) -> str:
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(pdf))
    try:
        return " ".join(doc[i].get_textpage().get_text_range()
                        for i in range(min(len(doc), 3)))
    finally:
        doc.close()


def check(pdf: Path) -> None:
    if pdf.stat().st_size < 5_000:
        raise RuntimeError("PDF is nearly empty")
    text = pdf_text(pdf)
    if len(text.split()) < 80 or JUNK.search(text[:1500]):
        raise RuntimeError("got a bot check, paywall or empty page, not the article")


def upload(pdf: Path) -> None:
    subprocess.run(["rmapi", "-ni", "mkdir", FOLDER], capture_output=True)
    for attempt in range(2):
        r = subprocess.run(["rmapi", "-ni", "put", "--content-only", str(pdf),
                            FOLDER + "/"], capture_output=True, text=True)
        if r.returncode == 0:
            return
        if attempt == 0:
            import time; time.sleep(30)
    raise RuntimeError(f"rmapi upload failed: {r.stderr.strip()[:300]}")


def render(args: list[str], out: Path) -> None:
    r = subprocess.run([sys.executable, str(SEND), *args, "--no-upload",
                        "--out", str(out)], capture_output=True, text=True)
    if r.returncode != 0 or not out.exists():
        raise RuntimeError((r.stderr or r.stdout).strip().splitlines()[-1]
                           if (r.stderr or r.stdout).strip() else "render failed")


def safe_name(title: str) -> str:
    s = re.sub(r"[^\w\s.,'&()-]", "", title).strip()
    return (re.sub(r"\s+", " ", s)[:90] or "Article")


def process(item: dict, work: Path) -> list[str]:
    title = clean_subject(item.get("subject", ""))
    sent = []
    for att in item.get("pdfs") or []:
        pdf = work / safe_name(Path(att["name"]).stem)
        pdf = pdf.with_suffix(".pdf")
        pdf.write_bytes(base64.b64decode(att["base64"]))
        upload(pdf)
        sent.append(pdf.stem)
    if item.get("url"):
        tmp = work / "render.pdf"
        args = [item["url"]]
        if title and not title.startswith("http"):
            args += ["--title", title]
        render(args, tmp)
    elif item.get("html"):
        src = work / "email.html"
        src.write_text(item["html"])
        tmp = work / "render.pdf"
        render([str(src), "--title", title or "Article"], tmp)
    else:
        if not sent:
            raise RuntimeError("no link, article or PDF found in the email")
        return sent
    check(tmp)
    # File name = title shown on the tablet: read it back from the PDF metadata.
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(tmp))
    doc_title = doc.get_metadata_dict().get("Title") or title or "Article"
    doc.close()
    final = work / f"{safe_name(doc_title)}.pdf"
    shutil.move(tmp, final)
    upload(final)
    sent.append(final.stem)
    return sent


def main(inbox: Path) -> int:
    failed_dir = inbox / "failed"
    items = sorted(inbox.glob("*.json"))
    if not items:
        print("Nothing new.")
        return 0
    failures = 0
    for path in items:
        item = json.loads(path.read_text())
        with tempfile.TemporaryDirectory() as td:
            try:
                titles = process(item, Path(td))
                print(f"✓ {', '.join(titles)}")
                path.unlink()
            except Exception as e:  # keep going; report at the end
                failures += 1
                print(f"✗ {clean_subject(item.get('subject', path.stem))}: {e}")
                failed_dir.mkdir(exist_ok=True)
                path.rename(failed_dir / path.name)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1] if len(sys.argv) > 1 else "inbox")))
