import L from 'leaflet'

import { describe, expect, it, vi } from 'vitest'
import { ProjectLayer, projectLayer } from '../index'
import { createTestCRSIdentity, createTileLayerMock } from './helpers'

type TestProjectLayer = L.GridLayer & {
  createTile: (coords: L.Coords, done: L.DoneCallback) => HTMLElement
  options: L.GridLayerOptions
}

type ProjectLayerTestError = Error & {
  code?: string
  debugCode?: string
  debugMessage?: string
}

function bindLayerToMap(layer: TestProjectLayer, crs: L.CRS = L.CRS.EPSG3857): void {
  ;(layer as unknown as { _map?: { options: { crs: L.CRS } } })._map = {
    options: { crs },
  }
}

function tileCoords(x: number, y: number, z: number): L.Coords {
  const coords = L.point(x, y) as L.Coords
  coords.z = z
  return coords
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

function callBeforeAdd(layer: L.GridLayer, crs: L.CRS): void {
  ;(layer as any).beforeAdd({
    _addZoomLimit: vi.fn(),
    options: { crs },
  })
}

function mockCanvasContext(): ReturnType<typeof vi.spyOn> {
  const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
  getContextSpy.mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
  return getContextSpy
}

function createDonePromise(): {
  done: ReturnType<typeof vi.fn<L.DoneCallback>>
  promise: Promise<[ProjectLayerTestError | undefined, HTMLElement | undefined]>
} {
  const done = vi.fn<L.DoneCallback>()
  const promise = new Promise<[ProjectLayerTestError | undefined, HTMLElement | undefined]>((resolve) => {
    done.mockImplementation((error, tile) => {
      resolve([error, tile])
    })
  })

  return { done, promise }
}

async function expectDoneCalledOnce(done: ReturnType<typeof vi.fn<L.DoneCallback>>): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      expect(done).toHaveBeenCalledTimes(1)
      resolve()
    }, 0)
  })
}

