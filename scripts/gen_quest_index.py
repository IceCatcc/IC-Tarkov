#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成全量任务索引 F:/CODE/eft-spy/src-tauri/resources/quest_index.json (v4)

v4 变更：
  新增 modes: ["pvp"]/["pve"]/["pvp","pve"] —— 按 regular(=pvp) 与 pve 任务 id 集合差集判定。
  合并 pve 独有任务（23 个，如「赚点快钱 - 1（PVE）」）入索引。
  新增 prereqs_pve: 共有任务在 pve 模式下前置与 pvp 不同时存 pve 版（如 收视灵药）。

v3 变更：
  去掉 mode(common/pvp/pve)——实际差异是新旧任务，不是 PvP/PvE。
  新增 legacy: bool（不在当前赛季 pvp-season 任务列表中 = 旧任务）
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "quest_analysis")
OUT = r"F:/CODE/eft-spy/src-tauri/resources/quest_index.json"
SEASON = os.path.join(SRC, "tasks_season.json")

base   = json.load(open(os.path.join(SRC, "tasks_regular.json"), encoding="utf-8"))["data"]["tasks"]
pve    = json.load(open(os.path.join(SRC, "tasks_pve.json"), encoding="utf-8"))["data"]["tasks"]
season = json.load(open(SEASON, encoding="utf-8"))["data"]["tasks"]
zh   = json.load(open(os.path.join(SRC, "tasks_zh.json"), encoding="utf-8"))["data"]
zh_pve = json.load(open(os.path.join(SRC, "tasks_pve_zh.json"), encoding="utf-8"))["data"]
tr_base = json.load(open(os.path.join(SRC, "traders_regular.json"), encoding="utf-8"))["data"]
tr_zh   = json.load(open(os.path.join(SRC, "traders_zh.json"), encoding="utf-8"))["data"]
items   = json.load(open(os.path.join(SRC, "items_zh.json"), encoding="utf-8"))["data"]
map_meta = json.load(open(os.path.join(ROOT, "src-tauri", "resources", "map_meta.json"), encoding="utf-8"))["maps"]

PVP_IDS = set(base)
PVE_IDS = set(pve)

# 商人忠诚等级 globalVariable -> 商人 映射（数据中共现推导：同一 variableId 唯一对应一个商人）
# 例：火线速递 的 Ragman LL2 在源数据里是 otherRequirements.globalVariable，未进 traderRequirements。
var_to_trader: dict = {}
for _src in (base, season):
    for _t in _src.values():
        _trd = _t.get("trader")
        for _o in (_t.get("otherRequirements") or []):
            if isinstance(_o, dict) and _o.get("type") == "globalVariable":
                _vid = _o.get("variableId")
                if _vid and _trd:
                    var_to_trader.setdefault(_vid, _trd)

# 特殊商人 normalizedName 集合
SPECIAL_TRADERS = {
    "fence", "lightkeeper", "btr-driver", "ref",
    "mr-kerman", "voevoda", "taran", "radio-station", "survivor",
}


def T_of(zh_tab):
    def T(key):
        if not isinstance(key, str):
            return key
        return zh_tab.get(key, key)
    return T


def item_name(iid):
    return items.get((iid or "") + " Name", iid)


def trader_norm(tid):
    return tr_base.get(tid, {}).get("normalizedName", "")


def trader_name(tid):
    e = tr_base.get(tid, {})
    if not e:
        return tid
    return tr_zh.get(e.get("name"), e.get("normalizedName", tid))


OBJ_TYPE_ZH = {
    "giveItem": "上交",
    "placeItem": "放置",
    "markItem": "标记",
    "useItem": "使用",
    "locateQuestItem": "找到",
    "findItem": "寻找",
}

