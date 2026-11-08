#!/usr/bin/env python3
"""Render the About Time app icons.

No design tool required: one source of truth, three PNG sizes. Run from the
repo root with `python3 scripts/make-icons.py`.
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
S = 1024  # supersampled master

EMBER_TOP = (240, 138, 75)
EMBER_BOTTOM = (217, 80, 43)
CREAM = (255, 246, 234)


def rounded_gradient(size: int, radius: int) -> Image.Image:
    gradient = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        gradient.putpixel(
            (0, y),
            tuple(round(a + (b - a) * t) for a, b in zip(EMBER_TOP, EMBER_BOTTOM)),
        )
    gradient = gradient.resize((size, size))

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)

    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tile.paste(gradient, (0, 0), mask)
    return tile


def draw_icon(size: int) -> Image.Image:
    icon = rounded_gradient(S, radius=272)

    # Draw at master resolution, then downscale for clean edges.
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # Battery body (outline) + terminal nub.
    d.rounded_rectangle((190, 400, 760, 700), radius=100, outline=CREAM, width=56)
    d.rounded_rectangle((760, 492, 846, 608), radius=30, fill=CREAM)

    # Three charged cells, left-aligned: the battery is clearly not full.
    cells = [262, 376, 490]
    for x in cells:
        d.rounded_rectangle((x, 466, x + 84, 634), radius=26, fill=CREAM)

    icon.alpha_composite(layer)
    return icon.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    master = draw_icon(S)
    for size in (512, 192, 180):
        master.resize((size, size), Image.LANCZOS).save(OUT / f"icon-{size}.png", optimize=True)
    master.save(OUT / "icon-1024.png", optimize=True)
    print("wrote", ", ".join(sorted(p.name for p in OUT.glob("*.png"))))


if __name__ == "__main__":
    main()
