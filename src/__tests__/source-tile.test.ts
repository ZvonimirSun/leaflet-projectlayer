import L from 'leaflet'

import { describe, expect, it, vi } from 'vitest'
import { createSourceTileFetcher } from '../source-tile'

function createUrlCapturingLayer(options?: L.TileLayerOptions): {
  capturedUrls: string[]
  layer: L.TileLayer
} {
  const capturedUrls: string[] = []
  const layer = L.tileLayer('https://tiles.example/{z}/{x}/{y}.png', options)

  ;(layer as any).createTile = vi.fn(function (this: L.TileLayer, coords: L.Coords, done: L.DoneCallback) {
    capturedUrls.push(this.getTileUrl(coords))

    const tile = document.createElement('canvas')
    queueMicrotask(() => done(undefined, tile))
    return tile
  })

  return { capturedUrls, layer }
}

describe('源瓦片调用', () => {
  it('会临时设置 Leaflet 内部状态，让 tms 使用源 CRS 的反向 y', async () => {
    const { capturedUrls, layer } = createUrlCapturingLayer({ tms: true })
    const fetchSourceTile = createSourceTileFetcher(layer, L.CRS.EPSG3857)

    await fetchSourceTile({ x: 0, y: 0, z: 1 })

    expect(capturedUrls).toEqual(['https://tiles.example/1/0/1.png'])
    expect((layer as unknown as { _map?: L.Map })._map).toBeUndefined()
    expect((layer as unknown as { _globalTileRange?: L.Bounds })._globalTileRange).toBeUndefined()
    expect((layer as unknown as { _tileZoom?: number })._tileZoom).toBeUndefined()
  })

  it('会用单次请求代理隔离内部状态，并允许异步 createTile 读取请求状态', async () => {
    const layer = new L.TileLayer('')
    const originalMap = { options: { crs: L.CRS.EPSG4326 } }

    ;(layer as any)._tileZoom = 9
    ;(layer as any)._map = originalMap
    ;(layer as any).createTile = vi.fn(function (this: L.TileLayer, _coords: L.Coords, done: L.DoneCallback) {
      const tile = document.createElement('canvas')

      setTimeout(() => {
        expect(this).not.toBe(layer)
        expect((this as any)._tileZoom).toBe(3)
        expect((this as any)._map.options.crs).toBe(L.CRS.EPSG3857)
        done(undefined, tile)
      }, 0)

      return tile
    })

    const fetchSourceTile = createSourceTileFetcher(layer, L.CRS.EPSG3857)

    await expect(fetchSourceTile({ x: 0, y: 0, z: 3 })).resolves.toBeInstanceOf(HTMLCanvasElement)
    expect((layer as any)._tileZoom).toBe(9)
    expect((layer as any)._map).toBe(originalMap)
  })

  it('会沿用源图层的 zoomOffset 和 zoomReverse 解析瓦片地址', async () => {
    const { capturedUrls, layer } = createUrlCapturingLayer({
      maxZoom: 5,
      zoomOffset: 1,
      zoomReverse: true,
    })
    const fetchSourceTile = createSourceTileFetcher(layer, L.CRS.EPSG3857)

    await fetchSourceTile({ x: 0, y: 0, z: 2 })

    expect(capturedUrls).toEqual(['https://tiles.example/4/0/0.png'])
  })

  it('会按源 CRS 的 wrapLng 包装 source tile x 坐标', async () => {
    const { capturedUrls, layer } = createUrlCapturingLayer()
    const fetchSourceTile = createSourceTileFetcher(layer, L.CRS.EPSG3857)

    await fetchSourceTile({ x: 2, y: 0, z: 1 })

    expect(capturedUrls).toEqual(['https://tiles.example/1/0/0.png'])
  })

  it('source layer 设置 noWrap 时不会包装 source tile 坐标', async () => {
    const { capturedUrls, layer } = createUrlCapturingLayer({ noWrap: true })
    const fetchSourceTile = createSourceTileFetcher(layer, L.CRS.EPSG3857)

    await fetchSourceTile({ x: 2, y: 0, z: 1 })

    expect(capturedUrls).toEqual(['https://tiles.example/1/2/0.png'])
  })

  it('取消请求时会触发源瓦片卸载事件', async () => {
    const controller = new AbortController()
    const layer = new L.TileLayer('')
    let image!: HTMLImageElement
    const tileUnloadSpy = vi.fn()

    layer.on('tileunload', tileUnloadSpy)

    ;(layer as any).createTile = vi.fn(() => {
      image = document.createElement('img')
      image.src = 'https://tiles.example/1/0/0.png'
      return image
    })

    const fetchSourceTile = createSourceTileFetcher(layer, L.CRS.EPSG3857)
    const promise = fetchSourceTile({ x: 0, y: 0, z: 1 }, controller.signal)

    controller.abort()

    await expect(promise).rejects.toMatchObject({
      debugCode: 'TILE_RENDER_ABORTED',
    })
    expect(tileUnloadSpy).toHaveBeenCalledTimes(1)
    expect(tileUnloadSpy.mock.calls[0]?.[0]).toMatchObject({
      coords: { x: 0, y: 0, z: 1 },
      tile: image,
    })
  })
})
