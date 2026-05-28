import type {
  GeoBounds,
  GeoPoint,
  ProjectedBounds,
  ProjectedPoint,
  SourceZoomRounding,
  TileCoord,
  TileDependency,
  TileSize,
} from './types'
import L from 'leaflet'
import { ProjectLayerError } from './error'

function assertFiniteNumber(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    throw new ProjectLayerError(
      'INVALID_COORDINATE_VALUE',
      `Invalid coordinate value for "${field}": ${String(value)}. Expected a finite number.`,
    )
  }
}

function assertFiniteGeoPoint(point: GeoPoint, fieldPrefix: string): void {
  assertFiniteNumber(point.lng, `${fieldPrefix}.lng`)
  assertFiniteNumber(point.lat, `${fieldPrefix}.lat`)
}

function assertFiniteProjectedPoint(point: ProjectedPoint, fieldPrefix: string): void {
  assertFiniteNumber(point.x, `${fieldPrefix}.x`)
  assertFiniteNumber(point.y, `${fieldPrefix}.y`)
}

function projectGeoPoint(crs: L.CRS, point: GeoPoint): ProjectedPoint {
  const projected = crs.project(L.latLng(point.lat, point.lng))
  const normalized = { x: projected.x, y: projected.y }
  assertFiniteProjectedPoint(normalized, 'projectedPoint')
  return normalized
}

function unprojectProjectedPoint(crs: L.CRS, point: ProjectedPoint): GeoPoint {
  const unprojected = crs.unproject(L.point(point.x, point.y))
  const normalized = { lng: unprojected.lng, lat: unprojected.lat }
  assertFiniteGeoPoint(normalized, 'unprojectedPoint')
  return normalized
}

function normalizeLngTo360(lng: number): number {
  return ((lng % 360) + 360) % 360
}

function normalizeLngTo180(lng: number): number {
  const normalized = ((lng + 180) % 360 + 360) % 360 - 180
  return normalized === -180 ? 180 : normalized
}

function projectGeoBounds(
  sourceCRS: L.CRS,
  bounds: { minLng: number, maxLng: number, minLat: number, maxLat: number },
): ProjectedBounds {
  const corners: GeoPoint[] = [
    { lng: bounds.minLng, lat: bounds.minLat },
    { lng: bounds.maxLng, lat: bounds.minLat },
    { lng: bounds.minLng, lat: bounds.maxLat },
    { lng: bounds.maxLng, lat: bounds.maxLat },
  ]

  const projectedCorners = corners.map((corner) => {
    const projected = projectGeoPoint(sourceCRS, corner)
    assertFiniteProjectedPoint(projected, 'sourceBounds.corner')
    return projected
  })

  return {
    minX: Math.min(...projectedCorners.map(point => point.x)),
    maxX: Math.max(...projectedCorners.map(point => point.x)),
    minY: Math.min(...projectedCorners.map(point => point.y)),
    maxY: Math.max(...projectedCorners.map(point => point.y)),
  }
}

