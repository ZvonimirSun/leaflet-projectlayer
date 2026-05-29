import type { MosaicBuildMetrics, ResamplingInterpolation, SourceTileCacheEntry, TileCoord, TileDependency, TileRenderElement, TileSize } from './types'
import { ProjectLayerError } from './error'

function createAbortError(): ProjectLayerError {
  return new ProjectLayerError(
    'TILE_RENDER_ABORTED',
    'Tile rendering was aborted before the source tile mosaic completed.',
  )
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError()
  }
}

async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (items.length === 0) {
    return []
  }

  const results = Array.from({ length: items.length }) as R[]
  let nextIndex = 0

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      throwIfAborted(signal)

      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await mapper(items[currentIndex], currentIndex)
    }
  }

  const workerCount = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return results
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError())
      return
    }

    let timer: ReturnType<typeof setTimeout>

    function cleanup() {
      signal?.removeEventListener('abort', onAbort)
    }

    function onAbort() {
      clearTimeout(timer)
      cleanup()
      reject(createAbortError())
    }

    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function withSourceTileTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  coords: TileCoord,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError())
      return
    }

    let timer: ReturnType<typeof setTimeout>

    function cleanup() {
      signal?.removeEventListener('abort', onAbort)
    }

    function onAbort() {
      clearTimeout(timer)
      cleanup()
      reject(createAbortError())
    }

    timer = setTimeout(() => {
      cleanup()
      reject(new ProjectLayerError(
        'SOURCE_TILE_TIMEOUT',
        `Source tile loading timed out after ${timeoutMs}ms for tile ${coords.z}/${coords.x}/${coords.y}.`,
      ))
    }, timeoutMs)

    signal?.addEventListener('abort', onAbort, { once: true })

    promise
      .then((value) => {
        clearTimeout(timer)
        cleanup()
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timer)
        cleanup()
        reject(error)
      })
  })
}

function waitForConsumer<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError())
      return
    }

    function cleanup() {
      signal?.removeEventListener('abort', onAbort)
    }

    function onAbort() {
      cleanup()
      reject(createAbortError())
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    promise
      .then((value) => {
        cleanup()
        resolve(value)
      })
      .catch((error) => {
        cleanup()
        reject(error)
      })
  })
}

async function loadSourceTileWithRetry(
  fetchSourceTile: (coords: TileCoord, signal?: AbortSignal) => Promise<TileRenderElement>,
  coords: TileCoord,
  retryCount: number,
  retryDelayMs: number,
  sourceTileTimeoutMs: number,
  signal?: AbortSignal,
): Promise<TileRenderElement> {
  let attempt = 0

  while (true) {
    throwIfAborted(signal)

    try {
      return await withSourceTileTimeout(fetchSourceTile(coords, signal), sourceTileTimeoutMs, coords, signal)
    }
    catch (error) {
      if (attempt >= retryCount) {
        throw error
      }

      const delayMs = retryDelayMs * (2 ** attempt)
      attempt += 1
      await sleep(delayMs, signal)
    }
  }
}

function releaseSourceTileEntry(
  sourceTileCache: Map<string, SourceTileCacheEntry>,
  key: string,
  entry: SourceTileCacheEntry,
  signal?: AbortSignal,
): void {
  entry.consumers = Math.max(0, entry.consumers - 1)

  if (entry.consumers === 0 && signal?.aborted && !entry.settled) {
    entry.controller.abort()
    sourceTileCache.delete(key)
  }
}

function evictOldestIdleEntry(sourceTileCache: Map<string, SourceTileCacheEntry>): void {
  for (const [key, entry] of sourceTileCache) {
    if (entry.consumers === 0) {
      sourceTileCache.delete(key)
      return
    }
  }
}

// 统一在一个 canvas 内按依赖窗口绘制源瓦片，输出目标瓦片最终图像。
export async function buildMosaicCanvas(
  dependencies: TileDependency[],
  fetchSourceTile: (coords: TileCoord, signal?: AbortSignal) => Promise<TileRenderElement>,
  tileSize: TileSize,
  interpolation: ResamplingInterpolation,
  maxConcurrency: number,
  sourceTileCache: Map<string, SourceTileCacheEntry>,
  maxSourceCacheSize: number,
  retryCount = 0,
  retryDelayMs = 100,
  sourceTileTimeoutMs = 5000,
  metrics?: MosaicBuildMetrics,
  signal?: AbortSignal,
): Promise<HTMLCanvasElement> {
  throwIfAborted(signal)

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
    throwIfAborted(signal)

    const key = `${dependency.sourceTile.z}:${dependency.sourceTile.x}:${dependency.sourceTile.y}`
    let sourceTileEntry = sourceTileCache.get(key)

    if (sourceTileEntry) {
      sourceTileEntry.consumers += 1
      if (metrics) {
        metrics.cacheHits += 1
      }
    }
    else {
      if (metrics) {
        metrics.cacheMisses += 1
      }
      const controller = new AbortController()
      sourceTileEntry = {
        controller,
        consumers: 1,
        promise: loadSourceTileWithRetry(
          fetchSourceTile,
          dependency.sourceTile,
          retryCount,
          retryDelayMs,
          sourceTileTimeoutMs,
          controller.signal,
        ),
        settled: false,
      }

      const createdEntry = sourceTileEntry

      createdEntry.promise
        .then(() => {
          createdEntry.settled = true
        })
        .catch(() => {
          createdEntry.settled = true
          sourceTileCache.delete(key)
        })

      if (signal?.aborted) {
        releaseSourceTileEntry(sourceTileCache, key, sourceTileEntry, signal)
        throw createAbortError()
      }

      if (maxSourceCacheSize > 0) {
        if (sourceTileCache.size >= maxSourceCacheSize) {
          evictOldestIdleEntry(sourceTileCache)
        }

        sourceTileCache.set(key, sourceTileEntry)
      }
      else {
        sourceTileEntry.promise.catch(() => {})
      }
    }

    let released = false
    const releaseOnce = () => {
      if (released) {
        return
      }

      released = true
      releaseSourceTileEntry(sourceTileCache, key, sourceTileEntry, signal)
    }

    signal?.addEventListener('abort', releaseOnce, { once: true })

    try {
      const sourceTile = await waitForConsumer(sourceTileEntry.promise, signal)

      throwIfAborted(signal)

      return {
        dependency,
        sourceTile,
      }
    }
    finally {
      signal?.removeEventListener('abort', releaseOnce)
      releaseOnce()
    }
  }, signal)

  throwIfAborted(signal)

  for (const { dependency, sourceTile } of sourceTiles) {
    throwIfAborted(signal)

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
