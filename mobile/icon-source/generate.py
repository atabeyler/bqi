#!/usr/bin/env python3
"""Regenerates the Android launcher icons from the BQI brand SVGs.

Run manually whenever client/public/icon-source.svg (or foreground.svg,
its adaptive-icon derivative with the background stripped and content
scaled into the safe zone) changes:

    pip install cairosvg pillow
    python3 mobile/icon-source/generate.py
"""
import io
import os

import cairosvg
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SQUARE_SVG = os.path.join(ROOT, "client", "public", "icon-source.svg")
FOREGROUND_SVG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "foreground.svg")
RES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "android", "app", "src", "main", "res")

# Standard Android density buckets -> legacy launcher icon px size (48dp base)
# and adaptive-icon foreground/background px size (108dp base).
DENSITIES = {
    "mdpi": (48, 108),
    "hdpi": (72, 162),
    "xhdpi": (96, 216),
    "xxhdpi": (144, 324),
    "xxxhdpi": (192, 432),
}


def render_svg(path, size):
    png_bytes = cairosvg.svg2png(url=path, output_width=size, output_height=size)
    return Image.open(io.BytesIO(png_bytes)).convert("RGBA")


def circle_mask(img):
    size = img.size[0]
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    out = img.copy()
    out.putalpha(mask)
    return out


def main():
    for density, (legacy_size, adaptive_size) in DENSITIES.items():
        out_dir = os.path.join(RES, f"mipmap-{density}")
        os.makedirs(out_dir, exist_ok=True)

        square = render_svg(SQUARE_SVG, legacy_size)
        square.save(os.path.join(out_dir, "ic_launcher.png"))
        circle_mask(square).save(os.path.join(out_dir, "ic_launcher_round.png"))

        foreground = render_svg(FOREGROUND_SVG, adaptive_size)
        foreground.save(os.path.join(out_dir, "ic_launcher_foreground.png"))

        print(f"{density}: legacy {legacy_size}px, adaptive {adaptive_size}px")


if __name__ == "__main__":
    main()
