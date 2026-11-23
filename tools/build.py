"""汽車のモデル・アイコンを生成し、dist/senro.mcaddon を作る。

使い方: python3 tools/build.py

見た目はすべてバニラのテクスチャ(トロッコ・オークの板材・原木・かまど・石炭ブロック・
レッドストーンランプ)をそのまま使う。テクスチャパックを入れていればそれに合わせて変わる。
テクスチャごとに別のジオメトリ＋レンダーコントローラーで描く。
"""
import json
import os
import zipfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BP = os.path.join(ROOT, "packs", "BP")
RP = os.path.join(ROOT, "packs", "RP")

# 使うテクスチャ (キー → パス)。furnace 以外はバニラのものをそのまま使う
TEXTURES = {
    "planks": "textures/blocks/planks_oak",
    "log": "textures/blocks/log_oak",
    "furnace": "textures/entity/senro_furnace",  # 自作 (tools/src のかまどを縮めて作る)
    "coal": "textures/blocks/coal_block",
    "lamp": "textures/blocks/redstone_lamp_on",
    "iron": "textures/blocks/iron_block",
    "gold": "textures/blocks/gold_block",
}


def box(x0, x1, y0, y1, z0, z1):
    return (x0, x1, y0, y1, z0, z1)


# 機関車の部品。長さ方向 = X軸 (+X が前) で書く。
# トロッコの箱: 外側 X ±10, Z ±8, 縁の上端 y=10.5、内側 X ±8, Z ±6。
# 部品どうしは必ず面で接するように置いて、隙間を作らない。
# 前半分 (x 2〜10) がかまど、後ろ半分 (x -10〜2) が屋根付きの運転台。
# かまどの焚き口(火の見える面)は運転台側だけに向ける。
PARTS = {
    "planks": [
        box(-8, 2, 9.5, 10.5, -6, 6),  # 運転台の床 (トロッコの箱にはめる、縁と同じ高さ)
        box(-8.5, 0.5, 16, 17, -8, -7),  # 手すり (左右・後ろ)
        box(-8.5, 0.5, 16, 17, 7, 8),
        box(-10, -9, 16, 17, -6.5, 6.5),
        box(-11, 2.5, 28, 29.5, -9, 9),  # 屋根
    ],
    "log": [
        box(x0, x0 + 1.5, 10.5, 28, z0, z0 + 1.5)  # 柱 4本 (トロッコの縁〜屋根)
        for x0 in (-10, 0.5) for z0 in (-8, 6.5)
    ],
    "coal": [
        box(4.5, 7.5, 22.5, 30, -1.5, 1.5),  # 煙突
        box(3.5, 8.5, 30, 32, -2.5, 2.5),  # 煙突の先
    ],
    # 前半分: 小さめのかまど (幅12・高さ12・長さ8)。トロッコの箱の口にはめて縁の高さに載せる
    "furnace": [box(2, 10, 10.5, 22.5, -6, 6)],
    "lamp": [box(10, 11.5, 17, 20, -1.5, 1.5)],  # 前照灯
}

# 補助機関車: 運転台なし。トロッコの上に鉄のボイラーを横に寝かせた、背の低い機関車
BOOSTER_PARTS = {
    "planks": [box(-8, 8, 9.5, 10.5, -6, 6)],  # トロッコの箱にはめた床
    "iron": [box(-8, 8, 10.5, 19, -4.5, 4.5)],  # ボイラー
    "coal": [
        box(-5, -4, 10.4, 19.1, -4.6, 4.6),  # ボイラーの帯
        box(3, 4, 10.4, 19.1, -4.6, 4.6),
        box(4.5, 7, 19, 25, -1.25, 1.25),  # 煙突
        box(4, 7.5, 25, 26.5, -1.75, 1.75),
    ],
    "gold": [box(-2, 1, 19, 21, -1.5, 1.5)],  # 蒸気ドーム
    "lamp": [
        box(8, 9.5, 13, 15.5, -1.25, 1.25),  # 前後のランプ
        box(-9.5, -8, 13, 15.5, -1.25, 1.25),
    ],
}

