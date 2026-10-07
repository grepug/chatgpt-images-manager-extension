from pathlib import Path
from PIL import Image, ImageDraw

destination = Path(__file__).resolve().parents[1] / "extension" / "icons"
destination.mkdir(parents=True, exist_ok=True)
for size in (16, 32, 48, 128):
    scale = 4
    canvas = Image.new("RGBA", (size * scale, size * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    unit = size * scale / 24
    def box(values):
        return tuple(round(value * unit) for value in values)
    draw.rounded_rectangle(box((1, 1, 23, 23)), radius=round(6 * unit), fill="#212121")
    draw.rounded_rectangle(box((5, 5, 19, 19)), radius=round(2 * unit), outline="#f9f9f9", width=max(1, round(unit)))
    draw.ellipse(box((13.5, 7.5, 15.5, 9.5)), fill="#f9f9f9")
    draw.line([box((5, 16)), box((9, 12)), box((13, 16)), box((16, 13)), box((19, 16))], fill="#f9f9f9", width=max(1, round(unit)))
    canvas.resize((size, size), Image.Resampling.LANCZOS).save(destination / f"{size}.png")
