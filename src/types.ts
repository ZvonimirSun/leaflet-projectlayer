export type ProjectLayerPublicErrorCode
  = | 'CONFIG_ERROR'
    | 'TILE_LIMIT_EXCEEDED'
    | 'TILE_LOAD_ERROR'
    | 'RENDER_ERROR'
    | 'UNKNOWN_ERROR'

export type ProjectLayerDebugCode
  = | 'SOURCE_TILE_TIMEOUT'
    | 'TILE_RENDER_ABORTED'
    | 'INVALID_COORDINATE_VALUE'
    | 'PIPELINE_NOT_IMPLEMENTED'
    | 'MISSING_MAP_CRS'
    | 'CANVAS_CONTEXT_UNAVAILABLE'
    | 'SOURCE_TILE_UNSUPPORTED_ELEMENT'
    | 'SOURCE_TILE_LOAD_FAILED'
    | 'TOO_MANY_SOURCE_TILES'
    | 'TOO_MANY_TILE_DEPENDENCIES'

export type ProjectLayerErrorCode = ProjectLayerPublicErrorCode
export type ResamplingInterpolation = 'pixelated' | 'low' | 'medium' | 'high'
export type SourceZoomRounding = 'round' | 'ceil' | 'floor'
export type TileRenderElement = HTMLImageElement | HTMLCanvasElement
export interface TileSize {
  width: number
  height: number
}

export interface TileCoord {
  x: number
  y: number
  z: number
}

export interface ProjectedPoint {
  x: number
  y: number
}

export interface GeoPoint {
  lng: number
  lat: number
}

export interface GeoBounds {
  minLng: number
  maxLng: number
  minLat: number
  maxLat: number
  crossesAntimeridian?: boolean
}

export interface ProjectedBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface TileDependency {
  sourceTile: TileCoord
  srcX: number
  srcY: number
  srcW: number
  srcH: number
  dstX: number
  dstY: number
  dstW: number
  dstH: number
}

export interface MosaicBuildMetrics {
  cacheHits: number
  cacheMisses: number
}

export interface SourceTileCacheEntry {
  controller: AbortController
  consumers: number
  promise: Promise<TileRenderElement>
  settled: boolean
}

export interface TileRenderMetrics extends MosaicBuildMetrics {
  coords: TileCoord
  sourceTileCount: number
  dependencyCount: number
  renderDurationMs: number
}

export interface TileErrorDebugEvent {
  coords: TileCoord
  code: ProjectLayerPublicErrorCode
  debugCode?: ProjectLayerDebugCode
  debugMessage?: string
}
