import type { ResamplingInterpolation, SourceTileCacheEntry, SourceZoomRounding, TileCoord, TileErrorDebugEvent, TileRenderElement, TileRenderMetrics } from './types'
import L from 'leaflet'
import { normalizeProjectLayerError, ProjectLayerError } from './error'
import { computeTileDependencies, geoBoundsToSourceProjectedBounds, sourceBoundsToSourceTiles, sourceZoomToTargetZoom, targetZoomToSourceZoom, tileCoordToGeoBounds } from './geometry'
import { buildMosaicCanvas } from './mosaic'
import { createSourceTileFetcher } from './source-tile'

const DEFAULT_INTERPOLATION: ResamplingInterpolation = 'medium'
const DEFAULT_MAX_CONCURRENCY = 8
const DEFAULT_MAX_SOURCE_CACHE_SIZE = 256
const DEFAULT_RETRY_COUNT = 1
const DEFAULT_RETRY_DELAY_MS = 100
const DEFAULT_SOURCE_TILE_TIMEOUT_MS = 5000
const DEFAULT_MAX_SOURCE_TILES_PER_TARGET_TILE = 256
const DEFAULT_MAX_DEPENDENCIES_PER_TARGET_TILE = 128

function clampSourceZoomByNativeZoom(zoom: number, options: L.TileLayerOptions): number {
  if (options.minNativeZoom !== undefined && zoom < options.minNativeZoom) {
    return options.minNativeZoom
  }

  if (options.maxNativeZoom !== undefined && options.maxNativeZoom < zoom) {
    return options.maxNativeZoom
  }

  return zoom
}

function resolveTargetZoomLimits(
  sourceCRS: L.CRS,
  targetCRS: L.CRS,
  sourceOptions: L.TileLayerOptions,
  requestedMinZoom?: number,
  requestedMaxZoom?: number,
): { minZoom?: number, maxZoom?: number } {
  const sourceMinZoom = sourceOptions.minZoom
  const sourceMaxZoom = sourceOptions.maxZoom

  const mappedMinZoom = sourceMinZoom === undefined
    ? undefined
    : Math.ceil(sourceZoomToTargetZoom(sourceMinZoom, sourceCRS, targetCRS))
  const mappedMaxZoom = sourceMaxZoom === undefined
    ? undefined
    : Math.floor(sourceZoomToTargetZoom(sourceMaxZoom, sourceCRS, targetCRS))

  return {
    minZoom: requestedMinZoom === undefined
      ? mappedMinZoom
      : requestedMinZoom,
    maxZoom: requestedMaxZoom === undefined
      ? mappedMaxZoom
      : requestedMaxZoom,
  }
}

function getNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }

  return Date.now()
}

function emitTileMetrics(layer: ProjectLayerInstance, metrics: TileRenderMetrics): void {
  try {
    layer.fire('tilemetrics', metrics)
  }
  catch {
    // 事件监听器异常不应影响主渲染流程。
  }
}

function emitTileErrorDebug(layer: ProjectLayerInstance, payload: TileErrorDebugEvent): void {
  try {
    layer.fire('tileerror', payload)
  }
  catch {
    // 调试事件监听器异常不应影响主渲染流程。
  }
}

interface ProjectLayerOptions extends L.GridLayerOptions {
  crs: L.CRS
  layer: L.TileLayer
  zoomRounding?: SourceZoomRounding
}

interface ProjectLayerInternalState {
  _sourceCRS: L.CRS
  _sourceLayer: L.TileLayer
  _sourceTileFetcher: (coords: TileCoord, signal?: AbortSignal) => Promise<TileRenderElement>
  _sourceTileCache: Map<string, SourceTileCacheEntry>
  _tileAbortControllers: WeakMap<TileRenderElement, AbortController>
  _activeTileAbortControllers: Set<AbortController>
  _zoomRounding: SourceZoomRounding
  _requestedMaxZoom?: number
  _requestedMinZoom?: number
  _map?: L.Map
}

type ProjectLayerInstance = L.GridLayer & ProjectLayerInternalState

