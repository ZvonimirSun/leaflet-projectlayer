# AGENTS 协作指南

本文档用于维护本仓库在 `0.1.0` 首发后的协作规则、发布检查流程与后续维护任务。

## 1. 项目定位

`@zvonimirsun/leaflet-projectlayer` 是一个基于 Leaflet `GridLayer` 的瓦片重投影层：

- 输入：源 `L.CRS` + 源 `L.TileLayer`
- 输出：在当前地图 CRS 下可直接渲染的目标瓦片

对外仅暴露：

- `ProjectLayer`
- `projectLayer(options)`

## 2. 发布状态（0.1.0）

- 包名：`@zvonimirsun/leaflet-projectlayer`
- 版本：`0.1.0`
- 许可：MIT
- 导出：ESM / UMD(CJS require) / d.ts
- `files` 白名单仅 `dist`，不发布 `test/` 与调试页面资源

## 3. 协作原则

1. **主链路优先**：优先保证重投影渲染主链路正确性。  
2. **最小改动**：不做与当前目标无关的重构。  
3. **先验证后结论**：涉及几何、渲染与错误行为的改动必须有可复现验证。  
4. **文档同步**：任何公开 API、脚本、构建产物变化必须同步更新 README 与本文件。  

## 4. 提交前检查

至少执行：

```sh
pnpm test
pnpm lint
pnpm build
npm pack --dry-run
```

通过标准：

- 测试、静态检查、构建全部通过
- `dist/` 产物完整且名称与 `package.json` 导出字段一致
- 打包清单不包含调试页、测试代码与第三方 token 信息

## 5. 发布检查清单

发布前逐项确认：

- `package.json` 的 `version`、`exports/main/module/types/files` 正确
- `README.md` 示例与当前 API 一致
- `LICENSE` 与 `package.json.license` 一致

## 6. 风险注意项

- `test/App.vue` 的调试 token 不进行硬编码；如需联调第三方服务请在本地注入，不得提交真实凭据。
- 若调整错误码或事件载荷（`tileerror` / `tilemetrics`），需先补测试再更新文档。

## 7. 后续维护任务（next）

- 增补复杂 CRS/边界场景测试（高纬、高 zoom、跨经线组合）
- 完善错误可观测性文档（public code 与 debug code 对照）
- 评估 source tile 缓存策略（命中率与驱逐策略）
- 增加首发后回归基线（关键渲染案例的可复现验收）
