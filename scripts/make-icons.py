"""Generate PWA icons: tomato rounded square with a cream "C" arc.

No fonts needed: the C is a thick circular arc drawn with PIL, so the output
is identical on any machine. Run: python3 scripts/make-icons.py
Writes public/icons/icon-{180,192,512}.png (tomato #C93A22 on cream #FBF6EC).
"""

from PIL import Image, ImageDraw

CREAM = "#FBF6EC"
TOMATO = "#C93A22"
SIZES = (180, 192, 512)


def make_icon(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size), CREAM)
    d = ImageDraw.Draw(img)
    pad = size * 0.08
    d.rounded_rectangle(
        [pad, pad, size - pad, size - pad],
        radius=int(size * 0.24),
        fill=TOMATO,
    )
    # Cream "C" opening to the right: arc gap centred on 3 o'clock.
    m = size * 0.27
    d.arc([m, m, size - m, size - m], start=55, end=305, fill=CREAM, width=int(size * 0.11))
    return img


def main() -> None:
    for size in SIZES:
        path = f"public/icons/icon-{size}.png"
        make_icon(size).save(path)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