function abortTileRender(layer: ProjectLayerInstance, tile: unknown): void {
  if (!(tile instanceof HTMLCanvasElement || tile instanceof HTMLImageElement)) {
    return
  }

  const controller = layer._tileAbortControllers.get(tile)

  if (!controller) {
    return
  }

  controller.abort()
  layer._tileAbortControllers.delete(tile)
  layer._activeTileAbortControllers.delete(controller)
}

function releaseTileRenderController(layer: ProjectLayerInstance, tile: TileRenderElement, controller: AbortController): void {
  layer._tileAbortControllers.delete(tile)
  layer._activeTileAbortControllers.delete(controller)
}

export const ProjectLayer = L.GridLayer.extend({
  initialize(this: ProjectLayerInstance, options: ProjectLayerOptions): void {
    ;(L.GridLayer.prototype as any).initialize.call(this, options)

    this._sourceCRS = options.crs
    this._sourceLayer = options.layer
    this._sourceTileFetcher = createSourceTileFetcher(this._sourceLayer, this._sourceCRS)
    this._sourceTileCache = new Map()
    this._tileAbortControllers = new WeakMap()
    this._activeTileAbortControllers = new Set()
    this._zoomRounding = options.zoomRounding ?? 'round'
    this._requestedMinZoom = options.minZoom
    this._requestedMaxZoom = options.maxZoom

    const sourceLayerOptions = this._sourceLayer.options as L.GridLayerOptions

    if (options.bounds === undefined && sourceLayerOptions.bounds !== undefined) {
      ;(this.options as L.GridLayerOptions).bounds = sourceLayerOptions.bounds
    }
  },

  onRemove(this: ProjectLayerInstance, map: L.Map): void {
    for (const controller of this._activeTileAbortControllers) {
      controller.abort()
    }

    this._activeTileAbortControllers.clear()
    ;(L.GridLayer.prototype as any).onRemove.call(this, map)
  },

  beforeAdd(this: ProjectLayerInstance, map: L.Map): void {
    const targetZoomLimits = resolveTargetZoomLimits(
      this._sourceCRS,
      map.options.crs as L.CRS,
      this._sourceLayer.options,
      this._requestedMinZoom,
      this._requestedMaxZoom,
    )

    const layerOptions = this.options as L.GridLayerOptions
    layerOptions.minZoom = targetZoomLimits.minZoom
    layerOptions.maxZoom = targetZoomLimits.maxZoom

    ;(L.GridLayer.prototype as any).beforeAdd.call(this, map)
  },

  createTile(this: ProjectLayerInstance, coords: L.Coords, done: L.DoneCallback): TileRenderElement {
    const tileSize = this.getTileSize()
    const targetTileSize = { width: tileSize.x, height: tileSize.y }
    const sourceLayerTileSize = this._sourceLayer.getTileSize()
    const sourceTileSize = { width: sourceLayerTileSize.x, height: sourceLayerTileSize.y }
    const tile = document.createElement('canvas')
    tile.width = tileSize.x
    tile.height = tileSize.y
    const abortController = new AbortController()
    this._tileAbortControllers.set(tile, abortController)
    this._activeTileAbortControllers.add(abortController)
    const renderStart = getNow()

    queueMicrotask(async () => {
      const finalizeMetrics = (partial: Omit<TileRenderMetrics, 'renderDurationMs'>) => {
        emitTileMetrics(this, {
          ...partial,
          renderDurationMs: Math.max(0, getNow() - renderStart),
        })
      }

      try {
        const targetCRS = this._map?.options.crs

        if (abortController.signal.aborted) {
          return
        }

        if (!targetCRS) {
          throw new ProjectLayerError(
            'MISSING_MAP_CRS',
            'Missing map CRS: ProjectLayer must be added to a Leaflet map before tiles can be rendered.',
          )
        }

        // 每次瓦片渲染都以当前地图 CRS 为准，避免地图 CRS 变化后使用旧状态。
        const geoBounds = tileCoordToGeoBounds(coords, targetCRS, targetTileSize)
        const sourceBounds = geoBoundsToSourceProjectedBounds(geoBounds, this._sourceCRS)
        const sourceZoom = clampSourceZoomByNativeZoom(
          targetZoomToSourceZoom(coords.z, targetCRS, this._sourceCRS, this._zoomRounding),
          this._sourceLayer.options,
        )
        const sourceTiles = sourceBoundsToSourceTiles(sourceBounds, this._sourceCRS, sourceZoom, sourceTileSize)

        if (sourceTiles.length > DEFAULT_MAX_SOURCE_TILES_PER_TARGET_TILE) {
          throw new ProjectLayerError(
            'TOO_MANY_SOURCE_TILES',
            `Source tile limit exceeded for target tile ${coords.z}/${coords.x}/${coords.y}: got ${sourceTiles.length}, max ${DEFAULT_MAX_SOURCE_TILES_PER_TARGET_TILE}.`,
          )
        }

        const dependencies = computeTileDependencies(
          coords,
          sourceTiles,
          this._sourceCRS,
          targetCRS,
          targetTileSize,
          sourceTileSize,
        )

        if (dependencies.length > DEFAULT_MAX_DEPENDENCIES_PER_TARGET_TILE) {
          throw new ProjectLayerError(
            'TOO_MANY_TILE_DEPENDENCIES',
            `Tile dependency limit exceeded for target tile ${coords.z}/${coords.x}/${coords.y}: got ${dependencies.length}, max ${DEFAULT_MAX_DEPENDENCIES_PER_TARGET_TILE}.`,
          )
        }

        const mosaicMetrics = { cacheHits: 0, cacheMisses: 0 }
        const mosaic = await buildMosaicCanvas(
          dependencies,
          this._sourceTileFetcher,
          targetTileSize,
          DEFAULT_INTERPOLATION,
          DEFAULT_MAX_CONCURRENCY,
          this._sourceTileCache,
          DEFAULT_MAX_SOURCE_CACHE_SIZE,
          DEFAULT_RETRY_COUNT,
          DEFAULT_RETRY_DELAY_MS,
          DEFAULT_SOURCE_TILE_TIMEOUT_MS,
          mosaicMetrics,
          abortController.signal,
        )

        if (abortController.signal.aborted) {
          return
        }

        const tileContext = tile.getContext('2d')

        if (!tileContext) {
          throw new ProjectLayerError(
            'CANVAS_CONTEXT_UNAVAILABLE',
            'Failed to render tile: 2D rendering context is unavailable.',
          )
        }

        tileContext.drawImage(mosaic, 0, 0)
        finalizeMetrics({
          coords: { x: coords.x, y: coords.y, z: coords.z },
          sourceTileCount: sourceTiles.length,
          dependencyCount: dependencies.length,
          cacheHits: mosaicMetrics.cacheHits,
          cacheMisses: mosaicMetrics.cacheMisses,
        })
        done(undefined, tile)
      }
      catch (error) {
        if (abortController.signal.aborted) {
          return
        }

        const normalizedError = normalizeProjectLayerError(error)
        emitTileErrorDebug(this, {
          coords: { x: coords.x, y: coords.y, z: coords.z },
          code: normalizedError.code,
          debugCode: normalizedError.debugCode,
          debugMessage: normalizedError.debugMessage,
        })
        done(normalizedError, tile)
      }
      finally {
        releaseTileRenderController(this, tile, abortController)
      }
    })

    return tile
  },

  _abortTile(this: ProjectLayerInstance, tile: unknown): void {
    abortTileRender(this, tile)
  },

  _removeTile(this: ProjectLayerInstance, key: string): void {
    const tiles = (this as any)._tiles as Record<string, { el?: HTMLElement }> | undefined
    const tile = tiles?.[key]?.el

    abortTileRender(this, tile)
    ;(L.GridLayer.prototype as any)._removeTile.call(this, key)
  },
}) as unknown as {
  new (options: L.GridLayerOptions & { crs: L.CRS, layer: L.TileLayer, zoomRounding?: SourceZoomRounding }): L.GridLayer
  prototype: L.GridLayer
  extend: typeof L.GridLayer.extend
}

export function projectLayer(options: L.GridLayerOptions & { crs: L.CRS, layer: L.TileLayer, zoomRounding?: SourceZoomRounding }): L.GridLayer {
  return new ProjectLayer(options)
}

export { ProjectLayerError } from './error'
export type {
  ProjectLayerDebugCode,
  ProjectLayerErrorCode,
  ProjectLayerPublicErrorCode,
  SourceZoomRounding,
  TileErrorDebugEvent,
  TileRenderMetrics,
} from './types'