# 乗り物ごとの部品一覧 (エンティティ名 → (ジオメトリ名の接頭辞, 部品))
VEHICLES = {
    "steam_locomotive": ("loco", PARTS),
    "booster_locomotive": ("booster", BOOSTER_PARTS),
}


# ---------- かまどのテクスチャ ----------
# バニラのかまど(16x16)から行と列を間引いて、面の大きさぴったりの絵を作り、
# 1枚の画像(32x32)にまとめる。面ごとに等倍で貼るので、伸びたり欠けたりしない。
SRC = os.path.join(ROOT, "tools", "src")
KEEP12 = [0, 1, 3, 4, 6, 7, 9, 10, 11, 12, 14, 15]  # 16→12 (端の枠は残す)
KEEP8 = [0, 1, 3, 6, 9, 12, 14, 15]  # 16→8
FURNACE_UV = {  # 面 → 画像内の位置 [u, v] と大きさ [w, h]
    "front": ([0, 0], [12, 12]),  # 運転台側: 火の見える焚き口
    "side12": ([12, 0], [12, 12]),  # 前側
    "side8": ([24, 0], [8, 12]),  # 左右
    "top": ([0, 12], [12, 8]),  # 上下
}


def shrink(img, cols, rows):
    out = Image.new("RGBA", (len(cols), len(rows)))
    for y, sy in enumerate(rows):
        for x, sx in enumerate(cols):
            out.putpixel((x, y), img.getpixel((sx, sy)))
    return out


def make_furnace_texture(path):
    front = Image.open(os.path.join(SRC, "furnace_front_on.png")).convert("RGBA")
    side = Image.open(os.path.join(SRC, "furnace_side.png")).convert("RGBA")
    top = Image.open(os.path.join(SRC, "furnace_top.png")).convert("RGBA")
    atlas = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    atlas.paste(shrink(front, KEEP12, KEEP12), (0, 0))
    atlas.paste(shrink(side, KEEP12, KEEP12), (12, 0))
    atlas.paste(shrink(side, KEEP8, KEEP12), (24, 0))
    atlas.paste(shrink(top, KEEP12, KEEP8), (0, 12))
    atlas.save(path)


def furnace_cube(b):
    cube = to_cube(b)
    uv = lambda k: {"uv": FURNACE_UV[k][0], "uv_size": FURNACE_UV[k][1]}
    # 回転後: north = 汽車の前、south = 運転台側、east/west = 左右
    cube["uv"] = {
        "north": uv("side12"), "south": uv("front"),
        "east": uv("side8"), "west": uv("side8"),
        "up": uv("top"), "down": uv("top"),
    }
    return cube


def to_cube(b):
    """X長手の箱を、トロッコの進行方向(モデルのZ軸)に90度回して、面ごとのUVを付ける。"""
    x0, x1, y0, y1, z0, z1 = b
    # 前 +X → -Z (北向き = エンティティの正面)
    nx0, nx1, nz0, nz1 = z0, z1, -x1, -x0
    w, h, d = nx1 - nx0, y1 - y0, nz1 - nz0

    def face(a, b_):
        # テクスチャ(16x16)の真ん中から、面の大きさぶん切り取る (等倍で貼る)
        a2, b2 = min(a, 16), min(b_, 16)
        return {"uv": [(16 - a2) / 2, (16 - b2) / 2], "uv_size": [a2, b2]}

    faces = {}
    if w and h:
        faces["north"] = face(w, h)
        faces["south"] = face(w, h)
    if d and h:
        faces["east"] = face(d, h)
        faces["west"] = face(d, h)
    if w and d:
        faces["up"] = face(w, d)
        faces["down"] = face(w, d)
    return {"origin": [nx0, y0, nz0], "size": [w, h, d], "uv": faces}


def geometry_file(identifier, tex_w, tex_h, bones):
    return {
        "format_version": "1.12.0",
        "minecraft:geometry": [
            {
                "description": {
                    "identifier": identifier,
                    "texture_width": tex_w,
                    "texture_height": tex_h,
                    "visible_bounds_width": 3,
                    "visible_bounds_height": 3,
                    "visible_bounds_offset": [0, 1, 0],
                },
                "bones": bones,
            }
        ],
    }