# —— 从任务文本中提取涉及地图 ——
# 同一 id 可能对应多个名称（zh / nn / 别名），按名称长度降序匹配以避免子串误吞。
MAP_NAMES: list[tuple[str, str]] = []
# zh 名称映射：优先完整中文名，再考虑常见简称
_zh_extra = {
    "塔科夫街区": "5714dc692459777137212e12",
    "街区": "5714dc692459777137212e12",
    "储备站": "5704e5fad2720bc05b8b4567",
    "实验室": "5b0fc42d86f7744a585f9105",
    "中心区": "653e6760052c01c1c805532f",
    "中心区 21+": "65b8d6f5cdde2479cb2a3125",
    "夜间工厂": "59fc81d786f774390775787e",
    "破冰船": "69af492a4819ea4ba10a69c5",
    "码头": "65cc8f81a9aac3e77d0cfd3e",
    "迷宫": "6733700029c367a3d40b02af",
}
_nn_extra = {
    "streets-of-tarkov": "5714dc692459777137212e12",
    "streets": "5714dc692459777137212e12",
    "reserve": "5704e5fad2720bc05b8b4567",
    "the-lab": "5b0fc42d86f7744a585f9105",
    "ground-zero": "653e6760052c01c1c805532f",
    "ground-zero-21": "65b8d6f5cdde2479cb2a3125",
    "night-factory": "59fc81d786f774390775787e",
    "icebreaker": "69af492a4819ea4ba10a69c5",
    "terminal": "65cc8f81a9aac3e77d0cfd3e",
    "labyrinth": "6733700029c367a3d40b02af",
}
for _mid, _m in map_meta.items():
    _zh = _m.get("zh", "")
    _nn = _m.get("nn", "")
    if _zh:
        MAP_NAMES.append((_zh, _mid))
    if _nn:
        MAP_NAMES.append((_nn, _mid))
for _zh, _mid in _zh_extra.items():
    MAP_NAMES.append((_zh, _mid))
for _nn, _mid in _nn_extra.items():
    MAP_NAMES.append((_nn, _mid))
MAP_NAMES.sort(key=lambda x: len(x[0]), reverse=True)


def extract_maps(t, T):
    """从任务 map 字段 + objectives/rewards 文本中提取涉及地图 id 列表。"""
    found = set()
    # 1) 官方 map 字段
    if t.get("map"):
        found.add(t["map"])
    # 2) 扫描目标与奖励文本
    texts = []
    for o in (t.get("objectives") or []):
        if isinstance(o, dict):
            desc = T(o.get("description"))
            if desc:
                texts.append(desc)
            # 某些目标直接带 map 字段
            if o.get("map"):
                texts.append(o["map"])
    for _it in ((t.get("finishRewards") or {}).get("items") or []):
        if isinstance(_it, dict):
            _name = item_name(_it.get("item"))
            if _name:
                texts.append(_name)
    # 有些任务在任务名里就写明地图
    texts.append(T(t.get("name")))
    text = " ".join(texts).lower()
    for _name, _mid in MAP_NAMES:
        if _name.lower() in text:
            found.add(_mid)
    return sorted(found)


def build_objectives(t, T):
    out = []
    for o in (t.get("objectives") or []):
        if not isinstance(o, dict):
            continue
        desc = T(o.get("description"))
        typ = o.get("type") or ""
        cnt = o.get("count")
        obj_items = []
        for iid in (o.get("items") or []):
            if isinstance(iid, str):
                obj_items.append({"id": iid, "name": item_name(iid), "count": cnt})
        opt = {"description": desc, "type": typ, "count": cnt, "items": obj_items}
        opt["type_zh"] = OBJ_TYPE_ZH.get(typ)
        if desc:
            out.append(opt)
    return out


index = {}


