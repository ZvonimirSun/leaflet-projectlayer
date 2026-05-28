import type { MosaicBuildMetrics, ResamplingInterpolation, TileCoord, TileDependency, TileRenderElement, TileSize } from './types'
import { ProjectLayerError } from './error'

async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return []
  }

  const results = Array.from({ length: items.length }) as R[]
  let nextIndex = 0

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await mapper(items[currentIndex], currentIndex)
    }
  }

  const workerCount = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return results
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function withSourceTileTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  coords: TileCoord,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ProjectLayerError(
        'SOURCE_TILE_TIMEOUT',
        `Source tile loading timed out after ${timeoutMs}ms for tile ${coords.z}/${coords.x}/${coords.y}.`,
      ))
    }, timeoutMs)

    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

async function loadSourceTileWithRetry(
  fetchSourceTile: (coords: TileCoord) => Promise<TileRenderElement>,
  coords: TileCoord,
  retryCount: number,
  retryDelayMs: number,
  sourceTileTimeoutMs: number,
): Promise<TileRenderElement> {
  let attempt = 0

  while (true) {
    try {
      return await withSourceTileTimeout(fetchSourceTile(coords), sourceTileTimeoutMs, coords)
    }
    catch (error) {
      if (attempt >= retryCount) {
        throw error
      }

      const delayMs = retryDelayMs * (2 ** attempt)
      attempt += 1
      await sleep(delayMs)
    }
  }
}

// 统一在一个 canvas 内按依赖窗口绘制源瓦片，输出目标瓦片最终图像。
export async function buildMosaicCanvas(
  dependencies: TileDependency[],
  fetchSourceTile: (coords: TileCoord) => Promise<TileRenderElement>,
  tileSize: TileSize,
  interpolation: ResamplingInterpolation,
  maxConcurrency: number,
  sourceTileCache: Map<string, Promise<TileRenderElement>>,
  maxSourceCacheSize: number,
  retryCount = 0,
  retryDelayMs = 100,
  sourceTileTimeoutMs = 5000,
  metrics?: MosaicBuildMetrics,
): Promise<HTMLCanvasElement> {
  const mosaic = document.createElement('canvas')
  mosaic.width = tileSize.width
  mosaic.height = tileSize.height

  const context = mosaic.getContext('2d')

  if (!context) {
    throw new ProjectLayerError(
      'CANVAS_CONTEXT_UNAVAILABLE',
      'Failed to build mosaic canvas: 2D rendering context is unavailable.',
    )
  }

  context.imageSmoothingEnabled = interpolation !== 'pixelated'
  if (context.imageSmoothingEnabled) {
    context.imageSmoothingQuality = interpolation === 'high'
      ? 'high'
      : interpolation === 'low'
        ? 'low'
        : 'medium'
  }

  const sourceTiles = await mapWithConcurrencyLimit(dependencies, maxConcurrency, async (dependency) => {
    const key = `${dependency.sourceTile.z}:${dependency.sourceTile.x}:${dependency.sourceTile.y}`
    let sourceTilePromise = sourceTileCache.get(key)

    if (sourceTilePromise) {
      if (metrics) {
        metrics.cacheHits += 1
      }
    }
    else {
      if (metrics) {
        metrics.cacheMisses += 1
      }
      sourceTilePromise = loadSourceTileWithRetry(
        fetchSourceTile,
        dependency.sourceTile,
        retryCount,
        retryDelayMs,
        sourceTileTimeoutMs,
      )

      sourceTilePromise.catch(() => {
        sourceTileCache.delete(key)
      })

      if (maxSourceCacheSize > 0) {
        if (sourceTileCache.size >= maxSourceCacheSize) {
          const oldestKey = sourceTileCache.keys().next().value as string | undefined

          if (oldestKey !== undefined) {
            sourceTileCache.delete(oldestKey)
          }
        }

        sourceTileCache.set(key, sourceTilePromise)
      }
    }

    const sourceTile = await sourceTilePromise

    return {
      dependency,
      sourceTile,
    }
  })

  for (const { dependency, sourceTile } of sourceTiles) {
    context.drawImage(
      sourceTile,
      dependency.srcX,
      dependency.srcY,
      dependency.srcW,
      dependency.srcH,
      dependency.dstX,
      dependency.dstY,
      dependency.dstW,
      dependency.dstH,
    )
  }

  return mosaic
}
