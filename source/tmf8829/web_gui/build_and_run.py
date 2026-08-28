#!/usr/bin/env python3
"""Bundles the web app into a single self-contained HTML file.

The result runs straight from the file system in Chrome: the ES modules are
concatenated into one classic script, the stylesheet is inlined and the sensor
firmware is embedded, so the page never needs `fetch()` or a web server.
"""

import re
import webbrowser
from pathlib import Path
import time

WEBAPP = Path(__file__).resolve().parent
REPO = WEBAPP.parents[2]
FIRMWARE = WEBAPP / "hex" / "tmf8829_application.hex"
OUTPUT = REPO / "html" / "tmf8829" / "tmf8829_web_gui.html"

# Dependency order: a module must come after everything it imports.
MODULES = [
    "crc16.js",
    "registers.js",
    "intelhex.js",
    "frames.js",
    "corefw.js",
    "h5.js",
    "render.js",
    "tmf8829.js",
    "webusb.js",
    "app.js",
]

IMPORT_START = re.compile(r"^\s*import\b")
IMPORT_END = re.compile(r"from\s+'[^']*';\s*$")
EXPORT_PREFIX = re.compile(r"^export\s+")


def strip_module_syntax(source: str, name: str) -> str:
    """Removes import statements and the `export` keyword from a module."""
    lines = []
    in_import = False
    for line in source.splitlines():
        if in_import:
            in_import = not IMPORT_END.search(line)
            continue
        if IMPORT_START.match(line):
            in_import = not IMPORT_END.search(line)
            continue
        lines.append(EXPORT_PREFIX.sub("", line))
    return f"// ---- {name} " + "-" * max(0, 68 - len(name)) + "\n" + "\n".join(lines)


def main() -> None:
    html = (WEBAPP / "index.html").read_text(encoding="utf-8")
    css = (WEBAPP / "css" / "style.css").read_text(encoding="utf-8")
    firmware = FIRMWARE.read_text(encoding="utf-8").strip()

    bundle = "\n\n".join(
        strip_module_syntax((WEBAPP / "js" / name).read_text(encoding="utf-8"), name)
        for name in MODULES
    )
    if "</script" in bundle or "</script" in firmware:
        raise SystemExit("source contains a literal </script and would break the bundle")

    html = html.replace(
        '<link rel="stylesheet" href="css/style.css">',
        f"<style>\n{css}\n</style>",
    )
    html = html.replace(
        "By default <code>tmf8829/hex/tmf8829_application.hex</code> is fetched from the server.",
        "<code>tmf8829_application.hex</code> is embedded in this page; select a file only to override it.",
    )
    html = html.replace(
        '<script type="module" src="js/app.js"></script>',
        '<script type="text/plain" id="embeddedFirmware">\n'
        f"{firmware}\n"
        "</script>\n"
        f"<script>\n(function () {{\n'use strict';\n{bundle}\n}})();\n</script>",
    )
    if "js/app.js" in html or "css/style.css" in html:
        raise SystemExit("index.html changed: the bundler could not inline all assets")

    OUTPUT.write_text(html, encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(REPO)} ({OUTPUT.stat().st_size / 1024:.0f} kB)")
    print("Opening web browser with created file...")
    webbrowser.open(OUTPUT.as_uri())


if __name__ == "__main__":
    main()
    time.sleep(3)  # to see output file location