// 目标瓦片像素边界先交给目标 CRS 解释，得到它真实覆盖的经纬度范围。
export function tileCoordToGeoBounds(
  coords: TileCoord,
  crs: L.CRS,
  tileSize: TileSize = { width: 256, height: 256 },
): GeoBounds {
  assertFiniteNumber(tileSize.width, 'tileSize.width')
  assertFiniteNumber(tileSize.height, 'tileSize.height')

  if (tileSize.width <= 0 || tileSize.height <= 0) {
    throw new ProjectLayerError(
      'PIPELINE_NOT_IMPLEMENTED',
      `Invalid tileSize for tileCoordToGeoBounds: ${JSON.stringify(tileSize)}. Expected positive width and height.`,
    )
  }

  const minX = coords.x * tileSize.width
  const maxX = (coords.x + 1) * tileSize.width
  const minY = coords.y * tileSize.height
  const maxY = (coords.y + 1) * tileSize.height

  const corners = [
    crs.pointToLatLng(L.point(minX, minY), coords.z),
    crs.pointToLatLng(L.point(maxX, minY), coords.z),
    crs.pointToLatLng(L.point(minX, maxY), coords.z),
    crs.pointToLatLng(L.point(maxX, maxY), coords.z),
  ].map((latlng) => {
    const geoPoint = { lng: latlng.lng, lat: latlng.lat }
    assertFiniteGeoPoint(geoPoint, 'tileCoordToGeoBounds.corner')
    return geoPoint
  })

  const lngValues = corners.map(point => point.lng)
  const minLng = Math.min(...lngValues)
  const maxLng = Math.max(...lngValues)
  const directRange = maxLng - minLng
  const wrappedValues = lngValues.map(normalizeLngTo360)
  const wrappedMin = Math.min(...wrappedValues)
  const wrappedMax = Math.max(...wrappedValues)
  const wrappedRange = wrappedMax - wrappedMin
  const antimeridianEpsilon = 1e-9
  const crossesAntimeridian = directRange > 180 && wrappedRange < 180 && wrappedRange > antimeridianEpsilon

  const bounds = {
    minLng,
    maxLng,
    minLat: Math.min(...corners.map(point => point.lat)),
    maxLat: Math.max(...corners.map(point => point.lat)),
    crossesAntimeridian,
  }

  if (!crossesAntimeridian) {
    return bounds
  }

  const westBound = normalizeLngTo180(wrappedMax)
  const eastBound = normalizeLngTo180(wrappedMin)

  return {
    ...bounds,
    minLng: westBound,
    maxLng: eastBound,
  }
}

// 将经纬度范围投到源 CRS 平面，用四角包络近似该目标瓦片需要覆盖的源空间范围。
export function geoBoundsToSourceProjectedBounds(
  bounds: GeoBounds,
  sourceCRS: L.CRS,
): ProjectedBounds {
  if (!bounds.crossesAntimeridian) {
    return projectGeoBounds(sourceCRS, bounds)
  }

  const westBounds = projectGeoBounds(sourceCRS, {
    minLng: bounds.minLng,
    maxLng: 180,
    minLat: bounds.minLat,
    maxLat: bounds.maxLat,
  })
  const eastBounds = projectGeoBounds(sourceCRS, {
    minLng: -180,
    maxLng: bounds.maxLng,
    minLat: bounds.minLat,
    maxLat: bounds.maxLat,
  })

  return {
    minX: Math.min(westBounds.minX, eastBounds.minX),
    maxX: Math.max(westBounds.maxX, eastBounds.maxX),
    minY: Math.min(westBounds.minY, eastBounds.minY),
    maxY: Math.max(westBounds.maxY, eastBounds.maxY),
  }
}

export function sourceBoundsToSourceTiles(
  bounds: ProjectedBounds,
  sourceCRS: L.CRS,
  zoom: number,
  sourceTileSize: TileSize = { width: 256, height: 256 },
): TileCoord[] {
  assertFiniteNumber(sourceTileSize.width, 'sourceTileSize.width')
  assertFiniteNumber(sourceTileSize.height, 'sourceTileSize.height')

  if (sourceTileSize.width <= 0 || sourceTileSize.height <= 0) {
    throw new ProjectLayerError(
      'PIPELINE_NOT_IMPLEMENTED',
      `Invalid sourceTileSize for sourceBoundsToSourceTiles: ${JSON.stringify(sourceTileSize)}. Expected positive width and height.`,
    )
  }

  const corners: ProjectedPoint[] = [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.minX, y: bounds.maxY },
    { x: bounds.maxX, y: bounds.maxY },
  ]

  const pixelCorners = corners.map((corner) => {
    const geoPoint = unprojectProjectedPoint(sourceCRS, corner)
    const point = sourceCRS.latLngToPoint(L.latLng(geoPoint.lat, geoPoint.lng), zoom)
    const pixelPoint = { x: point.x, y: point.y }
    assertFiniteProjectedPoint(pixelPoint, 'sourceBoundsToSourceTiles.corner')
    return pixelPoint
  })

  const minPixelX = Math.min(...pixelCorners.map(point => point.x))
  const maxPixelX = Math.max(...pixelCorners.map(point => point.x))
  const minPixelY = Math.min(...pixelCorners.map(point => point.y))
  const maxPixelY = Math.max(...pixelCorners.map(point => point.y))

  const edgeEpsilon = 1e-9
  const xMin = Math.floor((minPixelX + edgeEpsilon) / sourceTileSize.width)
  const xMax = Math.floor((maxPixelX - edgeEpsilon) / sourceTileSize.width)
  const yMin = Math.floor((minPixelY + edgeEpsilon) / sourceTileSize.height)
  const yMax = Math.floor((maxPixelY - edgeEpsilon) / sourceTileSize.height)

  const sourceTiles: TileCoord[] = []

  for (let y = yMin; y <= yMax; y += 1) {
    for (let x = xMin; x <= xMax; x += 1) {
      sourceTiles.push({ x, y, z: zoom })
    }
  }

  return sourceTiles
}

