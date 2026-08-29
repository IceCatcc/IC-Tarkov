# -*- coding: utf-8 -*-
"""生成 public/data/map-bosses.json（每张地图的 Boss 刷新率）。

输入：
  quest_analysis/_maps_api.json   json.tarkov.dev/regular/maps
  quest_analysis/_maps_zh.json    json.tarkov.dev/regular/maps_zh（名称翻译）
输出：
  public/data/map-bosses.json     按 normalizedName 索引的 Boss 列表

同一 Boss 在同一地图可能出现多条（不同刷新点/触发条件），这里合并为一条，
刷新率取最大值（更接近玩家感知的“本局遇到概率”）。
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "quest_analysis", "_maps_api.json")
ZH = os.path.join(ROOT, "quest_analysis", "_maps_zh.json")
OUT = os.path.join(ROOT, "public", "data", "map-bosses.json")


def main() -> int:
    if not os.path.exists(SRC):
        print("缺少输入文件：", SRC)
        return 1
    with open(SRC, encoding="utf-8") as f:
        maps = json.load(f)["data"]["maps"]
    zh = {}
    if os.path.exists(ZH):
        with open(ZH, encoding="utf-8") as f:
            zh = json.load(f)["data"]

    out: dict[str, list[dict]] = {}
    for _id, m in maps.items():
        nn = m.get("normalizedName")
        if not nn:
            continue
        merged: dict[str, dict] = {}
        for b in m.get("bosses") or []:
            mob = b.get("mob")
            if not mob:
                continue
            chance = b.get("spawnChance") or 0
            locs = b.get("spawnLocations") or []
            cur = merged.get(mob)
            if cur is None:
                merged[mob] = {
                    "id": mob,
                    "name": mob,
                    "nameZh": zh.get(mob) or mob,
                    "chance": chance,
                    "locations": len(locs),
                }
            else:
                cur["chance"] = max(cur["chance"], chance)
                cur["locations"] += len(locs)
        if merged:
            out[nn] = sorted(merged.values(), key=lambda x: -x["chance"])

    doc = {
        "version": 1,
        "source": "json.tarkov.dev/regular/maps",
        "maps": out,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print("已生成", OUT, "地图数:", len(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
