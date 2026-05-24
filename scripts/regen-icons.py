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
    Solid-filled monochrome silhouette for Android 13+ themed icons.

    Algorithm:
      1. Build a binary mask where bright/low-chroma cream pixels = "background candidate"
         and dark or saturated content pixels = "content."
      2. Flood-fill from all 4 image corners through the background-candidate region
         — anything reachable from the edge is genuinely "outside" the shape.
      3. The silhouette is then: every pixel that is NOT marked as "outside."
         That includes both the dark strokes AND the cream paper enclosed by them
         (e.g. the book's open pages), giving us a solid filled shape.
      4. Render the silhouette as white-on-transparent so the launcher can tint it.

    Result is a chunky filled book+pencil shape, not a thin outline.
    """
    src_rgba = src.convert("RGBA")
    w, h = src_rgba.size
    src_pixels = src_rgba.load()

    # Step 1: background-candidate mask. 255 = candidate (cream-ish or transparent),
    # 0 = content. The source uses a warm cream (~RGB 248,231,212 near edges) with
    # chroma up to ~40, so we use a permissive chroma threshold of 60.
    # Brightness threshold is set low (190) to also capture slightly-shadowed
    # corner/edge cream while still excluding the dark strokes (which are ~90 RGB).
    bg = Image.new("L", (w, h), 0)
    bg_pixels = bg.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = src_pixels[x, y]
            if a < 32:
                bg_pixels[x, y] = 255  # transparent counts as background
                continue
            bright = min(r, g, b) >= 190
            warm_cream = max(r, g, b) - min(r, g, b) <= 60
            if bright and warm_cream:
                bg_pixels[x, y] = 255

    # Step 1.5: seal narrow gaps in the bg-mask so the flood can't leak through
    # the V-shaped opening at the top of an open book (where outer cream connects
    # to inner-page cream through a 10-20px gap between the page edges).
    # MinFilter shrinks the 255 region (= dilates the strokes), sealing gaps
    # narrower than the kernel diameter.
    bg = bg.filter(ImageFilter.MinFilter(15))

    # Step 2: flood-fill from all four corners. Reachable bg pixels (255) become 128.
    # Anything still 255 after the fills is "enclosed background" = part of the shape.
    for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        if bg.getpixel(seed) == 255:
            ImageDraw.floodfill(bg, seed, 128, thresh=20)

    # Step 3: silhouette = NOT 128. Both 0 (content) and 255 (enclosed) become white.
    silhouette = Image.new("L", (w, h), 0)
    sil_pixels = silhouette.load()
    fill_pixels = bg.load()
    for y in range(h):
        for x in range(w):
            if fill_pixels[x, y] != 128:
                sil_pixels[x, y] = 255

    # Light morphological closing — the bg-mask sealing already filled the
    # inner pages; here we just smooth out tiny anti-aliasing artifacts on
    # the silhouette edges without losing the book's internal page-line detail.
    silhouette = silhouette.filter(ImageFilter.MaxFilter(3))
    silhouette = silhouette.filter(ImageFilter.MinFilter(3))
    silhouette = silhouette.filter(ImageFilter.GaussianBlur(0.6))
    silhouette = silhouette.point(lambda v: 255 if v > 96 else 0, mode="L")

    # Step 4: resize to safe-zone fraction of target canvas
    content = int(size * SAFE_ZONE)
    sil_resized = silhouette.resize((content, content), Image.LANCZOS)

    # White-on-transparent: alpha channel comes from the silhouette
    white_layer = Image.new("RGBA", sil_resized.size, (255, 255, 255, 0))
    wp = white_layer.load()
    srp = sil_resized.load()
    for y in range(sil_resized.size[1]):
        for x in range(sil_resized.size[0]):
            wp[x, y] = (255, 255, 255, srp[x, y])

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    offset = (size - content) // 2
    canvas.paste(white_layer, (offset, offset), white_layer)
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
