"""Render the existing Classnest book mark at mobile icon sizes (Pillow required)."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "app-icons"
OUT.mkdir(parents=True, exist_ok=True)

def icon(size, maskable=False):
    # Oversample the same simple code-native book shape for crisp small icons.
    scale = 4
    canvas = Image.new("RGB", (size * scale, size * scale), "#dfff98")
    draw = ImageDraw.Draw(canvas)
    unit = size * scale / 100
    points = lambda values: [(round(x * unit), round(y * unit)) for x, y in values]
    width = round(3.8 * unit)
    # Entire foreground remains within the maskable icon's central safe circle.
    left = [(50, 31), (42, 25), (34, 25), (27, 28), (27, 67), (36, 64), (43, 65), (50, 71)]
    right = [(50, 31), (58, 25), (66, 25), (73, 28), (73, 67), (64, 64), (57, 65), (50, 71)]
    for edge in (left, right):
        draw.line(points(edge), fill="#183e35", width=width, joint="curve")
    draw.line(points([(50, 31), (50, 71)]), fill="#183e35", width=width)
    for line in ([(33, 39), (43, 38)], [(33, 48), (43, 47)], [(57, 38), (67, 39)], [(57, 47), (67, 48)]):
        draw.line(points(line), fill="#183e35", width=round(2 * unit))
    return canvas.resize((size, size), Image.Resampling.LANCZOS)

for name, size, maskable in (("icon-192.png", 192, False), ("icon-512.png", 512, False), ("maskable-512.png", 512, True), ("apple-touch-icon.png", 180, False)):
    icon(size, maskable).save(OUT / name, optimize=True)
print("Created 4 Classnest mobile app icons.")