def build_one(qid: str, t: dict, zh_tab: dict, modes: list[str]) -> dict:
    """从单条任务源数据构建索引条目。zh_tab 为该任务所属模式的中文语言包。"""
    T = T_of(zh_tab)
    prereqs = []
    for r in (t.get("taskRequirements") or []):
        if isinstance(r, dict) and r.get("task"):
            prereqs.append(r["task"])

    trader_reqs = []
    for r in (t.get("traderRequirements") or []):
        if isinstance(r, dict):
            trader_reqs.append({
                "trader_id": r.get("trader"),
                "reqType": r.get("requirementType") or "level",
                "value": r.get("value"),
            })
    # 补全：otherRequirements 中的 globalVariable 多与「商人忠诚等级」相关，
    # 上游未放进 traderRequirements，导致图谱漏显（如 Ragman 火线速递）。
    # 注意：这里的 value 是「全局变量阈值」，并不等于忠诚等级数字
    # （例：夜间扫荡 的变量 value=1，游戏内实际显示为 Skier LL4），
    # 因此统一标记为 reqType="variable"，只作「存在额外商人条件」提示，
    # 前端不展示为 LL{value}，避免误导。
    for o in (t.get("otherRequirements") or []):
        if isinstance(o, dict) and o.get("type") == "globalVariable":
            vid = o.get("variableId")
            trd = var_to_trader.get(vid) if vid else None
            if trd:
                trader_reqs.append({
                    "trader_id": trd,
                    "reqType": "variable",
                    "value": o.get("value") if isinstance(o.get("value"), int) else None,
                })
    # 去重（按 商人+类型+值）
    _seen = set()
    _dedup = []
    for _r in trader_reqs:
        _k = (_r.get("trader_id"), _r.get("reqType"), _r.get("value"))
        if _k in _seen:
            continue
        _seen.add(_k)
        _dedup.append(_r)
    trader_reqs = _dedup

    rewards = []
    for it in ((t.get("finishRewards") or {}).get("items") or []):
        if isinstance(it, dict):
            rewards.append({"name": item_name(it.get("item")), "count": it.get("count")})

    tid = t.get("trader")

    # 任务可能涉及多个地图：官方 map 字段 + 目标/奖励文本中的地图名
    maps = extract_maps(t, T)
    # 如果官方 map 字段为空但有文本提取结果，第一个地图作为展示主地图
    main_map = t.get("map") or (maps[0] if maps else None)

    return {
        "name": T(t.get("name")),
        "trader_id": tid,
        "trader_name": trader_name(tid),
        "prereqs": prereqs,
        "trader_reqs": trader_reqs,
        "min_level": t.get("minPlayerLevel"),
        "map": main_map,
        "maps": maps,
        "wiki": f"https://www.eftarkov.com/news/id/{qid}.html",
        "objectives": build_objectives(t, T),
        "rewards": rewards,
        "legacy": qid not in season,
        "special": trader_norm(tid) in SPECIAL_TRADERS,
        "modes": modes,
    }


# 1) regular(=PVP) 集合：共有任务 modes=["pvp","pve"]，pvp 独有 ["pvp"]
for qid, t in base.items():
    modes = ["pvp", "pve"] if qid in PVE_IDS else ["pvp"]
    index[qid] = build_one(qid, t, zh, modes)

# 2) pve 独有任务：modes=["pve"]，中文用 pve 语言包
for qid, t in pve.items():
    if qid in PVP_IDS:
        continue
    index[qid] = build_one(qid, t, zh_pve, ["pve"])

# 3) 共有任务在 pve 模式下前置不同时，存 pve 版前置（如 收视灵药 的 pvp 前置是 pvp 独有任务）
prereqs_pve_cnt = 0
for qid in (PVP_IDS & PVE_IDS):
    pp = [r.get("task") for r in (pve[qid].get("taskRequirements") or []) if r.get("task")]
    if pp != index[qid]["prereqs"]:
        index[qid]["prereqs_pve"] = pp
        prereqs_pve_cnt += 1

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

print("written:", OUT)
print("quest count:", len(index))
modes = {}
for v in index.values():
    k = "legacy" if v["legacy"] else "current"
    modes[k] = modes.get(k, 0) + 1
special_cnt = sum(1 for v in index.values() if v["special"])
print("新旧分布:", modes, "| special:", special_cnt)
mode_dist = {}
for v in index.values():
    k = "+".join(v["modes"])
    mode_dist[k] = mode_dist.get(k, 0) + 1
print("模式分布:", mode_dist, "| prereqs_pve 差异任务数:", prereqs_pve_cnt)
sz = os.path.getsize(OUT)
print("size KB: %.1f" % (sz / 1024))
sample = index["657315ddab5a49b71f098853"]
print("sample:", sample["name"], "| legacy:", sample["legacy"], "| special:", sample["special"])
for o in sample["objectives"][:1]:
    print("  obj:", o["description"], "| type:", o["type"], "| items:", o["items"][:2])
