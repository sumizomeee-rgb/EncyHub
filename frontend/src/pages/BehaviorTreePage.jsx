import { useEffect, useState } from 'react'
import BehaviorTree from './BehaviorTree'
import { newId } from '../utils/behaviorTree'

export default function BehaviorTreePage() {
  const [params] = useState(() => new URLSearchParams(window.location.search))
  const [clientId, setClientId] = useState(() => params.get('client') || '')
  const [clients, setClients] = useState([])
  const [error, setError] = useState('')
  // 新页签保留自己的草稿，刷新可恢复；不复制易失效的对象绑定。
  const [draftKey] = useState(() => /^bt\.editorDraft\.[\w-]+$/.test(params.get('draft') || '') ? params.get('draft') : `bt.editorDraft.${newId()}`)
  useEffect(() => {
    const next = new URLSearchParams(window.location.search)
    next.set('draft', draftKey)
    next.set('client', clientId)
    window.history.replaceState(window.history.state, '', `${window.location.pathname}?${next}`)
  }, [draftKey, clientId])
  useEffect(() => {
    const title = document.title
    document.title = '注入行为树 · 放大编辑'
    let cancelled = false, timer
    async function poll() {
      try {
        const response = await fetch('/api/gm_console/clients')
        if (!response.ok) throw new Error(`客户端列表读取失败：${response.status}`)
        const data = await response.json()
        if (!cancelled) { setClients(data.clients || []); setError('') }
      } catch (e) { if (!cancelled) setError(e.message) }
      if (!cancelled) timer = setTimeout(poll, 5000)
    }
    poll()
    return () => { cancelled = true; clearTimeout(timer); document.title = title }
  }, [])
  const client = clients.find(c => c.id === clientId)
  return <main className="bt-expanded-page">
    <header className="bt-expanded-head">
      <h1>注入行为树</h1>
      <label>目标客户端 <select aria-label="目标客户端" value={clientId} onChange={e => setClientId(e.target.value)}>
        <option value="">选择客户端</option>
        {clientId && !client && <option value={clientId}>{clientId}（未连接）</option>}
        {clients.map(c => <option key={c.id} value={c.id}>{c.device ? `${c.device} · ${c.id}` : c.id}{c.online === false ? '（离线）' : ''}</option>)}
      </select></label>
      <span>独立编辑草稿 · 保存预设后可在原页打开 · 运行状态默认只读</span>
    </header>
    {error && <p role="alert">{error}</p>}
    <BehaviorTree selectedClient={client} broadcastMode={false} active expanded draftKey={draftKey}/>
  </main>
}
