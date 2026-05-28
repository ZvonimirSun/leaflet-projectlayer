import L from 'leaflet'

import { vi } from 'vitest'

export function createTestCRSIdentity(): L.CRS {
  const scale = (zoom: number) => 256 * (2 ** zoom)

  return {
    ...L.CRS.EPSG4326,
    project(latlng) {
      const point = L.latLng(latlng)
      return L.point(point.lng, point.lat)
    },
    unproject(point) {
      const projected = L.point(point)
      return L.latLng(projected.y, projected.x)
    },
    latLngToPoint(latlng, zoom) {
      const point = L.latLng(latlng)
      const currentScale = scale(zoom)
      return L.point(
        ((point.lng + 180) / 360) * currentScale,
        ((90 - point.lat) / 180) * currentScale,
      )
    },
    pointToLatLng(point, zoom) {
      const projected = L.point(point)
      const currentScale = scale(zoom)
      return L.latLng(
        90 - (projected.y / currentScale) * 180,
        (projected.x / currentScale) * 360 - 180,
      )
    },
    scale,
  }
}

export function createTileLayerMock(
  createTileImpl?: (coords: L.Coords, done: L.DoneCallback) => HTMLImageElement | HTMLCanvasElement,
  options?: L.TileLayerOptions,
): L.TileLayer {
  const layer = new L.TileLayer('', options)
  ;(layer as any).createTile = vi.fn((coords: L.Coords, done: L.DoneCallback) => {
    if (createTileImpl) {
      return createTileImpl(coords, done)
    }

    const tile = document.createElement('canvas')
    queueMicrotask(() => done(undefined, tile))
    return tile
  })

  return layer
}
