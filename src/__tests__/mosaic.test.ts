import { describe, expect, it, vi } from 'vitest'
import { buildMosaicCanvas } from '../mosaic'

describe('拼接画布', () => {
  it('会按裁剪窗口绘制源瓦片', async () => {
    const drawImage = vi.fn()
    const mockContext = {
      drawImage,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'low',
    }
    const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    getContextSpy.mockReturnValue(mockContext as unknown as CanvasRenderingContext2D)

    const fetchSourceTile = vi.fn(async () => document.createElement('canvas'))
    const dependencies = [{
      sourceTile: { x: 0, y: 0, z: 1 },
      srcX: 0,
      srcY: 0,
      srcW: 128,
      srcH: 128,
      dstX: 64,
      dstY: 64,
      dstW: 128,
      dstH: 128,
    }]

    const mosaic = await buildMosaicCanvas(
      dependencies,
      fetchSourceTile,
      { width: 256, height: 256 },
      'medium',
      8,
      new Map(),
      256,
    )

    expect(mockContext.imageSmoothingEnabled).toBe(true)
    expect(mockContext.imageSmoothingQuality).toBe('medium')
    expect(drawImage.mock.calls[0]?.slice(1)).toEqual([0, 0, 128, 128, 64, 64, 128, 128])
    expect(mosaic.width).toBe(256)
    expect(mosaic.height).toBe(256)

    getContextSpy.mockRestore()
  })

  it('会复用相同源瓦片的 Promise，避免重复请求', async () => {
    const drawImage = vi.fn()
    const mockContext = {
      drawImage,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'medium',
    }
    const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    getContextSpy.mockReturnValue(mockContext as unknown as CanvasRenderingContext2D)

    const fetchSourceTile = vi.fn(async () => document.createElement('canvas'))
    const sharedTile = { x: 0, y: 0, z: 1 }
    const dependencies = [
      { sourceTile: sharedTile, srcX: 0, srcY: 0, srcW: 128, srcH: 128, dstX: 0, dstY: 0, dstW: 128, dstH: 128 },
      { sourceTile: { ...sharedTile }, srcX: 128, srcY: 0, srcW: 128, srcH: 128, dstX: 128, dstY: 0, dstW: 128, dstH: 128 },
    ]

    await buildMosaicCanvas(
      dependencies,
      fetchSourceTile,
      { width: 256, height: 256 },
      'medium',
      8,
      new Map(),
      256,
    )

    expect(fetchSourceTile).toHaveBeenCalledTimes(1)
    expect(drawImage).toHaveBeenCalledTimes(2)

    getContextSpy.mockRestore()
  })

  it('会在源瓦片加载超时时抛出规范化错误', async () => {
    const mockContext = {
      drawImage: vi.fn(),
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'medium',
    }
    const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    getContextSpy.mockReturnValue(mockContext as unknown as CanvasRenderingContext2D)

    const fetchSourceTile = vi.fn(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      return document.createElement('canvas')
    })
    const dependencies = [{
      sourceTile: { x: 0, y: 0, z: 0 },
      srcX: 0,
      srcY: 0,
      srcW: 256,
      srcH: 256,
      dstX: 0,
      dstY: 0,
      dstW: 256,
      dstH: 256,
    }]

    await expect(buildMosaicCanvas(
      dependencies,
      fetchSourceTile,
      { width: 256, height: 256 },
      'medium',
      8,
      new Map(),
      256,
      0,
      0,
      1,
    )).rejects.toMatchObject({
      code: 'TILE_LOAD_ERROR',
      debugCode: 'SOURCE_TILE_TIMEOUT',
    })

    getContextSpy.mockRestore()
  })

  it('非方形 tileSize 会输出对应宽高的拼接画布', async () => {
    const mockContext = {
      drawImage: vi.fn(),
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'medium',
    }
    const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    getContextSpy.mockReturnValue(mockContext as unknown as CanvasRenderingContext2D)

    const mosaic = await buildMosaicCanvas(
      [],
      vi.fn(async () => document.createElement('canvas')),
      { width: 512, height: 256 },
      'medium',
      8,
      new Map(),
      256,
    )

    expect(mosaic.width).toBe(512)
    expect(mosaic.height).toBe(256)

    getContextSpy.mockRestore()
  })

  it('会统计 sourceTileCache 的命中与未命中', async () => {
    const drawImage = vi.fn()
    const mockContext = {
      drawImage,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'medium',
    }
    const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    getContextSpy.mockReturnValue(mockContext as unknown as CanvasRenderingContext2D)

    const fetchSourceTile = vi.fn(async () => document.createElement('canvas'))
    const dependencies = [
      { sourceTile: { x: 0, y: 0, z: 1 }, srcX: 0, srcY: 0, srcW: 128, srcH: 128, dstX: 0, dstY: 0, dstW: 128, dstH: 128 },
      { sourceTile: { x: 0, y: 0, z: 1 }, srcX: 128, srcY: 0, srcW: 128, srcH: 128, dstX: 128, dstY: 0, dstW: 128, dstH: 128 },
      { sourceTile: { x: 1, y: 0, z: 1 }, srcX: 0, srcY: 128, srcW: 128, srcH: 128, dstX: 0, dstY: 128, dstW: 128, dstH: 128 },
    ]
    const metrics = { cacheHits: 0, cacheMisses: 0 }

    await buildMosaicCanvas(
      dependencies,
      fetchSourceTile,
      { width: 256, height: 256 },
      'medium',
      8,
      new Map(),
      256,
      0,
      100,
      5000,
      metrics,
    )

    expect(metrics).toEqual({ cacheHits: 1, cacheMisses: 2 })

    getContextSpy.mockRestore()
  })

  it('canvas context 不可用时会抛出 CANVAS_CONTEXT_UNAVAILABLE', async () => {
    const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    getContextSpy.mockReturnValue(null)

    await expect(buildMosaicCanvas(
      [],
      vi.fn(async () => document.createElement('canvas')),
      { width: 256, height: 256 },
      'medium',
      8,
      new Map(),
      256,
    )).rejects.toMatchObject({
      code: 'RENDER_ERROR',
      debugCode: 'CANVAS_CONTEXT_UNAVAILABLE',
    })

    getContextSpy.mockRestore()
  })

  it('取消拼接任务时会中止未完成的源瓦片请求', async () => {
    const mockContext = {
      drawImage: vi.fn(),
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'medium',
    }
    const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    getContextSpy.mockReturnValue(mockContext as unknown as CanvasRenderingContext2D)

    const controller = new AbortController()
    let sourceSignal!: AbortSignal
    const fetchSourceTile = vi.fn((_coords, signal?: AbortSignal) => {
      sourceSignal = signal!

      return new Promise<HTMLCanvasElement>((_, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new Error('source aborted'))
        }, { once: true })
      })
    })

    const promise = buildMosaicCanvas(
      [{
        sourceTile: { x: 0, y: 0, z: 0 },
        srcX: 0,
        srcY: 0,
        srcW: 256,
        srcH: 256,
        dstX: 0,
        dstY: 0,
        dstW: 256,
        dstH: 256,
      }],
      fetchSourceTile,
      { width: 256, height: 256 },
      'medium',
      8,
      new Map(),
      256,
      0,
      0,
      5000,
      undefined,
      controller.signal,
    )

    await vi.waitFor(() => {
      expect(fetchSourceTile).toHaveBeenCalledTimes(1)
    })

    controller.abort()

    await expect(promise).rejects.toMatchObject({
      debugCode: 'TILE_RENDER_ABORTED',
    })
    expect(sourceSignal.aborted).toBe(true)

    getContextSpy.mockRestore()
  })

  it('共享源瓦片时单个目标瓦片取消不会提前中止源请求', async () => {
    const mockContext = {
      drawImage: vi.fn(),
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'medium',
    }
    const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    getContextSpy.mockReturnValue(mockContext as unknown as CanvasRenderingContext2D)

    const firstController = new AbortController()
    const secondController = new AbortController()
    const sourceTileCache = new Map()
    let sourceSignal!: AbortSignal
    const fetchSourceTile = vi.fn((_coords, signal?: AbortSignal) => {
      sourceSignal = signal!

      return new Promise<HTMLCanvasElement>((_, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new Error('source aborted'))
        }, { once: true })
      })
    })
    const dependency = {
      sourceTile: { x: 0, y: 0, z: 0 },
      srcX: 0,
      srcY: 0,
      srcW: 256,
      srcH: 256,
      dstX: 0,
      dstY: 0,
      dstW: 256,
      dstH: 256,
    }

    const firstPromise = buildMosaicCanvas(
      [dependency],
      fetchSourceTile,
      { width: 256, height: 256 },
      'medium',
      8,
      sourceTileCache,
      256,
      0,
      0,
      5000,
      undefined,
      firstController.signal,
    )
    const secondPromise = buildMosaicCanvas(
      [dependency],
      fetchSourceTile,
      { width: 256, height: 256 },
      'medium',
      8,
      sourceTileCache,
      256,
      0,
      0,
      5000,
      undefined,
      secondController.signal,
    )

    await vi.waitFor(() => {
      expect(fetchSourceTile).toHaveBeenCalledTimes(1)
    })
    await Promise.resolve()

    firstController.abort()
    await expect(firstPromise).rejects.toMatchObject({
      debugCode: 'TILE_RENDER_ABORTED',
    })
    expect(sourceSignal.aborted).toBe(false)

    secondController.abort()
    await expect(secondPromise).rejects.toMatchObject({
      debugCode: 'TILE_RENDER_ABORTED',
    })
    expect(sourceSignal.aborted).toBe(true)

    getContextSpy.mockRestore()
  })
})
