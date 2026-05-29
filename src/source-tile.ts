import type { TileCoord, TileRenderElement } from './types'
import L from 'leaflet'
import { normalizeProjectLayerError, ProjectLayerError } from './error'

function toLeafletCoords(coords: TileCoord): L.Coords {
  const point = L.point(coords.x, coords.y) as L.Coords
  point.z = coords.z
  return point
}

function computeGlobalTileRange(crs: L.CRS, zoom: number, tileSize: L.Point): L.Bounds | undefined {
  const projectedBounds = crs.getProjectedBounds?.(zoom)

  if (!projectedBounds) {
    return undefined
  }

  const { max, min } = projectedBounds

  if (!max || !min) {
    return undefined
  }

  return L.bounds(
    min.unscaleBy(tileSize).floor(),
    max.unscaleBy(tileSize).ceil().subtract([1, 1]),
  )
}

function computeWrapRange(
  crs: L.CRS,
  zoom: number,
  tileSize: L.Point,
  axis: 'x' | 'y',
): [number, number] | undefined {
  const wrap = axis === 'x' ? crs.wrapLng : crs.wrapLat

  if (!wrap) {
    return undefined
  }

  const firstLatLng = axis === 'x'
    ? L.latLng(0, wrap[0])
    : L.latLng(wrap[0], 0)
  const secondLatLng = axis === 'x'
    ? L.latLng(0, wrap[1])
    : L.latLng(wrap[1], 0)
  const firstPoint = crs.latLngToPoint(firstLatLng, zoom)
  const secondPoint = crs.latLngToPoint(secondLatLng, zoom)
  const tileLength = axis === 'x' ? tileSize.x : tileSize.y
  const firstValue = axis === 'x' ? firstPoint.x : firstPoint.y
  const secondValue = axis === 'x' ? secondPoint.x : secondPoint.y

  return [
    Math.floor(Math.min(firstValue, secondValue) / tileLength),
    Math.ceil(Math.max(firstValue, secondValue) / tileLength),
  ]
}

function createAbortError(coords: TileCoord): ProjectLayerError {
  return new ProjectLayerError(
    'TILE_RENDER_ABORTED',
    `Tile rendering was aborted for tile ${coords.z}/${coords.x}/${coords.y}.`,
  )
}

function fireSourceTileUnload(layer: L.TileLayer, tile: HTMLElement, coords: L.Coords): void {
  layer.fire('tileunload', {
    coords,
    tile,
  })
}

// Leaflet 的 createTile 是受保护类型，但运行时插件间经常需要复用该方法。
export function createSourceTileFetcher(layer: L.TileLayer, crs: L.CRS): (coords: TileCoord, signal?: AbortSignal) => Promise<TileRenderElement> {
  return async (coords: TileCoord, signal?: AbortSignal): Promise<TileRenderElement> => {
    return new Promise<TileRenderElement>((resolve, reject) => {
      let settled = false
      let returnedTile: HTMLElement | null = null
      let wrappedCoords: L.Coords | null = null
      let waitingReturnedTileForDone = false
      let imageCleanup: (() => void) | null = null
      let abortCleanup: (() => void) | null = null

      const cleanup = () => {
        imageCleanup?.()
        imageCleanup = null
        abortCleanup?.()
        abortCleanup = null
      }

      const settleResolve = (value: TileRenderElement) => {
        if (settled) {
          return
        }

        settled = true
        cleanup()
        resolve(value)
      }

      const settleReject = (error: unknown) => {
        if (settled) {
          return
        }

        settled = true
        cleanup()
        reject(normalizeProjectLayerError(error))
      }

      if (signal?.aborted) {
        settleReject(createAbortError(coords))
        return
      }

      const onAbort = () => {
        const tile = returnedTile
        const eventCoords = wrappedCoords

        if (tile && eventCoords) {
          fireSourceTileUnload(layer, tile, eventCoords)
        }

        settleReject(createAbortError(coords))
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      abortCleanup = () => {
        signal?.removeEventListener('abort', onAbort)
      }

      const maybeResolveTile = (tile: unknown): boolean => {
        if (tile instanceof HTMLCanvasElement || tile instanceof HTMLImageElement) {
          settleResolve(tile)
          return true
        }

        return false
      }

      const done: L.DoneCallback = (error, tile) => {
        if (error) {
          settleReject(error)
          return
        }

        if (tile && maybeResolveTile(tile)) {
          return
        }

        if (returnedTile && maybeResolveTile(returnedTile)) {
          return
        }

        waitingReturnedTileForDone = true
      }

      try {
        const sourceLayerWithRequestState = Object.create(layer) as any
        const tileSize = layer.getTileSize()

        sourceLayerWithRequestState._tileZoom = coords.z
        sourceLayerWithRequestState._map = { options: { crs } }
        sourceLayerWithRequestState._globalTileRange = computeGlobalTileRange(crs, coords.z, tileSize)

        if (!layer.options.noWrap) {
          sourceLayerWithRequestState._wrapX = computeWrapRange(crs, coords.z, tileSize, 'x')
          sourceLayerWithRequestState._wrapY = computeWrapRange(crs, coords.z, tileSize, 'y')
        }

        const leafletCoords = toLeafletCoords(coords)
        wrappedCoords = typeof sourceLayerWithRequestState._wrapCoords === 'function'
          ? sourceLayerWithRequestState._wrapCoords(leafletCoords)
          : leafletCoords

        returnedTile = sourceLayerWithRequestState.createTile(wrappedCoords, done)
      }
      catch (error) {
        settleReject(error)
        return
      }

      if (waitingReturnedTileForDone) {
        if (returnedTile && maybeResolveTile(returnedTile)) {
          return
        }

        settleReject(new ProjectLayerError(
          'SOURCE_TILE_UNSUPPORTED_ELEMENT',
          'Source layer createTile returned unsupported tile element; expected HTMLImageElement or HTMLCanvasElement.',
        ))
        return
      }

      if (returnedTile instanceof HTMLCanvasElement) {
        queueMicrotask(() => settleResolve(returnedTile as HTMLCanvasElement))
        return
      }

      if (returnedTile instanceof HTMLImageElement) {
        const image = returnedTile

        const onLoad = () => {
          settleResolve(image)
        }

        const onError = () => {
          settleReject(new ProjectLayerError(
            'SOURCE_TILE_LOAD_FAILED',
            `Source tile failed to load for tile ${coords.z}/${coords.x}/${coords.y}.`,
          ))
        }

        image.addEventListener('load', onLoad, { once: true })
        image.addEventListener('error', onError, { once: true })

        imageCleanup = () => {
          image.removeEventListener('load', onLoad)
          image.removeEventListener('error', onError)
        }

        if (image.complete && image.naturalWidth > 0) {
          queueMicrotask(() => settleResolve(image))
        }

        return
      }

      settleReject(new ProjectLayerError(
        'SOURCE_TILE_UNSUPPORTED_ELEMENT',
        'Source layer createTile returned unsupported tile element; expected HTMLImageElement or HTMLCanvasElement.',
      ))
    })
  }
}
