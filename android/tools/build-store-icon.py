#!/usr/bin/env python3
"""Render the 512 x 512 store icon that Zapstore and F-Droid display.

WHY THIS EXISTS. The APK ships no raster icon: the launcher icon is an adaptive-icon
XML built from vectors, because density PNGs are a source of build nondeterminism.
Android renders that happily, but a store front-end looks for a bitmap and shows an
empty tile without one. So the store icon is supplied as Fastlane metadata instead,
and the APK is untouched.

The composition mirrors the adaptive icon exactly: the page's background colour,
favicon.svg scaled by 0.78 and centred on its own bounding box inside a 108 unit
square, the same numbers as res/drawable/ic_launcher_foreground.xml. So the store
tile and the launcher icon are the same picture.

Rendering uses headless Chromium (the same engine that draws the web app), because
favicon.svg uses an SVG mask that simpler converters get wrong.

    python3 android/tools/build-store-icon.py

Needs: chromium (or google-chrome) on PATH, and Pillow.
Output: fastlane/metadata/android/en-US/images/icon.png
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SVG = os.path.join(REPO, "favicon.svg")
OUT = os.path.join(REPO, "fastlane", "metadata", "android", "en-US", "images", "icon.png")

SIZE = 512
BACKGROUND = "#0C0A12"  # res/values/colors.xml icon_background, the page's bg-base
SCALE = 0.78            # ic_launcher_foreground.xml
TRANSLATE = (28.96, 30.29)


def compose():
    src = open(SVG, encoding="utf-8").read()
    inner = re.search(r"<svg[^>]*>(.*)</svg>", src, re.S)
    if not inner:
        raise SystemExit("could not read favicon.svg")
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="%d" height="%d">'
        '<rect width="108" height="108" fill="%s"/>'
        '<g transform="translate(%s %s) scale(%s)">%s</g></svg>'
        % (SIZE, SIZE, BACKGROUND, TRANSLATE[0], TRANSLATE[1], SCALE, inner.group(1))
    )


def main():
    browser = shutil.which("chromium") or shutil.which("google-chrome") or shutil.which("chromium-browser")
    if not browser:
        raise SystemExit("needs chromium or google-chrome on PATH")
    with tempfile.TemporaryDirectory() as tmp:
        page = os.path.join(tmp, "icon.html")
        shot = os.path.join(tmp, "shot.png")
        with open(page, "w", encoding="utf-8") as f:
            f.write(
                "<!doctype html><html><head><style>html,body{margin:0;padding:0;background:%s;overflow:hidden}"
                "svg{display:block}</style></head><body>%s</body></html>" % (BACKGROUND, compose())
            )
        subprocess.run(
            [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
             "--force-device-scale-factor=1", "--window-size=%d,%d" % (SIZE, SIZE),
             "--user-data-dir=" + os.path.join(tmp, "profile"),
             "--screenshot=" + shot, "file://" + page],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        img = Image.open(shot).convert("RGB")
        if img.size != (SIZE, SIZE):
            img = img.crop((0, 0, SIZE, SIZE))
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        img.save(OUT, "PNG", optimize=True)

    bg = tuple(int(BACKGROUND[i:i + 2], 16) for i in (1, 3, 5))
    samples = [img.getpixel((x, y)) for y in range(0, SIZE, 2) for x in range(0, SIZE, 2)]
    marked = sum(1 for p in samples if sum(abs(a - b) for a, b in zip(p, bg)) > 30)
    print("wrote %s" % OUT)
    print("  %dx%d; %d of %d sampled pixels carry the mark" % (img.size[0], img.size[1], marked, len(samples)))
    if marked < len(samples) // 20:
        raise SystemExit("the mark did not render; refusing to ship a blank icon")


if __name__ == "__main__":
    sys.exit(main())
