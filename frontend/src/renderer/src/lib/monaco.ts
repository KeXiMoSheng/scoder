import * as monaco from 'monaco-editor'
// 导入路径经 monaco-editor 0.57 的 exports 映射解析（monaco-editor/*.js -> esm/vs/*.js），
// 不能带 esm/vs 前缀且必须显式带 .js 扩展名，否则构建时无法解析
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker&inline'
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker&inline'
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker&inline'
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker&inline'
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker&inline'

// Electron 生产环境运行在 file:// 协议下，跨源加载 worker 脚本会被拒绝；
// ?worker&inline 让 Vite 把 worker 以内联 blob 方式打包，配合 index.html 中
// CSP 的 worker-src blob: 才能在打包环境正常启动。
// 按语言标签分发 worker，未匹配的语言（如 python/java 等纯语法高亮）回退到基础 worker
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      default:
        return new editorWorker()
    }
  }
}

export { monaco }
