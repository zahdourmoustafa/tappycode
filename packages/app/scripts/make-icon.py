#!/usr/bin/env python3
"""
The app icon: Tappy, drawn by the real engine (`tappy-frame.ts`), on the Stage
canvas (near-black, a faint LED dot grid, his own glow).

    python3 packages/app/scripts/make-icon.py            # previews of every variant
    python3 packages/app/scripts/make-icon.py --apply B  # write variant B into assets/

iOS draws the squircle itself: an App Store icon is a full-bleed opaque square
and the system cuts the continuous-corner shape, so the art keeps everything
that matters inside the squircle's safe circle. Android's adaptive icon is a
foreground (Tappy, transparent) over a background (the canvas), with Tappy inside
the 66% safe zone so any launcher mask keeps him whole.

Needs numpy, scipy and Pillow, and `bun` for the engine.
"""
import json
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.special import erf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
ASSETS = os.path.join(HERE, "..", "assets")
SS = 2  # supersampling
N = 1024

BG = np.array([10, 10, 12]) / 255.0  # theme.color.bg
CORAL = "#d97757"


def frame(size: int, mood: str, color: str = "", t: float = 4.0, seed: str = "", lift: float = 0.28) -> dict:
    out = subprocess.run(
        ["bun", os.path.join(HERE, "tappy-frame.ts"), str(size), mood, color, str(t), seed, str(lift)],
        cwd=ROOT, check=True, capture_output=True, text=True,
    )
    return json.loads(out.stdout)


class Canvas:
    def __init__(self, n: int, bg=BG, alpha: bool = False):
        self.n = n
        self.rgb = np.ones((n, n, 3)) * np.asarray(bg, dtype=float)
        self.a = np.zeros((n, n)) if alpha else None
        yy, xx = np.mgrid[0:n, 0:n]
        self.xx = xx + 0.5
        self.yy = yy + 0.5

    def _box(self, x, y, r):
        x0, x1 = max(0, int(x - r - 2)), min(self.n, int(x + r + 3))
        y0, y1 = max(0, int(y - r - 2)), min(self.n, int(y + r + 3))
        return slice(y0, y1), slice(x0, x1)

    def over(self, sl, cov, c, a):
        """Source-over with coverage `cov` (0..1 array) and colour c (0..1)."""
        k = (cov * a)[..., None]
        self.rgb[sl] = self.rgb[sl] * (1 - k) + np.asarray(c) * k
        if self.a is not None:
            self.a[sl] = self.a[sl] + (1 - self.a[sl]) * k[..., 0]

    def add(self, sl, val, c):
        self.rgb[sl] = self.rgb[sl] + val[..., None] * np.asarray(c)
        if self.a is not None:
            self.a[sl] = np.clip(self.a[sl] + val * 0.8, 0, 1)

    def disc(self, x, y, r, c, a):
        sl = self._box(x, y, r)
        d = np.hypot(self.xx[sl] - x, self.yy[sl] - y)
        self.over(sl, np.clip(r - d + 0.5, 0, 1), c, a)

    def halo(self, x, y, R, sigma, c, a):
        """A disc of radius R blurred by sigma, added (Skia's Plus blend)."""
        reach = R + 3 * sigma
        sl = self._box(x, y, reach)
        d = np.hypot(self.xx[sl] - x, self.yy[sl] - y)
        s = max(sigma, 0.5) * np.sqrt(2)
        val = 0.5 * (erf((R - d) / s) + erf((R + d) / s)) * 0.5 + 0.0
        self.add(sl, np.clip(val, 0, 1) * a, c)

    def soft_ellipse(self, cx, cy, w, h, sigma, c, a):
        # The falloff is measured in the ellipse's own scale, so along the
        # long axis it reaches further than 3 sigma: the box must too, or its
        # edge shows as a cut-off rectangle.
        reach = max(w, h) + 3.5 * sigma * max(w, h) / max(min(w, h), 1e-3)
        sl = self._box(cx, cy, reach)
        dx = (self.xx[sl] - cx) / max(w, 1e-3)
        dy = (self.yy[sl] - cy) / max(h, 1e-3)
        d = (np.hypot(dx, dy) - 1) * min(w, h)
        cov = 0.5 * (1 - erf(d / (max(sigma, 0.5) * np.sqrt(2))))
        self.over(sl, cov, c, a)

    def mask_op(self, draw_fn, c, a, blur=0.0, additive=False):
        m = Image.new("L", (self.n, self.n), 0)
        draw_fn(ImageDraw.Draw(m))
        if blur > 0:
            m = m.filter(ImageFilter.GaussianBlur(blur))
        cov = np.asarray(m, dtype=float) / 255.0
        sl = (slice(0, self.n), slice(0, self.n))
        if additive:
            self.add(sl, cov * a, c)
        else:
            self.over(sl, cov, c, a)


