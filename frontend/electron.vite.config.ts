import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    // 端口统一使用 39xxx 段，避开常见默认端口
    server: {
      host: '127.0.0.1',
      port: 39273,
      strictPort: true
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
        '@theme': resolve('theme')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
