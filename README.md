# Leaflet ProjectLayer

基于 Leaflet `GridLayer` 的 TypeScript 库：将一个源 `TileLayer` 按源 CRS 重投影到当前地图 CRS 下显示。

## 安装

```sh
pnpm install @zvonimirsun/leaflet-projectlayer leaflet
```

> `leaflet` 为 peer dependency，需要由业务项目自行安装。

## 快速使用

```ts
import { projectLayer } from '@zvonimirsun/leaflet-projectlayer'
import L from 'leaflet'

const sourceLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png')

const overlay = projectLayer({
  crs: L.CRS.EPSG3857,
  layer: sourceLayer,
  opacity: 0.6,
})

overlay.addTo(map)
```

也可以直接使用构造类：

```ts
import { ProjectLayer } from '@zvonimirsun/leaflet-projectlayer'

new ProjectLayer({
  crs: L.CRS.EPSG3857,
  layer: sourceLayer,
}).addTo(map)
```

## API

### `projectLayer(options)`

工厂函数，返回 `L.GridLayer` 实例。

### `new ProjectLayer(options)`

构造类方式创建图层实例。

### `options`

在 Leaflet `GridLayerOptions` 基础上扩展以下字段：

- `crs: L.CRS`（必填）
  - 源瓦片图层使用的 CRS。
- `layer: L.TileLayer`（必填）
  - 作为数据来源的源瓦片图层。
- `zoomRounding?: 'round' | 'ceil' | 'floor'`（可选，默认 `round`）
  - 目标 zoom 反解源 zoom 后的取整策略。

其余选项沿用 Leaflet `GridLayerOptions`。

## 运行行为说明

- 若未显式传入 `minZoom/maxZoom`，会按源 `TileLayer` 的 `minZoom/maxZoom` 结合源/目标 CRS 比例尺映射出默认范围。
- `createTile(coords, done)` 每次渲染都会实时读取当前 `map.options.crs` 作为目标 CRS。

## 错误与调试事件

库会按 Leaflet 事件机制触发：

- `tileerror`：瓦片渲染失败时触发，包含公共错误码与调试错误码。
- `tilemetrics`：瓦片渲染过程指标（依赖数量、缓存命中、耗时等）。

## 构建产物

`pnpm build` 后默认输出：

- ESM: `dist/leaflet-projectlayer.js`
- UMD (require): `dist/leaflet-projectlayer.umd.cjs`
- 类型声明: `dist/leaflet-projectlayer.d.ts`

## 开发命令

```sh
pnpm install
pnpm dev
pnpm test
pnpm lint
pnpm build
```

## 限制与注意事项

- 本库聚焦二维瓦片重投影，不包含矢量要素重投影能力。
- 依赖源瓦片服务可用性与 CRS 定义正确性。
- 仓库内调试页仅用于本地验证，不属于对外 API 与发布内容。

## 协作说明

协作规则、发布检查与后续维护任务见 [AGENTS.md](AGENTS.md)。
