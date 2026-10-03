#!/usr/bin/env python3
"""Stamp a content hash onto the cache-busting query string of local assets.

Why this exists
---------------
Cloudflare serves these files with `cache-control: max-age=14400` and the
filenames never change, so a deploy is invisible to returning visitors and to
the edge for hours. It is worse than the four hours suggests: on 2026-09-04 an
app.js was measured at `age: 35067`, nearly ten hours, still `cf-cache-status:
HIT`, long past its own TTL. A purge does not help either, because it clears
Cloudflare but never a browser.

The query string IS part of the Cloudflare cache key on this zone (verified by
a MISS/HIT/MISS probe), so bumping ?v= busts the edge and the browser at once.

Keying on the file's own SHA-256 means a run that changes nothing produces no
diff, so this is safe to run before every commit and impossible to forget to
bump.

ES modules (MetadataScrubber only)
----------------------------------
app.js is a module that imports the scrubbing engine (src/scrub-core.js), which
imports its format modules (src/core/*.js). The browser fetches those by the
specifier written in the importing file, so a stamp in the HTML alone would let
a returning visitor run a new app.js against engine modules cached for hours.
This script therefore also stamps every relative `import ... from './x.js'` and
`export ... from './x.js'` in the JavaScript files, bottom up: a module's stamp
is the hash of its own text WITH its imports already stamped. A change deep in
the engine changes the stamp of every module that imports it, all the way up to
app.js and the page. Every importer of a module uses the same stamp, so each
module is still loaded once.

What it does NOT touch, deliberately:
  * anything under switcher-icons/ - those bytes never change, and the marquee
    repeats them 180 times, so stamping them would bloat the HTML for nothing
  * absolute URLs - not ours to version
  * font files referenced from inside a CSS file - the CSS gets a new ?v= when
    it changes, and the font bytes are immutable anyway
  * tests/ - test files are not published and import the engine without stamps

Usage:  python3 bump_assets.py [--check]
        --check exits 1 if any page or module is stale, without writing. For a git hook.
"""

import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).parent
SKIP_DIRS = {"switcher-icons", "node_modules", ".git", "android", "dist", "fastlane", "tests"}
ASSET_RE = re.compile(r'(?P<attr>src|href)="(?P<path>(?!https?://|//|data:|#|mailto:)[^"?#]+\.(?:js|css))(?:\?v=[^"]*)?"')
# Static relative imports and re-exports: import x from './a.js', import './a.js',
# export { y } from '../b.js'. The part before the quote never contains a quote, so a
# specifier split over several lines is still found.
IMPORT_RE = re.compile(
    r"""(?P<head>\b(?:import|export)\b[^'"`;]*?\bfrom\s*|\bimport\s*)(?P<q>['"])(?P<path>\.{1,2}/[^'"?#]+\.js)(?:\?v=[^'"]*)?(?P=q)"""
)


def pages():
    out = []
    for p in sorted(ROOT.rglob("*.html")):
        if SKIP_DIRS & set(p.relative_to(ROOT).parts):
            continue
        out.append(p)
    return out


def modules():
    out = []
    for p in sorted(ROOT.rglob("*.js")):
        if SKIP_DIRS & set(p.relative_to(ROOT).parts):
            continue
        out.append(p.resolve())
    return out


def short_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:8]


def digest(path: pathlib.Path) -> str:
    return short_hash(path.read_bytes())


def stamp_modules(check_only: bool) -> tuple[list[str], dict[str, str]]:
    """Stamps relative module imports bottom up. Returns (stale files, stamped texts)."""
    root = ROOT.resolve()
    sources = {p: p.read_text(encoding="utf-8") for p in modules()}
    stamped: dict[pathlib.Path, str] = {}
    visiting: set[pathlib.Path] = set()

    def visit(path: pathlib.Path) -> str:
        if path in stamped:
            return stamped[path]
        visiting.add(path)
        text = sources[path]

        def repl(m: re.Match) -> str:
            target = (path.parent / m.group("path")).resolve()
            if target not in sources or (root not in target.parents and target.parent != root):
                return m.group(0)
            if target in visiting:
                # An import cycle: the stamp falls back to the target's own text.
                v = short_hash(sources[target].encode("utf-8"))
            else:
                v = short_hash(visit(target).encode("utf-8"))
            return f'{m.group("head")}{m.group("q")}{m.group("path")}?v={v}{m.group("q")}'

        out = IMPORT_RE.sub(repl, text)
        visiting.discard(path)
        stamped[path] = out
        return out

    stale = []
    for path in sources:
        out = visit(path)
        if out != sources[path]:
            stale.append(path.relative_to(root).as_posix())
            if not check_only:
                path.write_text(out, encoding="utf-8")
    return stale, {str(p): t for p, t in stamped.items()}


def main() -> None:
    check_only = "--check" in sys.argv
    stale_modules, stamped = stamp_modules(check_only)
    cache: dict[str, str] = {}
    stale, seen = [], set()

    for page in pages():
        text = page.read_text(encoding="utf-8")

        def repl(m: re.Match) -> str:
            rel = m.group("path")
            target = (page.parent / rel).resolve()
            if not target.is_file() or ROOT.resolve() not in target.parents and target.parent != ROOT.resolve():
                return m.group(0)          # points outside the repo, leave alone
            if SKIP_DIRS & set(target.relative_to(ROOT.resolve()).parts):
                return m.group(0)
            key = str(target)
            if key not in cache:
                # In --check mode the module files are not rewritten, so the hash comes
                # from the text they would have.
                cache[key] = short_hash(stamped[key].encode("utf-8")) if key in stamped else digest(target)
            seen.add(target.relative_to(ROOT.resolve()).as_posix())
            return f'{m.group("attr")}="{rel}?v={cache[key]}"'

        updated = ASSET_RE.sub(repl, text)
        if updated != text:
            stale.append(page.relative_to(ROOT).as_posix())
            if not check_only:
                page.write_text(updated, encoding="utf-8")

    for rel in sorted(seen):
        print(f"{rel:<28} v={cache[str((ROOT / rel).resolve())]}")
    if stale_modules:
        print(f"{len(stale_modules)} module(s) {'stale' if check_only else 'updated'}: {', '.join(stale_modules)}")
    if stale:
        print(f"{len(stale)} page(s) {'stale' if check_only else 'updated'}: {', '.join(stale)}")
    if not stale and not stale_modules:
        print("all pages and modules already current")

    if check_only and (stale or stale_modules):
        sys.exit(1)


if __name__ == "__main__":
    main()