export function targetZoomToSourceZoom(
  targetZoom: number,
  targetCRS: L.CRS,
  sourceCRS: L.CRS,
  rounding: SourceZoomRounding = 'round',
): number {
  const targetScale = targetCRS.scale(targetZoom)
  assertFiniteNumber(targetScale, 'targetScale')

  const sourceZoom = sourceCRS.zoom(targetScale)
  assertFiniteNumber(sourceZoom, 'sourceZoom')

  if (rounding === 'ceil') {
    return Math.ceil(sourceZoom)
  }

  if (rounding === 'floor') {
    return Math.floor(sourceZoom)
  }

  // Leaflet 在 GridLayer._setView 中默认使用最接近的整数 tile zoom，这里保持一致。
  return Math.round(sourceZoom)
}

export function sourceZoomToTargetZoom(
  sourceZoom: number,
  sourceCRS: L.CRS,
  targetCRS: L.CRS,
): number {
  const sourceScale = sourceCRS.scale(sourceZoom)
  assertFiniteNumber(sourceScale, 'sourceScale')

  const targetZoom = targetCRS.zoom(sourceScale)
  assertFiniteNumber(targetZoom, 'targetZoom')

  return targetZoom
}

// 根据源瓦片与目标瓦片在投影空间中的相交范围，计算 drawImage 的裁剪窗口。
export function computeTileDependencies(
  targetTile: TileCoord,
  sourceTiles: TileCoord[],
  sourceCRS: L.CRS,
  targetCRS: L.CRS,
  targetTileSize: TileSize,
  sourceTileSize: TileSize = targetTileSize,
): TileDependency[] {
  assertFiniteNumber(targetTileSize.width, 'targetTileSize.width')
  assertFiniteNumber(targetTileSize.height, 'targetTileSize.height')
  assertFiniteNumber(sourceTileSize.width, 'sourceTileSize.width')
  assertFiniteNumber(sourceTileSize.height, 'sourceTileSize.height')

  if (targetTileSize.width <= 0 || targetTileSize.height <= 0 || sourceTileSize.width <= 0 || sourceTileSize.height <= 0) {
    throw new ProjectLayerError(
      'PIPELINE_NOT_IMPLEMENTED',
      'Failed to compute tile dependencies: tile size must have positive width and height.',
    )
  }

  const targetGeoBounds = tileCoordToGeoBounds(targetTile, targetCRS, targetTileSize)
  const sourceProjectedTargetBounds = geoBoundsToSourceProjectedBounds(targetGeoBounds, sourceCRS)
  const targetProjectedTargetBounds = geoBoundsToSourceProjectedBounds(targetGeoBounds, targetCRS)

  const targetRangeX = targetProjectedTargetBounds.maxX - targetProjectedTargetBounds.minX
  const targetRangeY = targetProjectedTargetBounds.maxY - targetProjectedTargetBounds.minY

  if (targetRangeX === 0 || targetRangeY === 0) {
    throw new ProjectLayerError(
      'PIPELINE_NOT_IMPLEMENTED',
      'Failed to compute tile dependencies: target projected bounds range is zero.',
    )
  }

  const clampTargetX = (value: number): number => Math.min(targetTileSize.width, Math.max(0, value))
  const clampTargetY = (value: number): number => Math.min(targetTileSize.height, Math.max(0, value))
  const clampSourceX = (value: number): number => Math.min(sourceTileSize.width, Math.max(0, value))
  const clampSourceY = (value: number): number => Math.min(sourceTileSize.height, Math.max(0, value))
  const edgeEpsilon = 1e-6

  const normalizeWindow = (
    start: number,
    end: number,
    clampPixel: (value: number) => number,
  ): { offset: number, size: number } | null => {
    const minValue = clampPixel(Math.min(start, end))
    const maxValue = clampPixel(Math.max(start, end))

    if (maxValue - minValue <= edgeEpsilon) {
      return null
    }

    return {
      offset: minValue,
      size: maxValue - minValue,
    }
  }

  return sourceTiles.flatMap((sourceTile) => {
    const sourceGeoBounds = tileCoordToGeoBounds(sourceTile, sourceCRS, sourceTileSize)
    const sourceProjectedBounds = geoBoundsToSourceProjectedBounds(sourceGeoBounds, sourceCRS)

    const sourceRangeX = sourceProjectedBounds.maxX - sourceProjectedBounds.minX
    const sourceRangeY = sourceProjectedBounds.maxY - sourceProjectedBounds.minY

    if (sourceRangeX === 0 || sourceRangeY === 0) {
      return []
    }

    const overlapMinX = Math.max(sourceProjectedTargetBounds.minX, sourceProjectedBounds.minX)
    const overlapMaxX = Math.min(sourceProjectedTargetBounds.maxX, sourceProjectedBounds.maxX)
    const overlapMinY = Math.max(sourceProjectedTargetBounds.minY, sourceProjectedBounds.minY)
    const overlapMaxY = Math.min(sourceProjectedTargetBounds.maxY, sourceProjectedBounds.maxY)

    if (overlapMinX >= overlapMaxX || overlapMinY >= overlapMaxY) {
      return []
    }

    const sourceXToPixel = (x: number): number => ((x - sourceProjectedBounds.minX) / sourceRangeX) * sourceTileSize.width
    const sourceYToPixel = (y: number): number => ((sourceProjectedBounds.maxY - y) / sourceRangeY) * sourceTileSize.height

    const overlapMinLngLat = unprojectProjectedPoint(sourceCRS, { x: overlapMinX, y: overlapMinY })
    const overlapMaxLngLat = unprojectProjectedPoint(sourceCRS, { x: overlapMaxX, y: overlapMaxY })

    const overlapInTargetCrsMin = projectGeoPoint(targetCRS, { lng: overlapMinLngLat.lng, lat: overlapMinLngLat.lat })
    const overlapInTargetCrsMax = projectGeoPoint(targetCRS, { lng: overlapMaxLngLat.lng, lat: overlapMaxLngLat.lat })

    const dstXWindow = normalizeWindow(
      ((Math.min(overlapInTargetCrsMin.x, overlapInTargetCrsMax.x) - targetProjectedTargetBounds.minX) / targetRangeX) * targetTileSize.width,
      ((Math.max(overlapInTargetCrsMin.x, overlapInTargetCrsMax.x) - targetProjectedTargetBounds.minX) / targetRangeX) * targetTileSize.width,
      clampTargetX,
    )
    const dstYWindow = normalizeWindow(
      ((targetProjectedTargetBounds.maxY - Math.max(overlapInTargetCrsMin.y, overlapInTargetCrsMax.y)) / targetRangeY) * targetTileSize.height,
      ((targetProjectedTargetBounds.maxY - Math.min(overlapInTargetCrsMin.y, overlapInTargetCrsMax.y)) / targetRangeY) * targetTileSize.height,
      clampTargetY,
    )

    const srcXWindow = normalizeWindow(sourceXToPixel(overlapMinX), sourceXToPixel(overlapMaxX), clampSourceX)
    const srcYWindow = normalizeWindow(sourceYToPixel(overlapMaxY), sourceYToPixel(overlapMinY), clampSourceY)

    if (!srcXWindow || !srcYWindow || !dstXWindow || !dstYWindow) {
      return []
    }

    return [{
      sourceTile,
      srcX: srcXWindow.offset,
      srcY: srcYWindow.offset,
      srcW: srcXWindow.size,
      srcH: srcYWindow.size,
      dstX: dstXWindow.offset,
      dstY: dstYWindow.offset,
      dstW: dstXWindow.size,
      dstH: dstYWindow.size,
    }]
  })
}
