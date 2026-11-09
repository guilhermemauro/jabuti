"""Looks at images for an agent (C21): view_images runs this in the agent's sandbox.

    images.py mosaic OUT -- SOURCE...

Each SOURCE is a web address (http or https) or a file of the workspace. The images
are laid out in one numbered grid, saved as JPEG at OUT, small enough for a model to
read. One image alone is only scaled down, so its details stay visible. Prints one
JSON object: the mosaic and what each source turned out to be.
"""

import io
import json
import math
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image, ImageDraw, ImageFont, ImageOps

# Refuse decompression bombs early: no real photo or thumbnail is this large.
Image.MAX_IMAGE_PIXELS = 60_000_000

MAX_BYTES = 15 * 1024 * 1024
TIMEOUT = 20
# Long side of the whole mosaic: what vision models read without scaling it again.
CANVAS = 1536
TILE_MAX = 512
BACKGROUND = (238, 242, 239)
AGENT = "Mozilla/5.0 (compatible; Jabuti image viewer)"


def fetch(source):
    if source.startswith(("http://", "https://")):
        request = urllib.request.Request(source, headers={"User-Agent": AGENT, "Accept": "image/*"})
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            data = response.read(MAX_BYTES + 1)
    else:
        with open(source, "rb") as file:
            data = file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError(f"over {MAX_BYTES // 1024 // 1024} MB")
    return data


def load(source):
    try:
        data = fetch(source)
        image = Image.open(io.BytesIO(data))
        image.load()
        kind = image.format or "?"
        image = ImageOps.exif_transpose(image)
        if image.mode in ("RGBA", "LA", "P"):
            image = image.convert("RGBA")
            flat = Image.new("RGB", image.size, (255, 255, 255))
            flat.paste(image, mask=image.getchannel("A"))
            image = flat
        else:
            image = image.convert("RGB")
        info = {"ok": True, "width": image.width, "height": image.height, "format": kind, "bytes": len(data)}
        return image, info
    except Exception as error:  # Any failure is reported for that source only.
        return None, {"ok": False, "error": str(error)[:200] or type(error).__name__}


def font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow without FreeType: the small bitmap font.
        return ImageFont.load_default()


def mosaic(images):
    present = [(n, image) for n, image in images if image is not None]
    if len(images) == 1 and present:
        image = present[0][1].copy()
        image.thumbnail((CANVAS, CANVAS))
        return image, 1
    columns = math.ceil(math.sqrt(len(images)))
    rows = math.ceil(len(images) / columns)
    tile = min(TILE_MAX, CANVAS // columns)
    gap = 6
    canvas = Image.new("RGB", (columns * (tile + gap) + gap, rows * (tile + gap) + gap), BACKGROUND)
    draw = ImageDraw.Draw(canvas)
    label = font(max(14, tile // 12))
    for index, (n, image) in enumerate(images):
        x = gap + (index % columns) * (tile + gap)
        y = gap + (index // columns) * (tile + gap)
        if image is not None:
            thumb = image.copy()
            thumb.thumbnail((tile, tile))
            canvas.paste(thumb, (x + (tile - thumb.width) // 2, y + (tile - thumb.height) // 2))
        else:
            draw.text((x + tile // 3, y + tile // 2), "failed", fill=(120, 120, 120), font=label)
        box = draw.textbbox((x + 4, y + 4), str(n), font=label)
        draw.rectangle((box[0] - 4, box[1] - 3, box[2] + 4, box[3] + 3), fill=(18, 82, 56))
        draw.text((x + 4, y + 4), str(n), fill=(255, 255, 255), font=label)
    return canvas, columns


def main(argv):
    if len(argv) < 4 or argv[0] != "mosaic" or argv[2] != "--":
        print("usage: images.py mosaic OUT -- SOURCE...", file=sys.stderr)
        return 2
    out, sources = argv[1], argv[3:]
    with ThreadPoolExecutor(max_workers=6) as pool:
        loaded = list(pool.map(load, sources))
    items = [{"n": n, "source": source, **info} for n, (source, (_, info)) in enumerate(zip(sources, loaded), 1)]
    if not any(info["ok"] for _, info in loaded):
        print(json.dumps({"mosaic": None, "items": items}))
        return 1
    canvas, columns = mosaic([(n, image) for n, (image, _) in enumerate(loaded, 1)])
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    canvas.save(out, "JPEG", quality=82)
    print(json.dumps({"mosaic": out, "width": canvas.width, "height": canvas.height, "columns": columns, "items": items}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
