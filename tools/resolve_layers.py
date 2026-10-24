#!/usr/bin/env python3
"""
tools/resolve_layers.py — resolve ASIG portal Titles to exact layer Names,
OFFLINE, from a browser-saved capabilities file.

Why a file and not a URL: ASIG (geoportal.asig.gov.al) blacklists
datacenter/automated IPs, so a script fetching GetCapabilities usually fails
while a normal browser works. Save the document in a browser:

    https://geoportal.asig.gov.al/service/wms?service=WMS&version=1.3.0&request=GetCapabilities

then run:

    python3 tools/resolve_layers.py path/to/capabilities.xml
    python3 tools/resolve_layers.py path/to/capabilities.xml --json
    python3 tools/resolve_layers.py path/to/capabilities.xml --title "Cadastral Zone"

Matching mirrors js/asig-albania-layers.js (and the owner's prototype):
normalise (lowercase, underscores/whitespace -> single space, trim), exact
Title match first, then local Name (after the workspace prefix). A Title
with more than one distinct Name is reported as AMBIGUOUS and never guessed;
a Title with no hit is MISSING. Layers whose Title or Name matches the
archaeology keyword are listed as Heritage-part candidates for
CONFIG.heritage.staticDiscovered in js/asig-albania-layers.config.js.

WMS GetCapabilities (Layer/Name/Title) and WMTS GetCapabilities
(Contents/Layer/ows:Identifier/ows:Title) are both understood.
Standard library only; no network access.
"""
import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET

# The resolve-by-title entries of js/asig-albania-layers.config.js, verbatim
# (including the portal's own misspelling "Mineral Resouces").
DEFAULT_TITLES = [
    "Cadastral Zone",
    "Cadastral Parcels",
    "Cadastral Parcels (ASHK)",
    "25k_krgjsh_1",
    "Water course link",
    "Areas Planned by (DCM 347)",
    "Mining Hazardous Areas (DCM 726)",
    "Mining Hazardous Areas (DCM 347)",
    "Old Mining Areas",
    "Mineral Resouces",
    "Mining exploitation permits",
]

DEFAULT_KEYWORD = r"archaeolog|archeolog|arkeolog"


def local(tag):
    """Element tag without its XML namespace."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def norm(text):
    return re.sub(r"[_\s]+", " ", (text or "").lower()).strip()


def iter_layers(root):
    """Yield (name, title) for every named Layer in a WMS or WMTS document."""
    for element in root.iter():
        if local(element.tag) != "Layer":
            continue
        name = ""
        title = ""
        for child in element:
            child_local = local(child.tag)
            if child_local in ("Name", "Identifier") and not name:
                name = (child.text or "").strip()
            elif child_local == "Title" and not title:
                title = (child.text or "").strip()
        if name:
            yield name, title


def resolve(layers, titles, keyword):
    resolved = {}
    ambiguous = {}
    missing = []
    assigned = set()
    for wanted in titles:
        key = norm(wanted)
        hits = []
        for name, title in layers:
            if norm(title) == key and name not in assigned and name not in hits:
                hits.append(name)
        if not hits:
            for name, title in layers:
                if norm(name.split(":")[-1]) == key and name not in assigned and name not in hits:
                    hits.append(name)
        if len(hits) == 1:
            resolved[wanted] = hits[0]
            assigned.add(hits[0])
        elif len(hits) > 1:
            ambiguous[wanted] = hits
        else:
            missing.append(wanted)

    pattern = re.compile(keyword, re.IGNORECASE)
    keyword_matches = []
    seen = set()
    for name, title in layers:
        if name in seen or name in assigned:
            continue
        if pattern.search((title or "") + " " + name):
            seen.add(name)
            keyword_matches.append({"layers": name, "title": title})
    keyword_matches.sort(key=lambda item: item["title"] or item["layers"])
    return resolved, ambiguous, missing, keyword_matches


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Resolve ASIG portal Titles to exact layer Names from a saved capabilities file (offline)."
    )
    parser.add_argument("capabilities", help="browser-saved WMS or WMTS GetCapabilities XML file")
    parser.add_argument("--title", action="append", dest="titles",
                        help="resolve only this Title (repeatable; default: the catalogue's resolve-by-title list)")
    parser.add_argument("--keyword", default=DEFAULT_KEYWORD,
                        help="regex for Heritage keyword candidates (default: %(default)s)")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = parser.parse_args(argv)

    try:
        tree = ET.parse(args.capabilities)
    except (OSError, ET.ParseError) as error:
        print(f"error: cannot parse {args.capabilities}: {error}", file=sys.stderr)
        return 1

    layers = list(iter_layers(tree.getroot()))
    if not layers:
        print(f"error: no named layers found in {args.capabilities}", file=sys.stderr)
        return 1

    titles = args.titles or DEFAULT_TITLES
    resolved, ambiguous, missing, keyword_matches = resolve(layers, titles, args.keyword)

    if args.json:
        print(json.dumps({
            "file": args.capabilities,
            "layersInDocument": len(layers),
            "resolved": resolved,
            "ambiguous": ambiguous,
            "missing": missing,
            "keywordMatches": keyword_matches,
        }, indent=2, ensure_ascii=False))
        return 0

    print(f"{len(layers)} named layers in {args.capabilities}\n")
    print("RESOLVED (bake into `layers` in js/asig-albania-layers.config.js):")
    for title in titles:
        if title in resolved:
            print(f"  {title}  ->  {resolved[title]}")
    if ambiguous:
        print("\nAMBIGUOUS (more than one Name — the owner must pick; nothing is guessed):")
        for title, names in ambiguous.items():
            print(f"  {title}  ->  {', '.join(names)}")
    if missing:
        print("\nMISSING (no Title or local-Name match in this document):")
        for title in missing:
            print(f"  {title}")
    print("\nHERITAGE KEYWORD CANDIDATES (for heritage.staticDiscovered):")
    for match in keyword_matches:
        print(f"  {{ title: '{match['title']}', layers: '{match['layers']}' }}")
    if not keyword_matches:
        print("  (none)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
