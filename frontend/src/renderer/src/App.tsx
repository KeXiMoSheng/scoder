import { useEffect, useState } from 'react'

// 后端 API 地址，与 backend/.env 的 PORT 保持一致
const API_BASE = 'http://127.0.0.1:39200'

function App(): React.JSX.Element {
  const [status, setStatus] = useState('正在连接后端…')

  useEffect(() => {
    fetch(`${API_BASE}/api/v1/health`)
      .then((res) => res.json())
      .then((data: { service: string }) => setStatus(`后端已连接：${data.service}`))
      .catch(() => setStatus('后端未启动'))
  }, [])

  return (
    <main>
      <h1>scoder</h1>
      <p>{status}</p>
    </main>
  )
}

export default App