def paint_tappy(cv: Canvas, data: dict, ox: float, oy: float, scale: float, shadow: bool = True) -> None:
    """Replays the engine's draw calls with the same meaning as `Tappy.tsx`'s Skia painter."""
    k = scale
    col = lambda c: np.asarray(c, dtype=float) / 255.0
    for op in data["ops"]:
        kind = op[0]
        if kind == "dot":
            _, x, y, r, c, a = op
            if r <= 0.05 or a <= 0.01:
                continue
            cv.disc(ox + x * k, oy + y * k, r * k, col(c), min(1, a))
        elif kind == "glow":
            _, x, y, r, c, a = op
            if r <= 0.1 or a <= 0.01:
                continue
            cv.halo(ox + x * k, oy + y * k, r * 0.55 * k, r * 0.45 * k, col(c), min(1, a))
        elif kind == "shadow":
            if not shadow:
                continue
            _, cx, cy, w, h, a = op
            cv.soft_ellipse(ox + cx * k, oy + cy * k, w * 0.85 * k, h * 0.6 * k, max(1, h * 0.8) * k, (0, 0, 0), a)
        elif kind == "poly":
            _, pts, c, a = op
            xy = [(ox + pts[i] * k, oy + pts[i + 1] * k) for i in range(0, len(pts), 2)]
            cv.mask_op(lambda d: d.polygon(xy, fill=255), col(c), a)
        elif kind == "line":
            _, pts, w, c, a, glow_r, gc = op
            xy = [(ox + pts[i] * k, oy + pts[i + 1] * k) for i in range(0, len(pts), 2)]
            if glow_r > 0:
                cv.mask_op(lambda d: d.line(xy, fill=255, width=int(w * 1.6 * k), joint="curve"), col(gc), a * 0.7, blur=glow_r * 0.5 * k)
            cv.mask_op(lambda d: d.line(xy, fill=255, width=max(1, int(w * k)), joint="curve"), col(c), a)
        elif kind == "oval":
            _, cx, cy, rx, ry, rot, c, a, glow_r, gc = op
            # Small and rare (sleepy eyes): drawn unrotated.
            bbox = [ox + (cx - rx) * k, oy + (cy - ry) * k, ox + (cx + rx) * k, oy + (cy + ry) * k]
            if glow_r > 0:
                cv.mask_op(lambda d: d.ellipse(bbox, fill=255), col(gc), a * 0.9, blur=glow_r * 0.5 * k, additive=True)
            cv.mask_op(lambda d: d.ellipse(bbox, fill=255), col(c), a)


def dot_grid(cv: Canvas, pitch: float, r: float, a: float, fade_from=None) -> None:
    """The Stage canvas's LED grid, fading out toward the edges."""
    n = cv.n
    off = (n % pitch) / 2 + pitch / 2
    for y in np.arange(off, n, pitch):
        for x in np.arange(off, n, pitch):
            k = a
            if fade_from is not None:
                fx, fy, fr = fade_from
                k = a * (0.35 + 0.65 * np.exp(-((x - fx) ** 2 + (y - fy) ** 2) / (2 * fr * fr)))
            cv.disc(x, y, r, (1, 1, 1), k)


