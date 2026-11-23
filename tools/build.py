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

# ---------- テクスチャの色見本 (64x64 の中に 8x8 マスで並べる) ----------
SWATCH = 8
PALETTE = {
    "black": (38, 38, 42),
    "dark": (70, 70, 78),
    "red": (170, 32, 32),
    "gold": (214, 170, 60),
    "glass": (150, 200, 230),
    "wheel": (110, 30, 30),
    "steel": (140, 140, 150),
    "lamp": (255, 235, 140),
}
SLOT = {name: (i % 8, i // 8) for i, name in enumerate(PALETTE)}


def make_entity_texture(path):
    rnd = random.Random(1)
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    for name, (r, g, b) in PALETTE.items():
        sx, sy = SLOT[name]
        for y in range(SWATCH):
            for x in range(SWATCH):
                edge = x in (0, SWATCH - 1) or y in (0, SWATCH - 1)
                k = 0.8 if edge else 1.0 + rnd.uniform(-0.06, 0.06)
                img.putpixel(
                    (sx * SWATCH + x, sy * SWATCH + y),
                    tuple(max(0, min(255, int(c * k))) for c in (r, g, b)) + (255,),
                )
    img.save(path)


def cube(origin, size, color):
    sx, sy = SLOT[color]
    uv = {"uv": [sx * SWATCH, sy * SWATCH], "uv_size": [SWATCH, SWATCH]}
    faces = {f: dict(uv) for f in ("north", "south", "east", "west", "up", "down")}
    return {"origin": origin, "size": size, "uv": faces}


def make_geometry(path):
    # 長さ方向 = X軸 (+X が前、煙突側)。サイズはトロッコと同程度(約20px)
    cubes = [
        # 台枠
        cube([-10, 4, -5], [20, 2, 10], "dark"),
        # 動輪 (左右)
        *[cube([x, 0, z], [w, w, 1], "wheel")
          for x, w in ((-9, 6), (-2, 6), (5, 4)) for z in (-6, 5)],
        # 連結棒
        cube([-7, 2, -6.5], [11, 1, 0.5], "steel"),
        cube([-7, 2, 6], [11, 1, 0.5], "steel"),
        # ボイラー
        cube([-3, 6, -4], [12, 7, 8], "black"),
        # 金の帯
        cube([2, 5.9, -4.1], [1, 7.2, 8.2], "gold"),
        # 煙室扉
        cube([9, 6, -4], [1, 7, 8], "dark"),
        # 前照灯
        cube([10, 10, -1], [0.5, 2, 2], "lamp"),
        # 煙突
        cube([5.5, 13, -1.5], [3, 5, 3], "black"),
        cube([5, 18, -2], [4, 1.5, 4], "dark"),
        # 蒸気ドーム
        cube([0, 13, -1.5], [3, 2, 3], "gold"),
        # 排障器
        cube([10, 1, -4], [1, 4, 8], "red"),
        # 運転室
        cube([-10, 6, -5], [7, 11, 10], "red"),
        cube([-11, 17, -6], [9, 1, 12], "black"),
        # 窓
        cube([-8.5, 12, -5.1], [4, 3.5, 0.1], "glass"),
        cube([-8.5, 12, 5], [4, 3.5, 0.1], "glass"),
        cube([-3.1, 12, -4], [0.1, 3.5, 3], "glass"),
        cube([-3.1, 12, 1], [0.1, 3.5, 3], "glass"),
    ]
    geo = {
        "format_version": "1.12.0",
        "minecraft:geometry": [
            {
                "description": {
                    "identifier": "geometry.senro_steam_locomotive",
                    "texture_width": 64,
                    "texture_height": 64,
                    "visible_bounds_width": 3,
                    "visible_bounds_height": 2.5,
                    "visible_bounds_offset": [0, 0.75, 0],
                },
                "bones": [{"name": "body", "pivot": [0, 0, 0], "cubes": cubes}],
            }
        ],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(geo, f, indent=2)


# ---------- アイテムアイコン (16x16 ドット絵) ----------
ICON = [
    "................",
    "................",
    "..........kk....",
    "...rrrrr..kk....",
    "...kkkkk.kkkk...",
    "...rggrr........",
    "...rggrr.y......",
    "...rrrrrkkkkkkd.",
    "...rrrrrkkkGkkdl",
    "...rrrrrkkkGkkd.",
    "..dddddddddddddd",
    "..wwww.wwww..ww.",
    ".wwssww.wsww.ww.",
    "..wwww.wwww.....",
    "................",
    "................",
]
ICON_COLORS = {
    "k": PALETTE["black"], "d": PALETTE["dark"], "r": PALETTE["red"],
    "g": PALETTE["glass"], "G": PALETTE["gold"], "y": PALETTE["gold"],
    "w": PALETTE["wheel"], "s": PALETTE["steel"], "l": PALETTE["lamp"],
}


def make_icon(path, scale=1):
    img = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    for y, row in enumerate(ICON):
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
