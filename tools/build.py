"""汽車のモデル・テクスチャを生成し、dist/senro.mcaddon を作る。

使い方: python3 tools/build.py
"""
import json
import os
import random
import zipfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BP = os.path.join(ROOT, "packs", "BP")
RP = os.path.join(ROOT, "packs", "RP")

# ---------- テクスチャ (64x64 の中に 8x8 の素材マスを並べる) ----------
SWATCH = 8
PALETTE = {
    "iron": (168, 168, 172),  # トロッコと同じ明るい鉄
    "dark_iron": (72, 74, 80),
    "plank": (160, 114, 64),  # 木の板
    "dark_wood": (98, 66, 36),
    "coal": (34, 34, 36),
    "lamp": (255, 228, 130),
    "wheel": (48, 48, 54),
    "glass": (70, 92, 110),
}
SLOT = {name: (i % 8, i // 8) for i, name in enumerate(PALETTE)}


def shade(c, k):
    return tuple(max(0, min(255, int(v * k))) for v in c) + (255,)


def swatch_pixel(name, x, y, rnd):
    base = PALETTE[name]
    n = rnd.uniform(-0.05, 0.05)
    if name in ("iron", "dark_iron"):
        # 縁を暗く、四隅にリベット
        if (x, y) in ((1, 1), (6, 1), (1, 6), (6, 6)):
            return shade(base, 1.25)
        if x in (0, 7) or y in (0, 7):
            return shade(base, 0.78)
        return shade(base, 1.0 + n)
    if name in ("plank", "dark_wood"):
        # 板の継ぎ目(横線)と木目
        if y in (3, 7):
            return shade(base, 0.7)
        if (x + y * 3) % 7 == 0:
            return shade(base, 0.88)
        return shade(base, 1.0 + n)
    if name == "coal":
        return shade(base, 1.6 if rnd.random() < 0.15 else 1.0 + n)
    if x in (0, 7) or y in (0, 7):
        return shade(base, 0.8)
    return shade(base, 1.0 + n)


def make_entity_texture(path):
    rnd = random.Random(1)
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    for name in PALETTE:
        sx, sy = SLOT[name]
        for y in range(SWATCH):
            for x in range(SWATCH):
                img.putpixel((sx * SWATCH + x, sy * SWATCH + y), swatch_pixel(name, x, y, rnd))
    img.save(path)


def cube(origin, size, color):
    sx, sy = SLOT[color]
    uv = {"uv": [sx * SWATCH, sy * SWATCH], "uv_size": [SWATCH, SWATCH]}
    faces = {f: dict(uv) for f in ("north", "south", "east", "west", "up", "down")}
    return {"origin": origin, "size": size, "uv": faces}


def box(x0, x1, y0, y1, z0, z1, color):
    return cube([x0, y0, z0], [x1 - x0, y1 - y0, z1 - z0], color)


def make_geometry(path):
    # 長さ方向 = X軸 (+X が前、煙突側) で組んでから、最後に回す。
    # 高さは煙突の先まで 32px = 2ブロック (ドアと同じ)。
    cubes = [
        # --- 下回り: トロッコと同じ鉄の箱 (20x16) ---
        box(-10, 10, 1, 10, -8, 8, "iron"),
        box(-10.2, 10.2, 9, 10, -8.2, 8.2, "dark_iron"),  # 縁
        *[box(x0, x0 + 4, 0, 3.5, z0, z0 + 0.6, "wheel")  # 車輪
          for x0 in (-8, 4) for z0 in (-8.6, 8)],
        box(-10.8, -10, 3, 5, -5, -3, "dark_iron"),  # 後ろの緩衝器
        box(-10.8, -10, 3, 5, 3, 5, "dark_iron"),
        box(10, 11.5, 0.5, 4, -6, 6, "dark_iron"),  # 排障器

        # --- 後ろ: 石炭の積まれた木の炭水車 ---
        box(-10, -5, 10, 15, -7, 7, "plank"),
        box(-9.5, -5.5, 15, 16, -6.5, 6.5, "coal"),

        # --- 真ん中: 運転室 (横が開いていて、乗っても前が見える) ---
        box(-5, 3, 10, 15, -7.5, -6.5, "plank"),  # 腰板
        box(-5, 3, 10, 15, 6.5, 7.5, "plank"),
        *[box(x0, x0 + 1, 15, 28, z0, z0 + 1, "dark_wood")  # 柱
          for x0 in (-5, 2) for z0 in (-7.5, 6.5)],
        box(-5.5, 3.5, 28, 29, -8, 8, "dark_iron"),  # 鉄の屋根
        box(-5, 3, 29, 29.5, -6.5, 6.5, "dark_iron"),

        # --- 前: 木の板を巻いて鉄の帯で締めたボイラー ---
        box(3, 9.5, 10, 19, -4.5, 4.5, "plank"),
        box(3, 9.5, 19, 20, -3.5, 3.5, "plank"),  # 丸みの代わり
        box(4, 5, 9.9, 20.1, -4.6, 4.6, "dark_iron"),
        box(7, 8, 9.9, 20.1, -4.6, 4.6, "dark_iron"),
        box(9.5, 10.5, 10, 19, -4.5, 4.5, "dark_iron"),  # 煙室
        box(3.5, 5.5, 20, 22, -1.5, 1.5, "iron"),  # 蒸気ドーム
        box(6, 8.5, 20, 29, -1.25, 1.25, "dark_iron"),  # 煙突
        box(5.25, 9.25, 29, 32, -2, 2, "dark_iron"),
        box(10.5, 11.5, 19, 22, -1.5, 1.5, "lamp"),  # ランプ
        box(10.4, 11.6, 22, 22.5, -1.7, 1.7, "dark_iron"),
    ]
    # トロッコの進行方向はモデルのZ軸なので90度回す (前 +X → -Z、北向き = エンティティの正面)
    for c in cubes:
        (x, y, z), (w, h, d) = c["origin"], c["size"]
        c["origin"] = [z, y, -(x + w)]
        c["size"] = [d, h, w]
    geo = {
        "format_version": "1.12.0",
        "minecraft:geometry": [
            {
                "description": {
                    "identifier": "geometry.senro_steam_locomotive",
                    "texture_width": 64,
                    "texture_height": 64,
                    "visible_bounds_width": 3,
                    "visible_bounds_height": 3,
                    "visible_bounds_offset": [0, 1, 0],
                },
                "bones": [{"name": "body", "pivot": [0, 0, 0], "cubes": cubes}],
            }
        ],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(geo, f, indent=2)


# ---------- アイテムアイコン (16x16 ドット絵) ----------
ICON = [
    "...........KK...",
    "...KKKKKKK.KK...",
    "...D.....D.KK...",
    "...D.....D.KK...",
    "...D.....D.KK...",
    "...D.....D.KK.L.",
    "...D.....DPKPKL.",
    ".CCPPPPPPPPKPKD.",
    ".PPPPPPPPPPKPKD.",
    ".PPPPPPPPPPKPKD.",
    "KKKKKKKKKKKKKKKK",
    ".IIIIIIIIIIIIII.",
    ".IIIIIIIIIIIIII.",
    ".IIIIIIIIIIIIII.",
    "..WW.......WW...",
    "................",
]
ICON_COLORS = {
    "K": PALETTE["dark_iron"], "I": PALETTE["iron"], "P": PALETTE["plank"],
    "D": PALETTE["dark_wood"], "C": PALETTE["coal"], "L": PALETTE["lamp"],
    "W": PALETTE["wheel"],
}

LEVER_ICON = [
    "................",
    "..........LL....",
    ".........LLLL...",
    ".........LLLL...",
    "..........LL....",
    ".........KK.....",
    "........KK......",
    ".......KK.......",
    "......KK........",
    ".....KK.........",
    "...KKKKKKKK.....",
    "...KPPPPPPK.....",
    "...KPPPPPPK.....",
    "...KKKKKKKK.....",
    "................",
    "................",
]


def make_icon(path, scale=1, pattern=ICON):
    img = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    for y, row in enumerate(pattern):
        for x, ch in enumerate(row):
            if ch in ICON_COLORS:
                img.putpixel((x, y), ICON_COLORS[ch] + (255,))
    if scale != 1:
        img = img.resize((16 * scale, 16 * scale), Image.NEAREST)
    img.save(path)


def zip_dir(zf, src, arc_prefix):
    for base, _, files in os.walk(src):
        for name in sorted(files):
            full = os.path.join(base, name)
            zf.write(full, os.path.join(arc_prefix, os.path.relpath(full, src)))


def main():
    make_entity_texture(os.path.join(RP, "textures", "entity", "senro_steam_locomotive.png"))
    make_geometry(os.path.join(RP, "models", "entity", "steam_locomotive.geo.json"))
    make_icon(os.path.join(RP, "textures", "items", "steam_locomotive.png"))
    make_icon(os.path.join(RP, "textures", "items", "throttle.png"), pattern=LEVER_ICON)
    make_icon(os.path.join(RP, "pack_icon.png"), scale=8)
    make_icon(os.path.join(BP, "pack_icon.png"), scale=8)

    os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)
    out = os.path.join(ROOT, "dist", "senro.mcaddon")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        zip_dir(zf, BP, "senro_BP")
        zip_dir(zf, RP, "senro_RP")
    print("built", out)


if __name__ == "__main__":
    main()
