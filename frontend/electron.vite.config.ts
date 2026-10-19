import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    // 渲染进程静态资源目录：public/icons（文件图标）按原路径复制到构建产物
    publicDir: resolve('public'),
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
        '@theme': resolve('public/theme')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