def make_part_geometries():
    for name, (prefix, parts) in VEHICLES.items():
        geos = []
        for key, boxes in parts.items():
            size = 32 if key == "furnace" else 16
            make = furnace_cube if key == "furnace" else to_cube
            geo = geometry_file(
                f"geometry.senro_{prefix}_{key}", size, size,
                # 向きのアニメーションは "body" の骨を回す
                [{"name": "body", "pivot": [0, 0, 0], "cubes": [make(b) for b in boxes]}],
            )
            geos += geo["minecraft:geometry"]
        path = os.path.join(RP, "models", "entity", f"{name}.geo.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"format_version": "1.12.0", "minecraft:geometry": geos}, f, indent=2)


# ---------- 下回り: バニラのトロッコ (geometry.minecart と同じ形) ----------
def make_cart_geometry(path):
    dy = -18.5  # バニラのアニメーションと同じ高さ補正
    parts = [
        ("bottom", [0, 20, 0], [90, 0, 0], [-10, 12, -1], [20, 16, 2], [0, 10]),
        ("back", [-9, 20, 0], [0, 270, 0], [-17, 21, -1], [16, 8, 2], [0, 0]),
        ("front", [9, 20, 0], [0, 90, 0], [1, 21, -1], [16, 8, 2], [0, 0]),
        ("right", [0, 20, -7], [0, 180, 0], [-8, 21, -8], [16, 8, 2], [0, 0]),
        ("left", [0, 20, 7], [0, 0, 0], [-8, 21, 6], [16, 8, 2], [0, 0]),
    ]
    bones = [
        {"name": "body", "pivot": [0, 0, 0]},
        {"name": "cart", "parent": "body", "pivot": [0, 0, 0], "rotation": [0, 90, 0]},
    ]
    for name, pivot, rot, origin, size, uv in parts:
        bones.append({
            "name": name,
            "parent": "cart",
            "pivot": [pivot[0], pivot[1] + dy, pivot[2]],
            "rotation": rot,
            "cubes": [{"origin": [origin[0], origin[1] + dy, origin[2]], "size": size, "uv": uv}],
        })
    with open(path, "w", encoding="utf-8") as f:
        json.dump(geometry_file("geometry.senro_locomotive_cart", 64, 32, bones), f, indent=2)


def part_controller(key):
    return {
        "geometry": f"Geometry.{key}",
        "materials": [{"*": "Material.default"}],
        "textures": [f"Texture.{key}"],
    }


def make_client_files():
    # レンダーコントローラーは部品の種類ごとに1つ作り、乗り物どうしで共有する
    controllers = {"controller.render.senro_part_cart": part_controller("cart")}
    for key in TEXTURES:
        controllers[f"controller.render.senro_part_{key}"] = part_controller(key)
    with open(os.path.join(RP, "render_controllers", "senro_locomotive.render_controllers.json"), "w", encoding="utf-8") as f:
        json.dump({"format_version": "1.8.0", "render_controllers": controllers}, f, indent=2)

    for name, (prefix, parts) in VEHICLES.items():
        textures = {"cart": "textures/entity/minecart"}
        geometry = {"cart": "geometry.senro_locomotive_cart"}
        for key in parts:
            textures[key] = TEXTURES[key]
            geometry[key] = f"geometry.senro_{prefix}_{key}"
        entity = {
            "format_version": "1.10.0",
            "minecraft:client_entity": {
                "description": {
                    "identifier": f"senro:{name}",
                    "materials": {"default": "entity_alphatest"},
                    "textures": textures,
                    "geometry": geometry,
                    "animations": {"yaw": "animation.senro_steam_locomotive.yaw"},
                    "scripts": {"animate": ["yaw"]},
                    "render_controllers": ["controller.render.senro_part_cart"]
                    + [f"controller.render.senro_part_{key}" for key in parts],
                }
            },
        }
        with open(os.path.join(RP, "entity", f"{name}.entity.json"), "w", encoding="utf-8") as f:
            json.dump(entity, f, indent=2, ensure_ascii=False)


# ---------- アイテムアイコン (16x16 ドット絵、右が前) ----------
COLORS = {
    "I": (166, 166, 170),  # トロッコの鉄
    "D": (84, 84, 90),  # 暗い鉄
    "P": (162, 130, 78),  # 板材
    "L": (104, 82, 50),  # 原木
    "F": (118, 118, 118),  # かまど
    "f": (230, 140, 40),  # 火
    "C": (30, 30, 32),  # 石炭
    "Y": (250, 214, 120),  # ランプ
    "S": (220, 220, 224),  # 鉄ブロック
    "G": (240, 200, 60),  # 金
}
ICON = [
    "..........CCCC..",
    "...........CC...",
    ".PPPPPPPPP.CC...",
    ".L......LFFFFFF.",
    ".L......LfFFFFFY",
    ".L......LfFFFFF.",
    ".LPPPPPPLFFFFFF.",
    ".L......LFFFFFF.",
    ".L......LFFFFFF.",
    ".L......LFFFFFF.",
    "DDDDDDDDDDDDDDDD",
    ".IIIIIIIIIIIIII.",
    ".IIIIIIIIIIIIII.",
    ".IIIIIIIIIIIIII.",
    "..DD........DD..",
    "................",
]
LEVER_ICON = [
    "................",
    "..........YY....",
    ".........YYYY...",
    ".........YYYY...",
    "..........YY....",
    ".........DD.....",
    "........DD......",
    ".......DD.......",
    "......DD........",
    ".....DD.........",
    "...DDDDDDDD.....",
    "...DPPPPPPD.....",
    "...DPPPPPPD.....",
    "...DDDDDDDD.....",
    "................",
    "................",
]

BOOSTER_ICON = [
    "................",
    "................",
    "................",
    ".........CCCC...",
    "..........CC....",
    "......GG..CC....",
    "..SSCSSSSSCSSS..",
    ".YSSCSSSSSCSSSY.",
    "..SSCSSSSSCSSS..",
    "..SSCSSSSSCSSS..",
    "DDDDDDDDDDDDDDDD",
    ".IIIIIIIIIIIIII.",
    ".IIIIIIIIIIIIII.",
    ".IIIIIIIIIIIIII.",
    "..DD........DD..",
    "................",
]

COUPLER_ICON = [
    "................",
    "................",
    "..DDDD..........",
    ".DIIIID.........",
    ".ID..DI.........",
    ".ID..DIDDDD.....",
    ".DIIIIIIIIID....",
    "..DDDDIDDDDI....",
    "......ID..DI....",
    "......DIIIID....",
    ".......DDDDIDDD.",
    "..........DIIIID",
    "..........ID..DI",
    "..........DIIIID",
    "...........DDDD.",
    "................",
]


def make_icon(path, scale=1, pattern=ICON):
    img = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    for y, row in enumerate(pattern):
        for x, ch in enumerate(row):
            if ch in COLORS:
                img.putpixel((x, y), COLORS[ch] + (255,))
    if scale != 1:
        img = img.resize((16 * scale, 16 * scale), Image.NEAREST)
    img.save(path)


def zip_dir(zf, src, arc_prefix):
    for base, _, files in os.walk(src):
        for name in sorted(files):
            full = os.path.join(base, name)
            zf.write(full, os.path.join(arc_prefix, os.path.relpath(full, src)))


def main():
    os.makedirs(os.path.join(RP, "textures", "entity"), exist_ok=True)
    make_furnace_texture(os.path.join(RP, "textures", "entity", "senro_furnace.png"))
    make_part_geometries()
    make_cart_geometry(os.path.join(RP, "models", "entity", "steam_locomotive_cart.geo.json"))
    make_client_files()
    make_icon(os.path.join(RP, "textures", "items", "steam_locomotive.png"))
    make_icon(os.path.join(RP, "textures", "items", "throttle.png"), pattern=LEVER_ICON)
    make_icon(os.path.join(RP, "textures", "items", "coupler.png"), pattern=COUPLER_ICON)
    make_icon(os.path.join(RP, "textures", "items", "booster_locomotive.png"), pattern=BOOSTER_ICON)
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
