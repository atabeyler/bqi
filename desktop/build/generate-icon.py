#!/usr/bin/env python3
"""Regenerates the desktop icon assets from the BQI brand SVG.

Uses the exact same source and rendering pipeline (cairosvg) as
mobile/icon-source/generate.py, so the desktop taskbar/window icon matches
the Android launcher icon pixel-for-pixel instead of drifting out of sync.

Run manually whenever client/public/icon-source.svg changes:

    pip install cairosvg pillow
    python3 desktop/build/generate-icon.py
"""
import os
import struct

import cairosvg
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SVG = os.path.join(ROOT, "client", "public", "icon-source.svg")
BUILD_DIR = os.path.dirname(os.path.abspath(__file__))

# 256px master for the Windows .ico (and the runtime taskbar/window icon).
ICON_SIZE = 256
# electron-builder auto-derives a macOS .icns (and reuses this for the Linux
# AppImage icon) from a single PNG, but requires it to be at least 1024x1024.
MAC_ICON_SIZE = 1024


def render(size):
    png_path = os.path.join(BUILD_DIR, f"_render_{size}.png")
    cairosvg.svg2png(url=SVG, write_to=png_path, output_width=size, output_height=size)
    im = Image.open(png_path).convert("RGBA")
    os.remove(png_path)
    return im


def write_ico(png_path, ico_path):
    with open(png_path, "rb") as f:
        png = f.read()
    icon_dir = struct.pack("<HHH", 0, 1, 1)  # reserved, type=icon, count=1
    entry = struct.pack(
        "<BBBBHHII",
        0, 0,  # width, height (0 = 256)
        0, 0,  # color palette, reserved
        1,  # color planes
        32,  # bits per pixel
        len(png),  # image data size
        len(icon_dir) + 16,  # offset
    )
    with open(ico_path, "wb") as f:
        f.write(icon_dir + entry + png)


def main():
    icon_path = os.path.join(BUILD_DIR, "icon.png")
    render(ICON_SIZE).save(icon_path)
    write_ico(icon_path, os.path.join(BUILD_DIR, "icon.ico"))
    render(MAC_ICON_SIZE).save(os.path.join(BUILD_DIR, "icon-mac.png"))
    print("Wrote desktop/build/icon.png, icon.ico and icon-mac.png")


if __name__ == "__main__":
    main()