def radial(cv: Canvas, cx, cy, R, c, a) -> None:
    d = np.hypot(cv.xx - cx, cv.yy - cy)
    val = a * np.exp(-((d / R) ** 2) * 2.2)
    cv.add((slice(0, cv.n), slice(0, cv.n)), val, np.asarray(c, dtype=float))


def to_image(cv: Canvas) -> Image.Image:
    rgb = np.clip(cv.rgb, 0, 1)
    if cv.a is None:
        im = Image.fromarray((rgb * 255 + 0.5).astype(np.uint8), "RGB")
    else:
        a = np.clip(cv.a, 0, 1)
        # Stored premultiplied against black; un-premultiply for RGBA.
        un = np.where(a[..., None] > 1e-4, rgb / np.maximum(a[..., None], 1e-4), 0)
        im = Image.fromarray(np.dstack([np.clip(un, 0, 1) * 255, a * 255]).astype(np.uint8), "RGBA")
    return im.resize((N, N), Image.LANCZOS)


def lift_off(cv: Canvas) -> Image.Image:
    """RGBA from a painting on BG: brighter pixels keep their colour, darker ones become black."""
    rgb = np.clip(cv.rgb, 0, 1)
    bg = BG[None, None, :]
    up = np.max((rgb - bg) / (1 - bg), axis=2)
    down = np.max((bg - rgb) / bg, axis=2)
    a = np.clip(np.maximum(up, down), 0, 1)
    safe = np.maximum(a, 1e-4)[..., None]
    col = np.where((up >= down)[..., None], (rgb - bg * (1 - safe)) / safe, 0)
    out = np.dstack([np.clip(col, 0, 1) * 255, a * 255]).astype(np.uint8)
    return Image.fromarray(out, "RGBA").resize((N, N), Image.LANCZOS)


# --- Variants ----------------------------------------------------------------

def coral_rgb():
    return np.array([0xD9, 0x77, 0x57]) / 255.0


def variant_hero(mood="happy") -> Image.Image:
    """A: Tappy, big and centred, glowing on the dot grid."""
    n = N * SS
    cv = Canvas(n)
    radial(cv, n / 2, n * 0.5, n * 0.42, coral_rgb(), 0.16)
    dot_grid(cv, 64 * SS, 2.2 * SS, 0.07, fade_from=(n / 2, n / 2, n * 0.35))
    size = 980
    data = frame(size, mood, CORAL)
    scale = (n * 0.9) / size
    paint_tappy(cv, data, (n - size * scale) / 2, (n - size * scale) / 2 + n * 0.015, scale)
    return to_image(cv)


def variant_peek() -> Image.Image:
    """B: Tappy rising over the bottom edge like a sun, a horizon of lit dots."""
    n = N * SS
    cv = Canvas(n)
    radial(cv, n / 2, n * 0.78, n * 0.55, coral_rgb(), 0.22)
    dot_grid(cv, 64 * SS, 2.2 * SS, 0.06, fade_from=(n / 2, n * 0.7, n * 0.45))
    size = 1200
    data = frame(size, "happy", CORAL)
    scale = (n * 1.12) / size
    paint_tappy(cv, data, (n - size * scale) / 2, n * 0.2, scale)
    return to_image(cv)


def variant_ring() -> Image.Image:
    """C: Tappy inside a ring of LED dots, like the thinking dial at full."""
    n = N * SS
    cv = Canvas(n)
    radial(cv, n / 2, n / 2, n * 0.45, coral_rgb(), 0.2)
    c = coral_rgb()
    R = n * 0.37
    for i in range(36):
        a = i / 36 * 2 * np.pi - np.pi / 2
        x, y = n / 2 + np.cos(a) * R, n / 2 + np.sin(a) * R
        cv.halo(x, y, 9 * SS, 10 * SS, c, 0.45)
        cv.disc(x, y, 7 * SS, np.minimum(1, c * 1.25), 1)
    size = 900
    data = frame(size, "idle", CORAL)
    scale = (n * 0.7) / size
    paint_tappy(cv, data, (n - size * scale) / 2, (n - size * scale) / 2 + n * 0.01, scale)
    return to_image(cv)


