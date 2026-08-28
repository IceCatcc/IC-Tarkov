# Tarkov 交互式地图嵌入 — 参考代码清单（MIT 协议）

仓库：https://github.com/the-hideout/tarkov-dev （协议：MIT，可自由修改/再发布，保留版权声明即可）

> 用途：把官方交互式地图嵌入到自己的项目，玩家坐标改为从本地获取。

## 一、核心文件（必取）

| 文件 | 作用 |
|------|------|
| [src/pages/map/index.jsx](https://github.com/the-hideout/tarkov-dev/blob/main/src/pages/map/index.jsx) | 地图主组件：Leaflet 初始化、标记加载、楼层/图层切换、悬停/点击交互、玩家位置渲染。**总装配入口** |
| [src/pages/map/map-images.mjs](https.//github.com/the-hideout/tarkov-dev/blob/main/src/pages/map/map-images.mjs) | 标记图标映射（`./map-images.mjs`） |
| [src/pages/map/index.css](https://github.com/the-hideout/tarkov-dev/blob/main/src/pages/map/index.css) | 地图样式 |

## 二、自定义 Leaflet 控件（src/modules/）

| 文件 | 作用 |
|------|------|
| [leaflet-control-coordinates.js](https://github.com/the-hideout/tarkov-dev/blob/main/src/modules/leaflet-control-coordinates.js) | 坐标显示控件 |
| [leaflet-control-groupedlayer.js](https://github.com/the-hideout/tarkov-dev/blob/main/src/modules/leaflet-control-groupedlayer.js) | 分组图层控制（按类别/楼层显隐） |
| [leaflet-control-raid-info.js](https://github.com/the-hideout/tarkov-dev/blob/main/src/modules/leaflet-control-raid-info.js) | raid 时长/人数 |
| [leaflet-control-map-search.js](https://github.com/the-hideout/tarkov-dev/blob/main/src/modules/leaflet-control-map-search.js) | 地图搜索（任务/物品过滤） |
| [leaflet-control-map-settings.js](https://github.com/the-hideout/tarkov-dev/blob/main/src/modules/leaflet-control-map-settings.js) | 地图设置面板 |

## 三、数据与状态（src/）

| 文件 | 作用 |
|------|------|
| [src/features/maps/index.js](https://github.com/the-hideout/tarkov-dev/blob/main/src/features/maps/index.js) | `useMapImages`：合并本地 `maps.json` 与远程 API 数据 |
| [src/features/maps/do-fetch-maps.mjs](https://github.com/the-hideout/tarkov-dev/blob/main/src/features/maps/do-fetch-maps.mjs) | 拉取远程地图标记数据（撤离点/战利品/Boss 等） |
| [src/features/items/index.js](https://github.com/the-hideout/tarkov-dev/blob/main/src/features/items/index.js) | 物品/手册数据 |
| [src/features/quests/index.js](https://github.com/the-hideout/tarkov-dev/blob/main/src/features/quests/index.js) | 任务数据 |
| [src/features/settings/settingsSlice.mjs](https://github.com/the-hideout/tarkov-dev/blob/main/src/features/settings/settingsSlice.mjs) | Redux：`setPlayerPosition`（玩家位置 action） |
| [src/hooks/useStateWithLocalStorage.jsx](https://github.com/the-hideout/tarkov-dev/blob/main/src/hooks/useStateWithLocalStorage.jsx) | 本地持久化状态 |
| [src/data/maps.json](https://github.com/the-hideout/tarkov-dev/blob/main/src/data/maps.json) | 地图结构（投影/bounds/svgPath/tilePath/levels）— 本地 |
| [src/data/maps_static.json](https://github.com/the-hideout/tarkov-dev/blob/main/src/data/maps_static.json) | 静态标记 |

## 四、资源（public/）

- [public/maps/interactive/](https://github.com/the-hideout/tarkov-dev/tree/main/public/maps/interactive) — 标记图标（出生点/撤离点/战利品/玩家 `player-position.png` 等）
- [public/maps/](https://github.com/the-hideout/tarkov-dev/tree/main/public/maps) — 地图底图 JPG

## 五、👤 玩家位置改哪里（你最关心的）

原始来源：`index.jsx` 通过 `useSelector(state => state.settings.playerPosition)` 读取，由 `setPlayerPosition`（settingsSlice.mjs）写入（原本来自 TarkovMonitor）。

改造点：把 `state.settings.playerPosition` 这一处数据源替换为你自己的本地来源（文件 / WebSocket / 输入框 / 坐标生成器），坐标格式 `{ x, z, rotation? }`，渲染逻辑（`positionMarker` + `player-position.png` 带旋转）已现成，无需重写。

## 六、数据来源提醒（嵌入前必看）

- **地图骨架**：`maps.json` 是本地 JSON，可直接带走。
- **标记动态数据**：撤离点、出生点、战利品等默认走远程 API（`do-fetch-maps.mjs`）。两种选择：
  1. 继续调官方 API（最新，改动最小）；
  2. 若只画地图+玩家位置，删掉 `useMapImages` 对 `apiData` 的合并，纯用 `rawMapData` 离线。

## 建议给项目会话的指令示例
"参考这份清单，搭建最小可运行的交互地图：拉取上述文件，移除 Redux/远程 API 依赖，玩家坐标改为从本地输入/文件读取并绘制到地图。"
