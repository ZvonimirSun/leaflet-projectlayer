import L from 'leaflet'
import { describe, expect, it } from 'vitest'
import {
  computeTileDependencies,
  geoBoundsToSourceProjectedBounds,
  sourceBoundsToSourceTiles,
  sourceZoomToTargetZoom,
  targetZoomToSourceZoom,
  tileCoordToGeoBounds,
} from '../geometry'
import { createTestCRSIdentity } from './helpers'

function createShiftedTileMatrixCRS(offsetX: number, offsetY: number): L.CRS {
  const base = createTestCRSIdentity()

  return {
    ...base,
    latLngToPoint(latlng, zoom) {
      const point = base.latLngToPoint(latlng, zoom)
      return L.point(point.x + offsetX, point.y + offsetY)
    },
    pointToLatLng(point, zoom) {
      const projected = L.point(point)
      return base.pointToLatLng(L.point(projected.x - offsetX, projected.y - offsetY), zoom)
    },
  }
}

function createZoomShiftedCRS(zoomShift: number): L.CRS {
  const base = createTestCRSIdentity()

  return {
    ...base,
    scale(zoom) {
      return base.scale(zoom + zoomShift)
    },
    zoom(scale) {
      return base.zoom(scale) - zoomShift
    },
  }
}

function createAntimeridianCrossingCRS(): L.CRS {
  const base = createTestCRSIdentity()

  return {
    ...base,
    latLngToPoint(latlng, zoom) {
      const point = L.latLng(latlng)
      const scale = 256 * (2 ** zoom)
      const lngDistance = ((point.lng - 170 + 360) % 360 + 360) % 360
      return L.point((lngDistance / 20) * scale, ((90 - point.lat) / 180) * scale)
    },
    pointToLatLng(point, zoom) {
      const projected = L.point(point)
      const scale = 256 * (2 ** zoom)
      const rawLng = 170 + (projected.x / scale) * 20
      const lng = ((rawLng + 180) % 360 + 360) % 360 - 180
      return L.latLng(90 - (projected.y / scale) * 180, lng)
    },
  }
}

describe('瓦片范围计算', () => {
  it('能计算 z0 世界瓦片的经纬度范围', () => {
    const bounds = tileCoordToGeoBounds(
      { x: 0, y: 0, z: 0 },
      L.CRS.EPSG3857,
      { width: 256, height: 256 },
    )

    expect(bounds.minLng).toBeCloseTo(-180, 4)
    expect(bounds.maxLng).toBeCloseTo(180, 4)
    expect(bounds.minLat).toBeCloseTo(-85.0511, 3)
    expect(bounds.maxLat).toBeCloseTo(85.0511, 3)
  })

  it('能将经纬度范围投影到源 CRS 平面范围', () => {
    const projected = geoBoundsToSourceProjectedBounds(
      { minLng: -90, maxLng: 90, minLat: -45, maxLat: 45 },
      createTestCRSIdentity(),
    )

    expect(projected).toEqual({
      minX: -90,
      maxX: 90,
      minY: -45,
      maxY: 45,
    })
  })

  it('能按行优先顺序生成源瓦片索引', () => {
    const tiles = sourceBoundsToSourceTiles(
      { minX: -180, maxX: 180, minY: -85, maxY: 85 },
      createTestCRSIdentity(),
      1,
      { width: 256, height: 256 },
    )

    expect(tiles).toEqual([
      { x: 0, y: 0, z: 1 },
      { x: 1, y: 0, z: 1 },
      { x: 0, y: 1, z: 1 },
      { x: 1, y: 1, z: 1 },
    ])
  })

  it('源瓦片尺寸小于目标瓦片尺寸且网格对齐时会生成多个源瓦片索引', () => {
    const tiles = sourceBoundsToSourceTiles(
      { minX: -180, maxX: 180, minY: -85, maxY: 85 },
      createTestCRSIdentity(),
      0,
      { width: 128, height: 128 },
    )

    expect(tiles).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 1, z: 0 },
    ])
  })

  it('源瓦片网格原点不对齐时，会按源 CRS 的 tile matrix 生成实际覆盖索引', () => {
    const tiles = sourceBoundsToSourceTiles(
      { minX: -180, maxX: 180, minY: -85, maxY: 85 },
      createShiftedTileMatrixCRS(32, 16),
      0,
      { width: 128, height: 128 },
    )

    expect(tiles).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 2, y: 1, z: 0 },
      { x: 0, y: 2, z: 0 },
      { x: 1, y: 2, z: 0 },
      { x: 2, y: 2, z: 0 },
    ])
  })

  it('会按目标 CRS 比例尺反解源 CRS 的瓦片 zoom', () => {
    const sourceZoom = targetZoomToSourceZoom(
      3,
      createTestCRSIdentity(),
      createZoomShiftedCRS(1),
    )

    expect(sourceZoom).toBe(2)
  })

  it('支持配置源瓦片 zoom 的取整策略', () => {
    const sourceZoomCeil = targetZoomToSourceZoom(
      3,
      createTestCRSIdentity(),
      createZoomShiftedCRS(0.4),
      'ceil',
    )
    const sourceZoomFloor = targetZoomToSourceZoom(
      3,
      createTestCRSIdentity(),
      createZoomShiftedCRS(0.4),
      'floor',
    )

    expect(sourceZoomCeil).toBe(3)
    expect(sourceZoomFloor).toBe(2)
  })

  it('会按源 CRS 比例尺映射目标地图的 zoom 范围', () => {
    const targetZoom = sourceZoomToTargetZoom(
      2,
      createZoomShiftedCRS(1),
      createTestCRSIdentity(),
    )

    expect(targetZoom).toBe(3)
  })
  it('非方形 tileSize 会按宽高分别计算边界', () => {
    const bounds = tileCoordToGeoBounds(
      { x: 1, y: 2, z: 3 },
      createTestCRSIdentity(),
      { width: 512, height: 256 },
    )

    expect(bounds).toEqual({
      minLng: -90,
      maxLng: 0,
      minLat: 22.5,
      maxLat: 45,
      crossesAntimeridian: false,
    })
  })

  it('跨经线瓦片会标记 crossesAntimeridian 并保持短弧范围', () => {
    const bounds = tileCoordToGeoBounds(
      { x: 0, y: 0, z: 0 },
      createAntimeridianCrossingCRS(),
      { width: 256, height: 256 },
    )

    expect(bounds.crossesAntimeridian).toBe(true)
    expect(bounds.minLng).toBeCloseTo(-170, 6)
    expect(bounds.maxLng).toBeCloseTo(170, 6)
  })

  it('跨经线范围投影到源 CRS 时会按两段合并', () => {
    const projected = geoBoundsToSourceProjectedBounds(
      {
        minLng: 170,
        maxLng: -170,
        minLat: -10,
        maxLat: 10,
        crossesAntimeridian: true,
      },
      createTestCRSIdentity(),
    )

    expect(projected).toEqual({
      minX: -180,
      maxX: 180,
      minY: -10,
      maxY: 10,
    })
  })

  it('sourceBoundsToSourceTiles 支持非方形源瓦片尺寸', () => {
    const tiles = sourceBoundsToSourceTiles(
      { minX: -180, maxX: 180, minY: -85, maxY: 85 },
      createTestCRSIdentity(),
      1,
      { width: 256, height: 128 },
    )

    expect(tiles).toEqual([
      { x: 0, y: 0, z: 1 },
      { x: 1, y: 0, z: 1 },
      { x: 0, y: 1, z: 1 },
      { x: 1, y: 1, z: 1 },
      { x: 0, y: 2, z: 1 },
      { x: 1, y: 2, z: 1 },
      { x: 0, y: 3, z: 1 },
      { x: 1, y: 3, z: 1 },
    ])
  })
})

