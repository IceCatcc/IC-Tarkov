#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""下载 json.tarkov.dev 的**原始** API JSON，作为软件内置的种子数据。

端点目录（含可用端点与 gameMode 列表）：
    https://json.tarkov.dev/endpoints

输出：
    src-tauri/resources/api/*.json     原始响应，原样落盘，不做任何加工
    src-tauri/resources/manifest.json  种子清单（文件名 / 字节数 / 抓取时间）

运行时行为（见 src-tauri/src/apidata.rs）：
    1. 首次启动把本目录的文件复制到「应用数据目录/tarkov-api」作为缓存；
    2. 之后由软件端直接请求同一批端点刷新缓存并重建派生索引。
    因此日常更新只需点击「更新数据」，无需再跑本脚本；
    仅在需要更新随安装包分发的种子数据时才重新执行。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "src-tauri", "resources", "api")
BASE = "https://json.tarkov.dev"

# (保存文件名, 端点路径, 说明) —— 与 src-tauri/src/apidata.rs 的 ENDPOINTS 保持一致
ENDPOINTS = [
    ("regular_tasks.json", "regular/tasks", "任务（PvP 常驻）"),
    ("pve_tasks.json", "pve/tasks", "任务（PvE 常驻）"),
    ("season_tasks.json", "pvp-season/tasks", "任务（当前赛季，用于判定旧任务）"),
    ("regular_tasks_zh.json", "regular/tasks_zh", "任务中文本地化"),
    ("pve_tasks_zh.json", "pve/tasks_zh", "任务中文本地化（PvE）"),
    ("regular_maps.json", "regular/maps", "地图 / 撤离点 / 刷新点 / Boss"),
    ("regular_maps_zh.json", "regular/maps_zh", "地图与 Boss 中文本地化"),
    ("regular_traders.json", "regular/traders", "商人"),
    ("regular_traders_zh.json", "regular/traders_zh", "商人中文本地化"),
    ("regular_items_zh.json", "regular/items_zh", "物品中文本地化"),
]

TIMEOUT = 120


def fetch(path: str) -> bytes:
    url = f"{BASE}/{path}"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "ic-tarkov/1.0 (+https://github.com/)",
            # 不接受压缩，落盘即为可直接解析的明文 JSON
            "Accept-Encoding": "identity",
        },
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        data = resp.read()
    if not data or data[:1] not in (b"{", b"["):
        raise RuntimeError(f"响应不是 JSON：{url} -> {data[:32]!r}")
    return data


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    manifest = {"version": 1, "source": BASE, "fetchedAt": int(time.time()), "files": {}}
    for i, (fname, path, desc) in enumerate(ENDPOINTS, 1):
        dst = os.path.join(OUT_DIR, fname)
        try:
            data = fetch(path)
        except (urllib.error.URLError, TimeoutError, RuntimeError) as e:
            print(f"[{i}/{len(ENDPOINTS)}] 失败 {path}: {e}")
            continue
        with open(dst, "wb") as f:
            f.write(data)
        manifest["files"][fname] = {"path": path, "desc": desc, "bytes": len(data)}
        print(f"[{i}/{len(ENDPOINTS)}] {desc:<28} {path:<22} {len(data) / 1024:8.1f} KB")

    ok = len(manifest["files"])
    if ok == 0:
        print("没有任何端点下载成功")
        return 1
    mpath = os.path.join(ROOT, "src-tauri", "resources", "api", "manifest.json")
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    total = sum(v["bytes"] for v in manifest["files"].values()) / 1024 / 1024
    print(f"\n完成 {ok}/{len(ENDPOINTS)} 个端点，共 {total:.1f} MB -> {OUT_DIR}")
    if ok < len(ENDPOINTS):
        print("警告：部分端点缺失，缺失的会在软件首次联网时自动补齐")
    return 0


if __name__ == "__main__":
    sys.exit(main())
