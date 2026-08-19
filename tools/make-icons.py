#!/usr/bin/env python3
"""icons/icon.svg と同じ図柄の PNG アイコンを生成する。

外部ライブラリを使わずに済むよう、図形を直接ラスタライズして PNG を書き出す。
    python3 tools/make-icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

SIZE = 512  # 図形の座標系（icon.svg の viewBox と同じ）
SAMPLES = 3  # 1 ピクセルあたりの supersampling 数

BG_TOP = (59, 130, 246)
BG_BOTTOM = (29, 78, 216)
WHITE = (255, 255, 255)

FRAME = (112, 132, 400, 348, 28)  # x0, y0, x1, y1, radius
SUN = (176, 200, 22)  # cx, cy, r
MOUNTAIN = [(128, 336), (214, 230), (268, 298), (312, 258), (384, 336)]
ARROW_SHAFT = (232, 356, 280, 402)
ARROW_HEAD = [(208, 392), (304, 392), (256, 452)]


def inside_round_rect(x, y, x0, y0, x1, y1, radius):
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + radius), x1 - radius)
    cy = min(max(y, y0 + radius), y1 - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius**2


def inside_circle(x, y, cx, cy, r):
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def inside_polygon(x, y, points):
    inside = False
    for i in range(len(points)):
        x0, y0 = points[i]
        x1, y1 = points[(i + 1) % len(points)]
        if (y0 > y) != (y1 > y):
            cross = x0 + (y - y0) * (x1 - x0) / (y1 - y0)
            if x < cross:
                inside = not inside
    return inside


def sample(x, y):
    """図形の重ね順に従って、その座標の色（RGBA）を返す"""
    if not inside_round_rect(x, y, 0, 0, SIZE, SIZE, SIZE * 0.22):
        return (0, 0, 0, 0)
    t = y / SIZE
    background = tuple(round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))

    if inside_polygon(x, y, ARROW_HEAD) or inside_round_rect(x, y, *ARROW_SHAFT, 6):
        return (*WHITE, 255)
    if inside_round_rect(x, y, *FRAME):
        if inside_circle(x, y, *SUN) or inside_polygon(x, y, MOUNTAIN):
            return (*background, 255)
        return (*WHITE, 255)
    return (*background, 255)


def render(size: int) -> bytes:
    scale = SIZE / size
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    color = sample((px + (sx + 0.5) / SAMPLES) * scale, (py + (sy + 0.5) / SAMPLES) * scale)
                    r += color[0] * color[3]
                    g += color[1] * color[3]
                    b += color[2] * color[3]
                    a += color[3]
            if a == 0:
                row += bytes(4)
            else:
                row += bytes((round(r / a), round(g / a), round(b / a), round(a / (SAMPLES * SAMPLES))))
        rows.append(bytes(row))
    return png(size, size, rows)


def png(width: int, height: int, rows: list[bytes]) -> bytes:
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "icons"
    out.mkdir(exist_ok=True)
    for size in (180, 192, 512):
        path = out / f"icon-{size}.png"
        path.write_bytes(render(size))
        print(f"wrote {path.relative_to(path.parent.parent)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
