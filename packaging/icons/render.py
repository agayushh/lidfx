#!/usr/bin/env python3
"""Render the LidFx mark to hicolor PNG sizes."""
import sys
from pathlib import Path

from PIL import Image, ImageDraw


def render(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (20, 18, 16, 255))
    draw = ImageDraw.Draw(img)
    radius = int(size * 5.2 / 24)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=(20, 18, 16, 255))
    scale = size / 24
    cream = (239, 232, 220, 255)

    def rect(x, y, w, h):
        draw.rectangle(
            (round(x * scale), round(y * scale), round((x + w) * scale) - 1, round((y + h) * scale) - 1),
            fill=cream,
        )

    rect(4, 13, 5.2, 9)
    rect(14.8, 13, 5.2, 9)
    rect(3, 8, 18, 3.6)
    return img


def main():
    dest = Path(sys.argv[1] if len(sys.argv) > 1 else ".build/icons")
    dest.mkdir(parents=True, exist_ok=True)
    for size in (64, 128, 256):
        render(size).save(dest / f"io.github.agayushh.LidFx-{size}.png")


if __name__ == "__main__":
    main()