describe('projectLayer 公开行为', () => {
  it('是标准 Leaflet GridLayer 扩展，并且只额外要求 crs/layer 参数', () => {
    const sourceLayer = createTileLayerMock()

    const layer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: sourceLayer,
      opacity: 0.45,
    }) as TestProjectLayer

    expect(layer).toBeInstanceOf(L.GridLayer)
    expect(layer.options.opacity).toBe(0.45)
  })

  it('提供 projectLayer 工厂方法用于 Leaflet 风格创建', () => {
    const layer = projectLayer({
      crs: createTestCRSIdentity(),
      layer: createTileLayerMock(),
    })

    expect(layer).toBeInstanceOf(L.GridLayer)
  })

  it('挂载前会把源图层 zoom 范围映射成目标地图 zoom 范围', () => {
    const layer = new ProjectLayer({
      crs: createZoomShiftedCRS(1),
      layer: createTileLayerMock(undefined, {
        maxZoom: 5,
        minZoom: 2,
      }),
    }) as TestProjectLayer

    callBeforeAdd(layer, createTestCRSIdentity())

    expect(layer.options.minZoom).toBe(3)
    expect(layer.options.maxZoom).toBe(6)
  })

  it('用户设置 ProjectLayer zoom 范围时，会尊重用户配置', () => {
    const layer = new ProjectLayer({
      crs: createZoomShiftedCRS(1),
      layer: createTileLayerMock(undefined, {
        maxZoom: 5,
        minZoom: 2,
      }),
      maxZoom: 10,
      minZoom: 1,
    }) as TestProjectLayer

    callBeforeAdd(layer, createTestCRSIdentity())

    expect(layer.options.minZoom).toBe(1)
    expect(layer.options.maxZoom).toBe(10)
  })

  it('默认复用源 TileLayer 的 bounds，但尊重用户显式设置的 bounds', () => {
    const sourceBounds = L.latLngBounds([10, 20], [30, 40])
    const requestedBounds = L.latLngBounds([-5, -6], [7, 8])

    const inheritedLayer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: createTileLayerMock(undefined, {
        bounds: sourceBounds,
      }),
    }) as TestProjectLayer
    const explicitLayer = new ProjectLayer({
      bounds: requestedBounds,
      crs: createTestCRSIdentity(),
      layer: createTileLayerMock(undefined, {
        bounds: sourceBounds,
      }),
    }) as TestProjectLayer

    expect(inheritedLayer.options.bounds).toBe(sourceBounds)
    expect(explicitLayer.options.bounds).toBe(requestedBounds)
  })

  it('createTile 会同步返回 canvas，并沿用 Leaflet tileSize 选项', () => {
    const layer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: createTileLayerMock(),
      tileSize: 512,
    }) as TestProjectLayer

    const done = vi.fn()
    const tile = layer.createTile(tileCoords(1, 2, 3), done) as HTMLCanvasElement

    expect(tile).toBeInstanceOf(HTMLCanvasElement)
    expect(tile.width).toBe(512)
    expect(tile.height).toBe(512)
  })

  it('createTile 在非方形 tileSize 下会返回对应尺寸 canvas', () => {
    const layer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: createTileLayerMock(),
      tileSize: L.point(512, 256),
    }) as TestProjectLayer

    const done = vi.fn()
    const tile = layer.createTile(tileCoords(1, 2, 3), done) as HTMLCanvasElement

    expect(tile).toBeInstanceOf(HTMLCanvasElement)
    expect(tile.width).toBe(512)
    expect(tile.height).toBe(256)
  })

  it('正常渲染时会异步回调 done，并调用源图层 createTile', async () => {
    const getContextSpy = mockCanvasContext()
    const done = vi.fn()
    const sourceLayer = createTileLayerMock()

    const layer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: sourceLayer,
    }) as TestProjectLayer
    bindLayerToMap(layer)

    const tile = layer.createTile(tileCoords(0, 0, 0), done)

    await expectDoneCalledOnce(done)

    const [errorFromDone, tileFromDone] = done.mock.calls[0] as [ProjectLayerTestError | undefined, HTMLCanvasElement]

    expect(errorFromDone).toBeFalsy()
    expect(tileFromDone).toBe(tile)
    expect((sourceLayer as any).createTile).toHaveBeenCalledTimes(1)

    getContextSpy.mockRestore()
  })

  it('多次 createTile 命中相同源瓦片时会复用内部缓存', async () => {
    const getContextSpy = mockCanvasContext()
    const sourceLayer = createTileLayerMock()

    const layer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: sourceLayer,
    }) as TestProjectLayer
    bindLayerToMap(layer)

    const doneFirst = vi.fn()
    const doneSecond = vi.fn()

    layer.createTile(tileCoords(0, 0, 0), doneFirst)

    await expectDoneCalledOnce(doneFirst)

    layer.createTile(tileCoords(0, 0, 0), doneSecond)

    await expectDoneCalledOnce(doneSecond)

    expect((sourceLayer as any).createTile).toHaveBeenCalledTimes(1)

    getContextSpy.mockRestore()
  })

  it('源图层 tileSize 更小时，一个目标瓦片会请求多个源瓦片', async () => {
    const getContextSpy = mockCanvasContext()
    const sourceLayer = createTileLayerMock(undefined, { tileSize: 128 })
    const layer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: sourceLayer,
      tileSize: 256,
    }) as TestProjectLayer
    bindLayerToMap(layer)

    const done = vi.fn()

    layer.createTile(tileCoords(0, 0, 0), done)

    await expectDoneCalledOnce(done)

    expect((sourceLayer as any).createTile).toHaveBeenCalledTimes(4)

    getContextSpy.mockRestore()
  })

  it('源 CRS 比例尺不同时，会换算后使用对应的源瓦片 zoom', async () => {
    const getContextSpy = mockCanvasContext()
    const sourceLayer = createTileLayerMock()
    const layer = new ProjectLayer({
      crs: createZoomShiftedCRS(1),
      layer: sourceLayer,
    }) as TestProjectLayer
    bindLayerToMap(layer, createTestCRSIdentity())

    const done = vi.fn()

    layer.createTile(tileCoords(0, 0, 3), done)

    await expectDoneCalledOnce(done)

    expect((sourceLayer as any).createTile).toHaveBeenCalledWith(
      expect.objectContaining({ z: 2 }),
      expect.any(Function),
    )

    getContextSpy.mockRestore()
  })

  it('zoomRounding 会调整依赖计算使用的源瓦片 zoom 取整策略', async () => {
    const getContextSpy = mockCanvasContext()
    const sourceLayer = createTileLayerMock()
    const layer = new ProjectLayer({
      crs: createZoomShiftedCRS(0.4),
      layer: sourceLayer,
      zoomRounding: 'ceil',
    }) as TestProjectLayer
    bindLayerToMap(layer, createTestCRSIdentity())

    const done = vi.fn()

    layer.createTile(tileCoords(0, 0, 3), done)

    await expectDoneCalledOnce(done)

    expect((sourceLayer as any).createTile).toHaveBeenCalledWith(
      expect.objectContaining({ z: 3 }),
      expect.any(Function),
    )

    getContextSpy.mockRestore()
  })

  it('源图层设置 maxNativeZoom 时，会按 Leaflet 原生逻辑限制源瓦片 zoom', async () => {
    const getContextSpy = mockCanvasContext()
    const sourceLayer = createTileLayerMock(undefined, { maxNativeZoom: 1 })
    const layer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: sourceLayer,
    }) as TestProjectLayer
    bindLayerToMap(layer, createTestCRSIdentity())

    const done = vi.fn()

    layer.createTile(tileCoords(0, 0, 3), done)

    await expectDoneCalledOnce(done)

    expect((sourceLayer as any).createTile).toHaveBeenCalledWith(
      expect.objectContaining({ z: 1 }),
      expect.any(Function),
    )

    getContextSpy.mockRestore()
  })

  it('未挂载到地图时无法读取目标 CRS，会通过 done 返回错误', async () => {
    const { done, promise } = createDonePromise()
    const layer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: createTileLayerMock(),
    }) as TestProjectLayer

    layer.createTile(tileCoords(0, 0, 0), done)

    const [errorFromDone] = await promise

    expect(done).toHaveBeenCalledTimes(1)
    expect(errorFromDone).toBeInstanceOf(Error)
    expect(errorFromDone?.code).toBe('CONFIG_ERROR')
    expect(errorFromDone?.debugCode).toBe('MISSING_MAP_CRS')
    expect(errorFromDone?.debugMessage).toContain('Missing map CRS')
  })

  it('渲染时会使用绑定地图上的目标 CRS', async () => {
    const getContextSpy = mockCanvasContext()
    const { done, promise } = createDonePromise()
    const layer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: createTileLayerMock(),
    }) as TestProjectLayer
    bindLayerToMap(layer, L.CRS.EPSG4326)

    layer.createTile(tileCoords(0, 0, 0), done)

    const [errorFromDone] = await promise

    expect(done).toHaveBeenCalledTimes(1)
    expect(errorFromDone).toBeFalsy()

    getContextSpy.mockRestore()
  })

  it('跨经线目标 CRS 下 createTile 会完成渲染回调', async () => {
    const getContextSpy = mockCanvasContext()
    const { done, promise } = createDonePromise()
    const layer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: createTileLayerMock(),
    }) as TestProjectLayer
    bindLayerToMap(layer, createAntimeridianCrossingCRS())

    layer.createTile(tileCoords(0, 0, 0), done)

    const [errorFromDone] = await promise

    expect(done).toHaveBeenCalledTimes(1)
    expect(errorFromDone).toBeFalsy()

    getContextSpy.mockRestore()
  })

  it('会触发 tilemetrics 事件并提供缓存与耗时指标', async () => {
    const getContextSpy = mockCanvasContext()
    const sourceLayer = createTileLayerMock(undefined, { tileSize: 128 })
    const layer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: sourceLayer,
    }) as TestProjectLayer
    bindLayerToMap(layer)

    const metricsSpy = vi.fn()
    layer.on('tilemetrics', metricsSpy)

    const done = vi.fn()
    layer.createTile(tileCoords(0, 0, 0), done)

    await expectDoneCalledOnce(done)

    expect(metricsSpy).toHaveBeenCalledTimes(1)
    const [metrics] = metricsSpy.mock.calls[0] as [Record<string, unknown>]
    expect(metrics.coords).toEqual({ x: 0, y: 0, z: 0 })
    expect(metrics.sourceTileCount).toBe(4)
    expect(metrics.dependencyCount).toBe(4)
    expect(metrics.cacheHits).toBe(0)
    expect(metrics.cacheMisses).toBe(4)
    expect(typeof metrics.renderDurationMs).toBe('number')
    expect((metrics.renderDurationMs as number)).toBeGreaterThanOrEqual(0)

    getContextSpy.mockRestore()
  })

  it('tilemetrics 监听器抛错时不影响 createTile 回调', async () => {
    const getContextSpy = mockCanvasContext()
    const layer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: createTileLayerMock(),
    }) as TestProjectLayer
    bindLayerToMap(layer)

    layer.on('tilemetrics', () => {
      throw new Error('metrics listener failure')
    })

    const done = vi.fn()
    layer.createTile(tileCoords(0, 0, 0), done)

    await expectDoneCalledOnce(done)

    const [errorFromDone] = done.mock.calls[0] as [ProjectLayerTestError | undefined, HTMLCanvasElement]
    expect(errorFromDone).toBeFalsy()

    getContextSpy.mockRestore()
  })

  it('tileerror 监听器抛错时不影响 createTile 回调', async () => {
    const getContextSpy = mockCanvasContext()
    const layer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: createTileLayerMock(),
    }) as TestProjectLayer
    bindLayerToMap(layer)

    layer.on('tileerror', () => {
      throw new Error('tile error listener failure')
    })

    const done = vi.fn()
    layer.createTile(tileCoords(0, 0, 0), done)

    await expectDoneCalledOnce(done)

    const [errorFromDone] = done.mock.calls[0] as [ProjectLayerTestError | undefined, HTMLCanvasElement]
    expect(errorFromDone).toBeFalsy()

    getContextSpy.mockRestore()
  })

  it('tile 渲染失败时会触发 tileerror 并提供公共码与调试信息', async () => {
    const { done, promise } = createDonePromise()
    const layer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: createTileLayerMock(undefined, { tileSize: 1 }),
      tileSize: 256,
    }) as TestProjectLayer
    bindLayerToMap(layer)

    const tileErrorSpy = vi.fn()
    layer.on('tileerror', tileErrorSpy)

    layer.createTile(tileCoords(0, 0, 0), done)

    const [errorFromDone] = await promise

    expect(errorFromDone?.code).toBe('TILE_LIMIT_EXCEEDED')
    expect(errorFromDone?.debugCode).toBe('TOO_MANY_SOURCE_TILES')

    expect(tileErrorSpy).toHaveBeenCalledTimes(1)
    const [payload] = tileErrorSpy.mock.calls[0] as [Record<string, unknown>]
    expect(payload.coords).toEqual({ x: 0, y: 0, z: 0 })
    expect(payload.code).toBe('TILE_LIMIT_EXCEEDED')
    expect(payload.debugCode).toBe('TOO_MANY_SOURCE_TILES')
    expect(payload.debugMessage).toContain('Source tile limit exceeded')
  })

  it('source tiles 超过上限时会返回 TILE_LIMIT_EXCEEDED 错误', async () => {
    const { done, promise } = createDonePromise()
    const layer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: createTileLayerMock(undefined, { tileSize: 1 }),
      tileSize: 256,
    }) as TestProjectLayer
    bindLayerToMap(layer)

    layer.createTile(tileCoords(0, 0, 0), done)

    const [errorFromDone] = await promise

    expect(done).toHaveBeenCalledTimes(1)
    expect(errorFromDone?.code).toBe('TILE_LIMIT_EXCEEDED')
    expect(errorFromDone?.debugCode).toBe('TOO_MANY_SOURCE_TILES')
    expect(errorFromDone?.debugMessage).toContain('Source tile limit exceeded')
  })

  it('dependencies 超过上限时会返回 TILE_LIMIT_EXCEEDED 错误', async () => {
    const { done, promise } = createDonePromise()
    const layer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: createTileLayerMock(undefined, { tileSize: L.point(1, 256) }),
      tileSize: 256,
    }) as TestProjectLayer
    bindLayerToMap(layer)

    layer.createTile(tileCoords(0, 0, 0), done)

    const [errorFromDone] = await promise

    expect(done).toHaveBeenCalledTimes(1)
    expect(errorFromDone?.code).toBe('TILE_LIMIT_EXCEEDED')
    expect(errorFromDone?.debugCode).toBe('TOO_MANY_TILE_DEPENDENCIES')
    expect(errorFromDone?.debugMessage).toContain('Tile dependency limit exceeded')
  })

  it('源图层返回不支持的 tile 元素时会返回 TILE_LOAD_ERROR', async () => {
    const getContextSpy = mockCanvasContext()
    const { done, promise } = createDonePromise()
    const sourceLayer = createTileLayerMock(() => document.createElement('div') as unknown as HTMLCanvasElement)

    const layer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: sourceLayer,
    }) as TestProjectLayer
    bindLayerToMap(layer)

    layer.createTile(tileCoords(0, 0, 0), done)

    const [errorFromDone] = await promise

    expect(done).toHaveBeenCalledTimes(1)
    expect(errorFromDone?.code).toBe('TILE_LOAD_ERROR')
    expect(errorFromDone?.debugCode).toBe('SOURCE_TILE_UNSUPPORTED_ELEMENT')
    expect(errorFromDone?.debugMessage).toContain('unsupported tile element')

    getContextSpy.mockRestore()
  })

  it('源图层图片加载失败时会返回 TILE_LOAD_ERROR', async () => {
    const getContextSpy = mockCanvasContext()
    const { done, promise } = createDonePromise()
    const sourceLayer = createTileLayerMock(() => {
      const image = document.createElement('img')
      queueMicrotask(() => {
        image.dispatchEvent(new Event('error'))
      })
      return image
    })

    const layer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: sourceLayer,
    }) as TestProjectLayer
    bindLayerToMap(layer)

    layer.createTile(tileCoords(0, 0, 0), done)

    const [errorFromDone] = await promise

    expect(done).toHaveBeenCalledTimes(1)
    expect(errorFromDone?.code).toBe('TILE_LOAD_ERROR')
    expect(errorFromDone?.debugCode).toBe('SOURCE_TILE_LOAD_FAILED')
    expect(errorFromDone?.debugMessage).toContain('Source tile failed to load')

    getContextSpy.mockRestore()
  })

  it('源瓦片加载失败时会通过 done 返回规范化错误', async () => {
    const getContextSpy = mockCanvasContext()
    const { done, promise } = createDonePromise()
    const sourceLayer = createTileLayerMock(() => {
      throw new Error('mock source tile load failure')
    })

    const layer = new ProjectLayer({
      crs: createTestCRSIdentity(),
      layer: sourceLayer,
    }) as TestProjectLayer
    bindLayerToMap(layer)

    const tile = layer.createTile(tileCoords(0, 0, 0), done)

    const [errorFromDone, tileFromDone] = await promise

    expect(done).toHaveBeenCalledTimes(1)
    expect(errorFromDone).toBeInstanceOf(Error)
    expect(errorFromDone?.code).toBe('UNKNOWN_ERROR')
    expect(errorFromDone?.debugCode).toBe('PIPELINE_NOT_IMPLEMENTED')
    expect(errorFromDone?.debugMessage).toContain('mock source tile load failure')
    expect(tileFromDone).toBe(tile)

    getContextSpy.mockRestore()
  })
})
