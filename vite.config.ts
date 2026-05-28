import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import packageJson from './package.json'

function getPackageName() {
  return packageJson.name
}

function getPackageBaseName() {
  const packageName = getPackageName()
  const scopedMatch = packageName.match(/^@[^/]+\/(.+)$/)
  return scopedMatch ? scopedMatch[1] : packageName
}

function getPackageNameCamelCase() {
  try {
    return getPackageBaseName().replace(/-./g, char => char[1].toUpperCase())
  }
  catch {
    throw new Error('Name property in package.json is missing.')
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  build: {
    outDir: './dist',
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      name: getPackageNameCamelCase(),
    },
  },
  plugins: [
    vue(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./test', import.meta.url)),
    },
  },
})
