import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element')

const root = createRoot(container)

if (!window.openfuture) {
  root.render(
    <div className="fatal-screen">
      <h1>OpenFuture 无法启动</h1>
      <p>预加载桥接未初始化。请重新启动应用；若问题持续，请检查安装是否完整。</p>
    </div>
  )
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