VARIANTS = {"A": lambda: variant_hero("idle"), "B": lambda: variant_hero("happy"), "C": variant_ring}


def squircle_mask(n: int, power: float = 5.0) -> Image.Image:
    """iOS's continuous-corner shape, close enough for a preview (superellipse)."""
    s = 4
    m = n * s
    yy, xx = np.mgrid[0:m, 0:m]
    u = np.abs((xx + 0.5) / m * 2 - 1)
    v = np.abs((yy + 0.5) / m * 2 - 1)
    inside = (u**power + v**power) <= 1
    return Image.fromarray((inside * 255).astype(np.uint8), "L").resize((n, n), Image.LANCZOS)


def preview(images: dict, path: str) -> None:
    """Each variant as the squircle, big and at home-screen size, on a wallpaper."""
    W, H = 1500, 660 * len(images) // 3 + 120
    sheet = Image.new("RGB", (len(images) * 500, 760), (36, 40, 52))
    d = ImageDraw.Draw(sheet)
    for i, (name, im) in enumerate(images.items()):
        x = i * 500 + 50
        big = im.resize((400, 400), Image.LANCZOS)
        sheet.paste(big, (x, 60), squircle_mask(400))
        d.text((x, 20), f"Variant {name}", fill=(235, 235, 245))
        for j, sz in enumerate((120, 76, 60)):
            sm = im.resize((sz, sz), Image.LANCZOS)
            sheet.paste(sm, (x + j * 140, 520 + (120 - sz)), squircle_mask(sz))
    sheet.save(path)


def apply(name: str) -> None:
    icon = VARIANTS[name]()
    icon.save(os.path.join(ASSETS, "icon.png"))
    # Android adaptive: the canvas as background, Tappy alone as foreground,
    # inside the 66% safe zone.
    n = N * SS
    bg = Canvas(n)
    radial(bg, n / 2, n / 2, n * 0.42, coral_rgb(), 0.16)
    dot_grid(bg, 64 * SS, 2.2 * SS, 0.07, fade_from=(n / 2, n / 2, n * 0.35))
    to_image(bg).save(os.path.join(ASSETS, "android-icon-background.png"))
    # Painted on the canvas colour, then lifted off it: each pixel's alpha is
    # how far it is from the canvas, so over the background layer it composes
    # back to exactly what the iOS icon shows (glows and shadow included).
    fg = Canvas(n)
    size = 980
    data = frame(size, "idle", CORAL)
    scale = (n * 0.6) / size
    # No ground shadow: a launcher draws its own under the icon.
    paint_tappy(fg, data, (n - size * scale) / 2, (n - size * scale) / 2, scale, shadow=False)
    fg_img = lift_off(fg)
    fg_img.save(os.path.join(ASSETS, "android-icon-foreground.png"))
    # Monochrome (themed icons): Tappy's silhouette.
    mono = fg_img.split()[3].point(lambda v: 255 if v > 60 else 0)
    Image.merge("RGBA", (mono, mono, mono, mono)).save(os.path.join(ASSETS, "android-icon-monochrome.png"))
    print(f"applied variant {name}")


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--apply":
        apply(sys.argv[2])
    else:
        out = sys.argv[1] if len(sys.argv) > 1 else "."
        imgs = {k: f() for k, f in VARIANTS.items()}
        for k, im in imgs.items():
            im.save(os.path.join(out, f"icon-{k}.png"))
        preview(imgs, os.path.join(out, "icon-preview.png"))
        print("wrote", ", ".join(f"icon-{k}.png" for k in imgs), "and icon-preview.png")
