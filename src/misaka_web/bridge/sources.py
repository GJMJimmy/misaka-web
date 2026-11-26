"""Where a research product gets its evidence: the SOURCES manifest beside it.

MISAKA writes a SOURCES.md next to every card, node and final product (bundle.py in the
upstream checkout): a Products section, then the files it gathered under sources/ with the
original path, a sha256 and the locators the text cites (doc:<id>#p<n>, URLs, relative paths).
This module reads that manifest; it never rebuilds it.
"""

from __future__ import annotations

import os
import re
from typing import Any

DOC_LOCATOR = re.compile(r"doc:[0-9a-f]{8,64}(?:#p\d+)?")
PAGE_IN_LOCATOR = re.compile(r"#p(\d+)$")
PRODUCT_LINE = re.compile(r"^- \x60([^\x60]+)\x60 \u2014 (.*) \(([^)]*)\)$")
SOURCE_LINE = re.compile(r"^- \x60([^\x60]+)\x60 \u2190 \x60([^\x60]+)\x60")


def parse_manifest(text: str) -> dict[str, Any]:
    """Products and cited sources of one manifest, tolerant of extra detail lines."""
    products: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    section = ""
    current: dict[str, Any] | None = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if line.startswith("## "):
            section = line[3:].strip().lower()
            current = None
            continue
        if section.startswith("products"):
            match = PRODUCT_LINE.match(line)
            if match:
                products.append({"path": match.group(1), "title": match.group(2).strip(), "kind": match.group(3)})
        elif section.startswith("cited sources"):
            match = SOURCE_LINE.match(line)
            if match:
                current = {"placed": match.group(1), "original": match.group(2), "sha256": None,
                           "details": [], "locators": [], "pages": []}
                sources.append(current)
                continue
            if current is None or not line.strip():
                continue
            detail = line.strip().lstrip("-").strip()
            if not detail:
                continue
            if detail.startswith("sha256 "):
                current["sha256"] = detail[7:].strip()
            for locator in DOC_LOCATOR.findall(detail):
                if locator not in current["locators"]:
                    current["locators"].append(locator)
                page = PAGE_IN_LOCATOR.search(locator)
                if page and int(page.group(1)) not in current["pages"]:
                    current["pages"].append(int(page.group(1)))
            current["details"].append(detail)
    for source in sources:
        source["pages"] = sorted(source["pages"])
    return {"products": products, "sources": sources}


def read_manifest_path(path: str) -> dict[str, Any] | None:
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            text = handle.read()
    except OSError:
        return None
    return {"path": path, "text": text, **parse_manifest(text)}


def read_manifest(folder: str) -> dict[str, Any] | None:
    path = os.path.join(folder, "SOURCES.md")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            text = handle.read()
    except OSError:
        return None
    parsed = parse_manifest(text)
    return {"path": path, "text": text, **parsed}