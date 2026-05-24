"""
Regenerate Android launcher icons from Google Play Images/studydesk_icon_512.png.

Outputs:
  - mipmap-*/ic_launcher.png       (square legacy launcher icon, all 5 DPIs)
  - mipmap-*/ic_launcher_round.png (round legacy launcher icon, all 5 DPIs)
  - mipmap-*/ic_launcher_foreground.png (adaptive-icon foreground PNG, fallback)
  - drawable/studydesk_logo_fg.png (adaptive-icon foreground used by ic_studydesk_fg.xml)
  - drawable/ic_studydesk_mono.png (monochrome silhouette for Android 13+ themed icons)

Adaptive-icon foreground convention: the canvas is 108dp x 108dp, but the
"safe zone" guaranteed to be visible inside any system mask is the central
66dp circle. So the logo content should be sized to ~66/108 = 61% of the
canvas, centered.

DPI table:
  mdpi    = 48dp legacy / 108dp adaptive
  hdpi    = 72dp legacy / 162dp adaptive
  xhdpi   = 96dp legacy / 216dp adaptive
  xxhdpi  = 144dp legacy / 324dp adaptive
  xxxhdpi = 192dp legacy / 432dp adaptive
"""
from __future__ import annotations
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "Google Play Images" / "studydesk_icon_512.png"
RES = ROOT / "android" / "app" / "src" / "main" / "res"

LEGACY_SIZES = {
    "mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192,
}
ADAPTIVE_SIZES = {
    "mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432,
}
# Safe-zone fraction: content occupies ~66% of the canvas, centered.
SAFE_ZONE = 0.66


def load_source() -> Image.Image:
    if not SRC.exists():
        raise SystemExit(f"Source icon not found: {SRC}")
    img = Image.open(SRC).convert("RGBA")
    if img.size != (512, 512):
        print(f"  source is {img.size}, resampling to 512x512 first")
        img = img.resize((512, 512), Image.LANCZOS)
    return img


def make_square_icon(src: Image.Image, size: int) -> Image.Image:
    """Legacy square launcher icon — just a clean resize."""
    return src.resize((size, size), Image.LANCZOS)


def make_round_icon(src: Image.Image, size: int) -> Image.Image:
    """Legacy round launcher icon — circular crop of the square icon."""
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    resized = src.resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size, size), fill=255)
    out.paste(resized, (0, 0), mask)
    return out


def make_adaptive_foreground(src: Image.Image, size: int) -> Image.Image:
    """
    Adaptive icon foreground: canvas of `size x size`, transparent background,
    logo content scaled to ~SAFE_ZONE × canvas, centered.

    The cream background lives in the adaptive XML (`@color/ic_launcher_background`),
    so the foreground should ideally have a transparent bg — we strip near-cream
    pixels to alpha=0 to remove the source's baked-in background.
    """
    # Strip the cream background to alpha
    stripped = strip_cream_background(src)
    content = int(size * SAFE_ZONE)
    resized = stripped.resize((content, content), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    offset = (size - content) // 2
    canvas.paste(resized, (offset, offset), resized)
    return canvas


def strip_cream_background(src: Image.Image) -> Image.Image:
    """
    The source has a solid cream (#F5F2ED-ish) background. Convert pixels
    that are near-cream and far from the dark logo strokes into transparency.
    Tolerant matching: any pixel where R,G,B are all in [230, 255] and close
    to each other (low chroma) is treated as background.
    """
    src = src.convert("RGBA")
    pixels = src.load()
    w, h = src.size
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out_pixels = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            # Near-cream test: bright + low chroma
            bright = min(r, g, b) >= 225 and max(r, g, b) <= 255
            low_chroma = max(r, g, b) - min(r, g, b) <= 18
            if bright and low_chroma:
                # leave transparent
                continue
            out_pixels[x, y] = (r, g, b, a)
    return out


def make_monochrome(src: Image.Image, size: int = 432) -> Image.Image:
    """
    Monochrome silhouette for Android 13+ themed icons.
    The launcher will tint this dynamically based on the user's wallpaper —
    so the file just needs to be a white-on-transparent silhouette of the logo.
    """
    stripped = strip_cream_background(src)
    # Resize to safe-zone within target canvas
    content = int(size * SAFE_ZONE)
    resized = stripped.resize((content, content), Image.LANCZOS)
    # Convert non-transparent pixels to opaque white (alpha preserved from source)
    r, g, b, a = resized.split()
    white = Image.new("L", resized.size, 255)
    mono = Image.merge("RGBA", (white, white, white, a))
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    offset = (size - content) // 2
    canvas.paste(mono, (offset, offset), mono)
    return canvas


def main():
    src = load_source()
    written = []

    for dpi, size in LEGACY_SIZES.items():
        target = RES / f"mipmap-{dpi}" / "ic_launcher.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        make_square_icon(src, size).save(target, "PNG", optimize=True)
        written.append(target)

        target = RES / f"mipmap-{dpi}" / "ic_launcher_round.png"
        make_round_icon(src, size).save(target, "PNG", optimize=True)
        written.append(target)

    for dpi, size in ADAPTIVE_SIZES.items():
        target = RES / f"mipmap-{dpi}" / "ic_launcher_foreground.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        make_adaptive_foreground(src, size).save(target, "PNG", optimize=True)
        written.append(target)

    # studydesk_logo_fg.png — used by drawable/ic_studydesk_fg.xml as the bitmap.
    # Largest adaptive size (432×432) is appropriate.
    target = RES / "drawable" / "studydesk_logo_fg.png"
    make_adaptive_foreground(src, 432).save(target, "PNG", optimize=True)
    written.append(target)

    # Also update drawable-v24/studydesk_logo.png (used in the splash/branding asset
    # paths — same source treatment, but full bleed, not safe-zone shrunk).
    target = RES / "drawable-v24" / "studydesk_logo.png"
    if target.parent.exists():
        src.resize((432, 432), Image.LANCZOS).save(target, "PNG", optimize=True)
        written.append(target)
    target = RES / "drawable" / "studydesk_logo.png"
    src.resize((432, 432), Image.LANCZOS).save(target, "PNG", optimize=True)
    written.append(target)

    # Monochrome
    target = RES / "drawable" / "ic_studydesk_mono.png"
    make_monochrome(src, 432).save(target, "PNG", optimize=True)
    written.append(target)

    print(f"Wrote {len(written)} files:")
    for p in written:
        print(f"  {p.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