describe('瓦片绘制依赖计算', () => {
  it('能为完全重叠瓦片生成完整裁剪窗口', () => {
    const [dependency] = computeTileDependencies(
      { x: 0, y: 0, z: 0 },
      [{ x: 0, y: 0, z: 0 }],
      createTestCRSIdentity(),
      createTestCRSIdentity(),
      { width: 256, height: 256 },
    )

    expect(dependency).toEqual({
      sourceTile: { x: 0, y: 0, z: 0 },
      srcX: 0,
      srcY: 0,
      srcW: 256,
      srcH: 256,
      dstX: 0,
      dstY: 0,
      dstW: 256,
      dstH: 256,
    })
  })

  it('网格对齐时目标瓦片能引用多个不同尺寸的源瓦片绘制依赖', () => {
    const dependencies = computeTileDependencies(
      { x: 0, y: 0, z: 0 },
      [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 1, y: 1, z: 0 },
      ],
      createTestCRSIdentity(),
      createTestCRSIdentity(),
      { width: 256, height: 256 },
      { width: 128, height: 128 },
    )

    expect(dependencies).toHaveLength(4)
    expect(dependencies.map(dependency => dependency.sourceTile)).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 1, z: 0 },
    ])
    expect(dependencies[0]).toMatchObject({
      srcX: 0,
      srcY: 0,
      srcW: 128,
      srcH: 128,
      dstX: 0,
      dstY: 0,
      dstW: 128,
      dstH: 128,
    })
  })

  it('非方形 target/source tileSize 会按轴映射裁剪窗口', () => {
    const [dependency] = computeTileDependencies(
      { x: 0, y: 0, z: 0 },
      [{ x: 0, y: 0, z: 0 }],
      createTestCRSIdentity(),
      createTestCRSIdentity(),
      { width: 512, height: 256 },
      { width: 256, height: 256 },
    )

    expect(dependency).toEqual({
      sourceTile: { x: 0, y: 0, z: 0 },
      srcX: 0,
      srcY: 0,
      srcW: 256,
      srcH: 256,
      dstX: 0,
      dstY: 0,
      dstW: 256,
      dstH: 256,
    })
  })

  it('会过滤没有投影重叠关系的源瓦片', () => {
    const sourceCRS: L.CRS = {
      ...L.CRS.EPSG4326,
      project(latlng) {
        const point = L.latLng(latlng)
        return L.point(point.lng + 1000, point.lat + 1000)
      },
      unproject(point) {
        const projected = L.point(point)
        return L.latLng(projected.y - 1000, projected.x - 1000)
      },
    }

    const dependencies = computeTileDependencies(
      { x: 0, y: 0, z: 1 },
      [{ x: 1, y: 1, z: 1 }],
      sourceCRS,
      createTestCRSIdentity(),
      { width: 256, height: 256 },
    )

    expect(dependencies).toEqual([])
  })
})
