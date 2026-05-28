<script setup lang="ts">
import type { SourceZoomRounding } from '../src'
import L from 'leaflet'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import {
  ProjectLayer,
} from '../src'

import 'leaflet/dist/leaflet.css'

const mapElement = ref<HTMLDivElement | null>(null)
const overlayOpacity = ref(0.5)
const zoomRounding = ref<SourceZoomRounding>('round')
const isSwapped = ref(false)
const tianDiTuToken = ''
let map: L.Map | null = null
let baseLayer: L.Layer | null = null
let overlayLayer: L.GridLayer | null

function createTianDiTuVecLayer(tileMatrixSet: 'c' | 'w'): L.TileLayer {
  const matrixOffset = tileMatrixSet === 'c' ? 1 : 0
  const layer = L.tileLayer('', {
    attribution: '&copy; 天地图',
    maxZoom: 17,
    minZoom: tileMatrixSet === 'c' ? 0 : 1,
    tileSize: 256,
  })

  layer.getTileUrl = (coords: L.Coords): string => {
    const params = new URLSearchParams({
      service: 'WMTS',
      request: 'GetTile',
      version: '1.0.0',
      layer: 'vec',
      style: 'default',
      tilematrixset: tileMatrixSet,
      format: 'tiles',
      tilematrix: String(coords.z + matrixOffset),
      tilerow: String(coords.y),
      tilecol: String(coords.x),
      tk: tianDiTuToken,
    })

    return `https://t0.tianditu.gov.cn/vec_${tileMatrixSet}/wmts?${params.toString()}`
  }

  return layer
}

function applyOverlayState() {
  overlayLayer?.setOpacity(overlayOpacity.value)
}

function getLayerConfig() {
  if (isSwapped.value) {
    return {
      baseCRS: L.CRS.EPSG3857,
      baseMatrixSet: 'w' as const,
      overlayCRS: L.CRS.EPSG4326,
      overlayMatrixSet: 'c' as const,
      title: 'EPSG:3857 地图',
      subtitle: '天地图 4326 矢量瓦片叠加',
    }
  }

  return {
    baseCRS: L.CRS.EPSG4326,
    baseMatrixSet: 'c' as const,
    overlayCRS: L.CRS.EPSG3857,
    overlayMatrixSet: 'w' as const,
    title: 'EPSG:4326 地图',
    subtitle: '天地图 3857 矢量瓦片叠加',
  }
}

function reloadLayers() {
  if (!map) {
    return
  }

  const config = getLayerConfig()
  baseLayer?.remove()
  overlayLayer?.remove()

  baseLayer = createTianDiTuVecLayer(config.baseMatrixSet).addTo(map)
  const sourceLayer = createTianDiTuVecLayer(config.overlayMatrixSet)

  overlayLayer = new ProjectLayer({
    crs: config.overlayCRS,
    layer: sourceLayer,
    zoomRounding: zoomRounding.value,
    attribution: '&copy; 天地图',
  }).setOpacity(overlayOpacity.value)

  overlayLayer.addTo(map)
}

function resetMap() {
  if (!mapElement.value) {
    return
  }

  const center = map?.getCenter() ?? L.latLng(39.9075, 116.3913)
  const zoom = map?.getZoom() ?? 4
  const config = getLayerConfig()

  baseLayer = null
  overlayLayer = null
  map?.remove()
  map = L.map(mapElement.value, {
    crs: config.baseCRS,
    zoomControl: true,
  }).setView(center, zoom)

  reloadLayers()
}

function toggleLayerDirection() {
  isSwapped.value = !isSwapped.value
  resetMap()
}

watch(overlayOpacity, applyOverlayState)
watch(zoomRounding, resetMap)

onMounted(() => {
  resetMap()
})

onUnmounted(() => {
  baseLayer = null
  overlayLayer = null
  map?.remove()
  map = null
})
</script>

<template>
  <main class="debug-page">
    <div ref="mapElement" class="debug-page__map" />

    <section class="debug-page__panel">
      <strong>{{ getLayerConfig().title }}</strong>
      <span>{{ getLayerConfig().subtitle }}</span>

      <label>
        <span>源层级</span>
        <select v-model="zoomRounding" name="zoom-rounding">
          <option value="floor">
            向下取整（更省）
          </option>
          <option value="round">
            四舍五入
          </option>
          <option value="ceil">
            向上取整（更清晰）
          </option>
        </select>
      </label>

      <label class="debug-page__opacity">
        <span>透明度</span>
        <input
          v-model.number="overlayOpacity"
          type="range"
          name="overlay-opacity"
          min="0"
          max="1"
          step="0.05"
        >
        <output>{{ overlayOpacity.toFixed(2) }}</output>
      </label>

      <button type="button" @click="toggleLayerDirection">
        交换底图和叠加层
      </button>
    </section>
  </main>
</template>

<style scoped>
.debug-page {
  margin: 0;
  min-height: 100vh;
}

.debug-page__map {
  height: 100vh;
}

.debug-page__panel {
  position: fixed;
  z-index: 1000;
  top: 12px;
  right: 12px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  width: min(380px, calc(100vw - 24px));
  padding: 12px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  background: #fff;
  box-shadow: 0 2px 8px rgb(0 0 0 / 12%);
  font-size: 13px;
  color: #111827;
  font-family: Inter, 'Segoe UI', Roboto, Arial, sans-serif;
}

.debug-page__panel label {
  display: grid;
  grid-template-columns: 84px 1fr;
  align-items: center;
  gap: 8px;
}

.debug-page__panel input[type='text'],
.debug-page__panel input[type='url'],
.debug-page__panel select {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 5px 7px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font: inherit;
}

.debug-page__panel button {
  padding: 7px 10px;
  border: 1px solid #2563eb;
  border-radius: 4px;
  background: #2563eb;
  color: #fff;
  font: inherit;
  cursor: pointer;
}

.debug-page__opacity {
  display: grid;
  grid-template-columns: 84px 1fr 32px;
  align-items: center;
  gap: 8px;
}

.debug-page__opacity input {
  width: 100%;
}

.debug-page__opacity output {
  min-width: 32px;
  text-align: right;
}
</style>
