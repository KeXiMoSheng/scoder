import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initThemes } from './lib/theme'

// 首屏渲染前完成主题注册与应用（含 userData 中导入的主题），避免先闪默认配色再切换。
// 主题初始化失败不应阻塞界面：记录错误后照常渲染，回退到 CSS 默认配色。
void initThemes()
  .catch((error) => {
    console.error('主题初始化失败，使用默认配色', error)
  })
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  })
