import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Plus, Send, Radio, Smartphone, ChevronRight, ChevronDown,
  X, Trash2, Terminal, Users, Code, Megaphone, MessageSquare,
  Home, ZoomIn, ZoomOut, Edit, Layers, Play, Globe, RefreshCw, Activity
} from 'lucide-react'
import { useToast } from '../components/Toast'
import AnimatorViewer from './AnimatorViewer'
import LuaUiInspector from './LuaUiInspector'

function GmConsole() {
  const navigate = useNavigate()
  const toast = useToast()
  const [listeners, setListeners] = useState([])
  const [clients, setClients] = useState([])
  const [selectedClient, setSelectedClient] = useState(null)
  const [broadcastMode, setBroadcastMode] = useState(false)
  const [gmTree, setGmTree] = useState([])
  const [logs, setLogs] = useState([])
  const [luaInput, setLuaInput] = useState('')
  const [loading, setLoading] = useState(true)
  const logsEndRef = useRef(null)
  const wsRef = useRef(null)

  // WS 连接状态: 'connecting' | 'connected' | 'disconnected'
  const [wsStatus, setWsStatus] = useState('connecting')
  const [activeTab, setActiveTab] = useState('lua_gm')

  // 按钮最小宽度 (px)
  const [btnMinWidth, setBtnMinWidth] = useState(() => {
    const saved = localStorage.getItem('gm_btnMinWidth')
    return saved ? parseInt(saved) : 120
  })

  // 按钮高度 (px)
  const [btnHeight, setBtnHeight] = useState(() => {
    const saved = localStorage.getItem('gm_btnHeight')
    return saved ? parseInt(saved) : 64
  })

  useEffect(() => { document.title = 'GM Console - EncyHub' }, [])

  // 持久化滑块值
  useEffect(() => { localStorage.setItem('gm_btnMinWidth', String(btnMinWidth)) }, [btnMinWidth])
  useEffect(() => { localStorage.setItem('gm_btnHeight', String(btnHeight)) }, [btnHeight])

  // 面包屑导航
  const [breadcrumb, setBreadcrumb] = useState([])
  const [currentNodes, setCurrentNodes] = useState([])

  // GM UI 状态 (Toggle/Input values per client)
  const [gmUiStates, setGmUiStates] = useState({})

  // 自定义 GM
  const [customGmList, setCustomGmList] = useState([])
  const [showCustomGmModal, setShowCustomGmModal] = useState(false)
  const [editingCustomGm, setEditingCustomGm] = useState(null)
  const [customGmForm, setCustomGmForm] = useState({ name: '', cmd: '' })

  // 添加监听弹窗
  const [showAddListener, setShowAddListener] = useState(false)
  const [newPort, setNewPort] = useState('12581')

  // 搜索过滤
  const [searchFilter, setSearchFilter] = useState('')

  // HTTP fallback fetch
  const fetchDataHttp = useCallback(async () => {
    try {
      const [listenersRes, clientsRes, logsRes] = await Promise.all([
        fetch('/api/gm_console/listeners'),
        fetch('/api/gm_console/clients'),
        fetch('/api/gm_console/logs?limit=50'),
      ])
      if (listenersRes.ok) {
        const data = await listenersRes.json()
        setListeners(data.listeners || [])
      }
      if (clientsRes.ok) {
        const data = await clientsRes.json()
        setClients(data.clients || [])
      }
      if (logsRes.ok) {
        const data = await logsRes.json()
        const serverLogs = (data.logs || []).map(log => ({
          type: log.level === 'info' ? 'info' : 'error',
          text: `[${log.time}] ${log.msg}`,
        }))
        setLogs(prev => {
          const localLogs = prev.filter(l => l.local)
          return [...serverLogs, ...localLogs]
        })
      }
    } catch (err) {
      console.error('获取数据失败:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchCustomGm = useCallback(async () => {
    try {
      const res = await fetch('/api/gm_console/custom-gm')
      if (res.ok) {
        const data = await res.json()
        setCustomGmList(data.commands || [])
      }
    } catch (err) {
      console.error('获取自定义GM失败:', err)
    }
  }, [])

  // WebSocket 实时事件连接
  useEffect(() => {
    let ws = null
    let fallbackInterval = null

    const connectWs = () => {
      const wsUrl = `ws://${window.location.host}/api/gm_console/ws/events`
      ws = new WebSocket(wsUrl)
      wsRef.current = ws

      let pingTimer = null
      ws.onopen = () => {
        setLoading(false)
        setWsStatus('connected')
        // 清除 fallback 轮询
        if (fallbackInterval) {
          clearInterval(fallbackInterval)
          fallbackInterval = null
        }
        // WS 心跳保活
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('ping')
        }, 25000)
      }

      ws.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data)
          if (event.type === 'init' || event.type === 'update') {
            if (event.listeners) setListeners(event.listeners)
            if (event.clients) setClients(event.clients)
            if (event.logs) {
              const serverLogs = event.logs.map(log => ({
                type: log.level === 'info' ? 'info' : 'error',
                text: `[${log.time}] ${log.msg}`,
              }))
              setLogs(prev => {
                const localLogs = prev.filter(l => l.local)
                return [...serverLogs, ...localLogs]
              })
            }
          } else if (event.type === 'log' && event.log) {
            const log = event.log
            setLogs(prev => [...prev, {
              type: log.level === 'info' ? 'info' : 'error',
              text: `[${log.time}] ${log.msg}`,
            }])
          }
        } catch {}
      }

      ws.onclose = () => {
        if (pingTimer) clearInterval(pingTimer)
        wsRef.current = null
        setWsStatus('disconnected')
        // 降级到 HTTP 轮询
        if (!fallbackInterval) {
          fallbackInterval = setInterval(fetchDataHttp, 3000)
        }
        // 尝试重连
        setTimeout(() => {
          setWsStatus('connecting')
          connectWs()
        }, 3000)
      }

      ws.onerror = () => {
        ws.close()
      }
    }

    // 先用 HTTP 获取初始数据，同时尝试 WS
    fetchDataHttp()
    fetchCustomGm()
    connectWs()

    // 低频 fallback 轮询（WS 连接成功后会被清除）
    fallbackInterval = setInterval(fetchDataHttp, 3000)

    return () => {
      if (ws) ws.close()
      if (fallbackInterval) clearInterval(fallbackInterval)
    }
  }, [fetchDataHttp, fetchCustomGm])

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  // 选择客户端时更新 GM 树
  const handleSelectClient = useCallback((client) => {
    try {
      setBroadcastMode(false)
      setSelectedClient(client)
      const tree = Array.isArray(client.gm_tree) ? client.gm_tree : []
      setGmTree(tree)
      setCurrentNodes(tree)
      setBreadcrumb([])
      setSearchFilter('')
    } catch (err) {
      console.error('选择客户端失败:', err)
      toast.error('选择客户端时出错')
    }
  }, [toast])

  // 选择广播模式
  const handleSelectBroadcast = useCallback(() => {
    setBroadcastMode(true)
    setSelectedClient(null)
    // 广播模式下不显示特定设备的 GM 树，因为不同设备的 GM 可能不同
    setGmTree([])
    setCurrentNodes([])
    setBreadcrumb([])
    setSearchFilter('')
  }, [clients])

  // 面包屑导航 - 进入子目录
  const navigateToNode = useCallback((node, index) => {
    if (node.type === 'SubBox' && Array.isArray(node.children)) {
      const newBreadcrumb = [...breadcrumb.slice(0, index !== undefined ? index + 1 : breadcrumb.length), node]
      setBreadcrumb(index !== undefined ? newBreadcrumb.slice(0, index + 1) : [...breadcrumb, node])
      setCurrentNodes(node.children || [])
      setSearchFilter('')
    }
  }, [breadcrumb])

  // 面包屑 - 回到根
  const navigateToRoot = useCallback(() => {
    setBreadcrumb([])
    setCurrentNodes(gmTree)
    setSearchFilter('')
  }, [gmTree])

  // 面包屑 - 回到某一级
  const navigateToBreadcrumb = useCallback((index) => {
    if (index < 0) {
      navigateToRoot()
      return
    }
    const node = breadcrumb[index]
    setBreadcrumb(breadcrumb.slice(0, index + 1))
    setCurrentNodes(node.children || [])
    setSearchFilter('')
  }, [breadcrumb, navigateToRoot])

  // 添加监听端口
  const handleAddListener = async () => {
    const port = parseInt(newPort)
    if (isNaN(port) || port < 1 || port > 65535) {
      toast.warning('请输入有效端口号 (1-65535)')
      return
    }
    try {
      const res = await fetch('/api/gm_console/listeners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      })
      if (res.ok) {
        setShowAddListener(false)
        setNewPort('12581')
        fetchDataHttp()
        toast.success(`端口 ${port} 监听已添加`)
      } else {
        const data = await res.json()
        toast.error(data.detail || '添加失败')
      }
    } catch (err) {
      toast.error('添加失败: ' + err.message)
    }
  }

  // 移除监听端口
  const handleRemoveListener = async (port) => {
    try {
      const res = await fetch(`/api/gm_console/listeners/${port}`, { method: 'DELETE' })
      if (res.ok) {
        fetchDataHttp()
        toast.success(`端口 ${port} 已移除`)
      } else {
        const data = await res.json()
        toast.error(data.detail || '移除失败')
      }
    } catch (err) {
      toast.error('移除失败: ' + err.message)
    }
  }

  // 执行 Lua 命令
  const handleExec = async () => {
    if (!luaInput.trim()) return
    if (!selectedClient && !broadcastMode) {
      toast.warning('请先选择一个客户端或广播模式')
      return
    }
    const cmd = luaInput
    try {
      const url = broadcastMode
        ? '/api/gm_console/broadcast'
        : `/api/gm_console/clients/${encodeURIComponent(selectedClient.id)}/exec`
      const logType = broadcastMode ? 'broadcast' : 'cmd'
      const logText = broadcastMode ? `[广播] ${cmd}` : `> ${cmd}`
      setLogs(prev => [...prev, { type: logType, text: logText, local: true }])
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd }),
      })
      if (!res.ok) {
        const data = await res.json()
        setLogs(prev => [...prev, { type: 'error', text: `错误: ${extractDetail(data.detail)}`, local: true }])
      }
    } catch (err) {
      setLogs(prev => [...prev, { type: 'error', text: `错误: ${err.message}`, local: true }])
    }
  }

  // 广播命令
  const handleBroadcast = async () => {
    if (!luaInput.trim()) return
    const cmd = luaInput
    setLogs(prev => [...prev, { type: 'broadcast', text: `[广播] ${cmd}`, local: true }])
    try {
      const res = await fetch('/api/gm_console/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd }),
      })
      if (!res.ok) {
        const data = await res.json()
        setLogs(prev => [...prev, { type: 'error', text: `错误: ${extractDetail(data.detail)}`, local: true }])
      }
    } catch (err) {
      setLogs(prev => [...prev, { type: 'error', text: `错误: ${err.message}`, local: true }])
    }
  }

  // 提取错误详情文本
  const extractDetail = (detail) => {
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) {
      return detail.map(d => d.msg || JSON.stringify(d)).join('; ')
    }
    return JSON.stringify(detail)
  }

  // 执行 GM 命令 (fire-and-forget 减少延迟)
  const handleExecGm = (gmId, value = null) => {
    if (!selectedClient && !broadcastMode) {
      toast.warning('请先选择一个客户端或广播模式')
      return
    }
    // 立即写入日志
    const label = broadcastMode ? '广播GM' : 'GM'
    setLogs(prev => [...prev, { type: 'gm', text: `[${label}] ${gmId}${value !== null ? ' = ' + value : ''}`, local: true }])

    const url = broadcastMode
      ? '/api/gm_console/broadcast-gm'
      : `/api/gm_console/clients/${encodeURIComponent(selectedClient.id)}/exec-gm`

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gm_id: gmId, value }),
    }).then(res => {
      if (!res.ok) {
        res.json().then(data => {
          setLogs(prev => [...prev, { type: 'error', text: `错误: ${extractDetail(data.detail)}`, local: true }])
        }).catch(() => {})
      }
    }).catch(err => {
      setLogs(prev => [...prev, { type: 'error', text: `错误: ${err.message}`, local: true }])
    })
  }

  // Toggle GM 状态切换
  const handleToggleGm = (node) => {
    const key = (selectedClient?.id || 'broadcast') + ':' + (node.id || node.name)
    const currentVal = gmUiStates[key] ?? false
    const newVal = !currentVal
    setGmUiStates(prev => ({ ...prev, [key]: newVal }))
    handleExecGm(node.id || node.name, newVal)
  }

  // Input GM 值提交
  const handleInputGm = (node, value) => {
    handleExecGm(node.id || node.name, value)
  }

  // 执行自定义 GM 命令（直接发送 Lua）
  const handleExecCustomGm = (cmd) => {
    if (!selectedClient && !broadcastMode) {
      toast.warning('请先选择一个客户端或广播模式')
      return
    }
    const label = broadcastMode ? '广播自定义GM' : '自定义GM'
    setLogs(prev => [...prev, { type: 'gm', text: `[${label}] ${cmd.substring(0, 60)}...`, local: true }])

    const url = broadcastMode
      ? '/api/gm_console/broadcast'
      : `/api/gm_console/clients/${encodeURIComponent(selectedClient.id)}/exec`

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd }),
    }).then(res => {
      if (!res.ok) {
        res.json().then(data => {
          setLogs(prev => [...prev, { type: 'error', text: `错误: ${extractDetail(data.detail)}`, local: true }])
        }).catch(() => {})
      }
    }).catch(err => {
      setLogs(prev => [...prev, { type: 'error', text: `错误: ${err.message}`, local: true }])
    })
  }

  // 自定义 GM CRUD
  const handleSaveCustomGm = async () => {
    if (!customGmForm.name.trim() || !customGmForm.cmd.trim()) {
      toast.warning('请填写名称和命令')
      return
    }
    try {
      const url = editingCustomGm !== null
        ? `/api/gm_console/custom-gm/${editingCustomGm}`
        : '/api/gm_console/custom-gm'
      const method = editingCustomGm !== null ? 'PUT' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(customGmForm),
      })
      if (res.ok) {
        setShowCustomGmModal(false)
        setEditingCustomGm(null)
        setCustomGmForm({ name: '', cmd: '' })
        fetchCustomGm()
        toast.success(editingCustomGm !== null ? '已更新' : '已添加')
      } else {
        const data = await res.json()
        toast.error(data.detail || '保存失败')
      }
    } catch (err) {
      toast.error('保存失败: ' + err.message)
    }
  }

  const handleDeleteCustomGm = async (index) => {
    try {
      const res = await fetch(`/api/gm_console/custom-gm/${index}`, { method: 'DELETE' })
      if (res.ok) {
        fetchCustomGm()
        toast.success('已删除')
      } else {
        const data = await res.json()
        toast.error(data.detail || '删除失败')
      }
    } catch (err) {
      toast.error('删除失败: ' + err.message)
    }
  }

  // 获取日志颜色
  const getLogColor = (type) => {
    switch (type) {
      case 'cmd': return 'text-[var(--caramel)]'
      case 'broadcast': return 'text-[var(--amber)]'
      case 'gm': return 'text-[var(--sage)]'
      case 'error': return 'text-[var(--terracotta)]'
      default: return 'text-[var(--coffee-light)]'
    }
  }

  // 过滤当前节点
  const filteredNodes = searchFilter
    ? currentNodes.filter(n => n.name?.toLowerCase().includes(searchFilter.toLowerCase()))
    : currentNodes

  // 网格样式：自动填充，按钮最小宽度控制
  const gridStyle = {
    display: 'grid',
    gridTemplateColumns: `repeat(auto-fill, minmax(${btnMinWidth}px, 1fr))`,
    gap: '8px',
  }

  return (
    <div className="min-h-screen">
      {/* Top Bar */}
      <header className="sticky top-0 z-50 bg-[var(--glass-bg)] backdrop-blur-xl border-b border-[var(--glass-border)] px-6 py-3">
        <div className="max-w-[1600px] mx-auto flex items-center gap-4">
          <button className="btn-secondary p-2.5" onClick={() => navigate('/')}>
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <h1 className="font-display text-2xl font-semibold text-[var(--coffee-deep)]">GM Console</h1>
            <div className="flex items-center gap-2">
              <p className="text-[var(--coffee-muted)] text-sm">游戏 GM 控制台</p>
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
                wsStatus === 'connected' ? 'bg-[var(--sage-soft)]/30 text-[var(--sage)]' :
                wsStatus === 'connecting' ? 'bg-[var(--amber-soft)]/30 text-[var(--amber)]' :
                'bg-[var(--error-soft)]/30 text-[var(--terracotta)]'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  wsStatus === 'connected' ? 'bg-[var(--sage)] animate-pulse' :
                  wsStatus === 'connecting' ? 'bg-[var(--amber)] animate-pulse' :
                  'bg-[var(--terracotta)]'
                }`} />
                {wsStatus === 'connected' ? '已连接' : wsStatus === 'connecting' ? '连接中' : '已断开'}
              </span>
            </div>
          </div>
          <button
            className="btn-primary flex items-center gap-2"
            onClick={() => setShowAddListener(true)}
          >
            <Plus size={16} />
            添加监听
          </button>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="spinner" />
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5" style={{ minHeight: 'calc(100vh - 120px)' }}>
            {/* Left Panel - Listeners & Clients */}
            <div className="lg:col-span-3 space-y-4">
              {/* Listeners */}
              <div className="glass-card p-5 animate-fade-in">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[var(--sage)] to-[var(--sage-soft)] flex items-center justify-center">
                    <Radio size={14} className="text-white" />
                  </div>
                  <h2 className="font-display text-base font-semibold text-[var(--coffee-deep)]">监听端口</h2>
                </div>
                {listeners.length === 0 ? (
                  <div className="text-[var(--coffee-muted)] text-xs py-3 text-center">无监听端口</div>
                ) : (
                  <div className="space-y-1.5">
                    {listeners.map(listener => (
                      <div
                        key={listener.port}
                        className="flex items-center justify-between p-2 bg-[var(--cream-warm)]/50 rounded-lg group"
                      >
                        <div className="flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--sage)] animate-pulse" />
                          <span className="font-mono text-xs text-[var(--coffee-deep)]">:{listener.port}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] text-[var(--coffee-muted)] bg-[var(--cream-warm)] px-1.5 py-0.5 rounded-full">
                            {listener.client_count || 0}
                          </span>
                          <button
                            className="p-1 rounded text-[var(--coffee-muted)] hover:text-[var(--terracotta)] hover:bg-[var(--error-soft)] opacity-0 group-hover:opacity-100 transition-all"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleRemoveListener(listener.port)
                            }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Clients */}
              <div className="glass-card p-5 animate-fade-in" style={{ animationDelay: '0.1s' }}>
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[var(--sky)] to-[var(--sky-soft)] flex items-center justify-center">
                    <Users size={14} className="text-white" />
                  </div>
                  <h2 className="font-display text-base font-semibold text-[var(--coffee-deep)]">客户端</h2>
                </div>
                {/* 广播模式选项 */}
                <div
                  className={`flex items-center gap-2 p-2.5 rounded-lg cursor-pointer transition-all mb-2 ${
                    broadcastMode
                      ? 'bg-gradient-to-r from-[var(--amber-soft)]/20 to-transparent border-l-3 border-[var(--amber)]'
                      : 'bg-[var(--cream-warm)]/50 hover:bg-[var(--cream-warm)]'
                  }`}
                  onClick={handleSelectBroadcast}
                >
                  <Globe size={14} className="text-[var(--amber)] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm text-[var(--coffee-deep)]">全部广播</div>
                    <div className="text-[10px] text-[var(--coffee-muted)]">{clients.length} 个客户端</div>
                  </div>
                </div>
                {clients.length === 0 ? (
                  <div className="text-[var(--coffee-muted)] text-xs py-3 text-center">无连接</div>
                ) : (
                  <div className="space-y-2">
                    {clients.map(client => (
                      <div
                        key={client.id}
                        className={`flex items-center gap-2 p-2.5 rounded-lg cursor-pointer transition-all ${
                          selectedClient?.id === client.id && !broadcastMode
                            ? 'bg-gradient-to-r from-[var(--caramel-light)]/20 to-transparent border-l-3 border-[var(--caramel)]'
                            : 'bg-[var(--cream-warm)]/50 hover:bg-[var(--cream-warm)]'
                        }`}
                        onClick={() => handleSelectClient(client)}
                      >
                        <Smartphone size={14} className="text-[var(--caramel)] shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-xs text-[var(--coffee-deep)] truncate">
                            {client.device || 'Unknown'}
                          </div>
                          <div className="text-[10px] text-[var(--coffee-muted)] truncate">
                            {client.platform}
                            {client.ip ? ` · ${client.ip}` : ''}
                            {client.port ? `:${client.port}` : ''}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Center Panel - GM Commands (Tabs + Grid) */}
            <div className="lg:col-span-5">
              <div className="glass-card p-5 h-full animate-fade-in" style={{ animationDelay: '0.15s' }}>
                {/* Tab Bar */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1 bg-[var(--cream-warm)] rounded-lg p-1">
                    <button
                      className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all whitespace-nowrap ${
                        activeTab === 'lua_gm'
                          ? 'bg-white text-[var(--coffee-deep)] shadow-sm'
                          : 'text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]'
                      }`}
                      onClick={() => setActiveTab('lua_gm')}
                    >
                      <span className="flex items-center gap-1.5">
                        <Code size={14} />
                        LuaGM
                      </span>
                    </button>
                    <button
                      className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all whitespace-nowrap ${
                        activeTab === 'custom_gm'
                          ? 'bg-white text-[var(--coffee-deep)] shadow-sm'
                          : 'text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]'
                      }`}
                      onClick={() => setActiveTab('custom_gm')}
                    >
                      <span className="flex items-center gap-1.5">
                        <Layers size={14} />
                        自定义
                      </span>
                    </button>
                    <button
                      className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all whitespace-nowrap ${
                        activeTab === 'animator'
                          ? 'bg-white text-[var(--coffee-deep)] shadow-sm'
                          : 'text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]'
                      }`}
                      onClick={() => setActiveTab('animator')}
                    >
                      <span className="flex items-center gap-1.5">
                        <Activity size={14} />
                        Animator
                      </span>
                    </button>
                    <button
                      className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all whitespace-nowrap ${
                        activeTab === 'lua_inspector'
                          ? 'bg-white text-[var(--coffee-deep)] shadow-sm'
                          : 'text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]'
                      }`}
                      onClick={() => setActiveTab('lua_inspector')}
                    >
                      <span className="flex items-center gap-1.5">
                        <ZoomIn size={14} />
                        Lua UI
                      </span>
                    </button>
                  </div>
                  {activeTab === 'lua_gm' && (
                    <button
                      className="p-1.5 rounded-lg hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] transition-colors"
                      onClick={async () => {
                        const cmd = 'RuntimeGMClient.ReloadGM(true)'
                        if (broadcastMode) {
                          await fetch('/api/gm_console/broadcast', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ cmd }),
                          })
                        } else if (selectedClient) {
                          await fetch(`/api/gm_console/clients/${encodeURIComponent(selectedClient.id)}/exec`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ cmd }),
                          })
                        } else {
                          toast.warning('请先选择客户端或广播模式')
                          return
                        }
                        toast.success('已发送刷新GM信号')
                      }}
                      title="刷新 LuaGM 树"
                    >
                      <RefreshCw size={16} />
                    </button>
                  )}
                </div>

                {/* Slider Controls Row */}
                <div className="flex items-center gap-2 mb-3 px-1">
                  <ZoomOut size={14} className="text-[var(--coffee-muted)] shrink-0 cursor-pointer hover:text-[var(--coffee-deep)]" onClick={() => setBtnMinWidth(w => Math.max(60, w - 4))} />
                  <input type="range" min="60" max="300" step="4" value={btnMinWidth} onChange={e => setBtnMinWidth(parseInt(e.target.value))} className="w-20 h-1 accent-[var(--caramel)]" title="按钮最小宽度" />
                  <ZoomIn size={14} className="text-[var(--coffee-muted)] shrink-0 cursor-pointer hover:text-[var(--coffee-deep)]" onClick={() => setBtnMinWidth(w => Math.min(300, w + 4))} />
                  <span className="text-[10px] text-[var(--coffee-muted)] w-5 text-center">{btnMinWidth}</span>
                  <span className="w-px h-3 bg-[var(--glass-border)]" />
                  <span className="text-[10px] text-[var(--coffee-muted)]">H</span>
                  <input type="range" min="32" max="128" step="4" value={btnHeight} onChange={e => setBtnHeight(parseInt(e.target.value))} className="w-20 h-1 accent-[var(--caramel)]" title="按钮高度" />
                  <span className="text-[10px] text-[var(--coffee-muted)] w-5 text-center">{btnHeight}</span>
                </div>

                {/* LuaGM Tab Content */}
                {activeTab === 'lua_gm' && (
                  <div>
                    {/* Breadcrumb */}
                    <div className="flex items-center gap-1 mb-3 flex-wrap">
                      <button
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-[var(--cream-warm)] hover:bg-[var(--caramel-light)] hover:text-white transition-all text-[var(--coffee-deep)]"
                        onClick={navigateToRoot}
                      >
                        <Home size={12} />
                      </button>
                      {breadcrumb.map((node, i) => (
                        <div key={i} className="flex items-center gap-1">
                          <ChevronRight size={12} className="text-[var(--coffee-muted)]" />
                          <button
                            className="px-2 py-1 rounded-md text-xs font-medium bg-[var(--cream-warm)] hover:bg-[var(--caramel-light)] hover:text-white transition-all text-[var(--coffee-deep)]"
                            onClick={() => navigateToBreadcrumb(i)}
                          >
                            {node.name}
                          </button>
                        </div>
                      ))}
                      <div className="flex-1" />
                      <input
                        type="text"
                        value={searchFilter}
                        onChange={e => setSearchFilter(e.target.value)}
                        placeholder="搜索..."
                        className="text-xs px-2 py-1 w-32 rounded-md bg-[var(--cream-warm)] border-none"
                      />
                    </div>

                    {/* GM Grid */}
                    {!selectedClient && !broadcastMode ? (
                      <div className="text-[var(--coffee-muted)] text-sm py-12 text-center">
                        请选择客户端或广播模式查看 GM 命令
                      </div>
                    ) : filteredNodes.length === 0 ? (
                      <div className="text-[var(--coffee-muted)] text-sm py-12 text-center">
                        {searchFilter ? '无匹配结果' : '无 GM 命令'}
                      </div>
                    ) : (
                      <div className="max-h-[calc(100vh-300px)] overflow-auto pr-1" style={gridStyle}>
                        {filteredNodes.map((node, i) => {
                          const nodeType = (node.type || 'Btn').toLowerCase()
                          const stateKey = (selectedClient?.id || 'broadcast') + ':' + (node.id || node.name)

                          if (node.type === 'SubBox') {
                            return (
                              <button
                                key={i}
                                className="gm-btn-core folder group/btn flex items-center gap-2"
                                style={{ height: btnHeight }}
                                onClick={() => navigateToNode(node)}
                              >
                                <ChevronRight size={14} className="shrink-0 transition-transform duration-200 group-hover/btn:translate-x-0.5" />
                                <span className="line-clamp-2">{node.name}</span>
                              </button>
                            )
                          }

                          if (nodeType === 'toggle') {
                            const isOn = gmUiStates[stateKey] ?? false
                            return (
                              <div
                                key={i}
                                className="gm-btn-core flex flex-col justify-between gap-2"
                                style={{ height: btnHeight }}
                                title={node.name}
                              >
                                <span className="line-clamp-2 text-xs font-medium">{node.name}</span>
                                <button
                                  className={`relative w-10 h-5 rounded-full transition-all duration-300 shrink-0 ${
                                    isOn ? 'bg-[var(--sage)] shadow-sm shadow-[var(--sage)]/30' : 'bg-[var(--coffee-muted)]/30'
                                  }`}
                                  onClick={() => handleToggleGm(node)}
                                >
                                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-300 ${
                                    isOn ? 'translate-x-5' : 'translate-x-0.5'
                                  }`} />
                                </button>
                              </div>
                            )
                          }

                          if (nodeType === 'input') {
                            return (
                              <div
                                key={i}
                                className="gm-btn-core flex flex-col justify-between gap-1.5"
                                style={{ height: btnHeight }}
                                title={node.name}
                              >
                                <span className="truncate text-xs font-medium">{node.name}</span>
                                <div className="flex gap-1">
                                  <input
                                    type="text"
                                    className="flex-1 text-xs px-2 py-1 rounded-lg bg-white/80 border border-[var(--glass-border)]/80 min-w-0 focus:border-[var(--caramel)]/60 focus:ring-1 focus:ring-[var(--caramel)]/20 transition-all"
                                    placeholder="输入值..."
                                    defaultValue={gmUiStates[stateKey] || ''}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        const val = e.target.value
                                        setGmUiStates(prev => ({ ...prev, [stateKey]: val }))
                                        handleInputGm(node, val)
                                      }
                                    }}
                                    onBlur={(e) => {
                                      const val = e.target.value
                                      if (val !== (gmUiStates[stateKey] || '')) {
                                        setGmUiStates(prev => ({ ...prev, [stateKey]: val }))
                                        handleInputGm(node, val)
                                      }
                                    }}
                                  />
                                  <button
                                    className="px-2 py-1 rounded-lg bg-gradient-to-r from-[var(--caramel)] to-[var(--caramel-dark)] text-white text-xs shrink-0 hover:shadow-md hover:shadow-[var(--caramel)]/20 active:scale-95 transition-all duration-200"
                                    onClick={(e) => {
                                      const input = e.target.closest('div').querySelector('input')
                                      if (input) {
                                        const val = input.value
                                        setGmUiStates(prev => ({ ...prev, [stateKey]: val }))
                                        handleInputGm(node, val)
                                      }
                                    }}
                                  >
                                    ✓
                                  </button>
                                </div>
                              </div>
                            )
                          }

                          // Default: Btn type
                          return (
                            <button
                              key={i}
                              className="gm-btn-core"
                              style={{ height: btnHeight }}
                              onClick={() => handleExecGm(node.id || node.name)}
                              title={node.name}
                            >
                              <span className="line-clamp-2">{node.name}</span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* CustomGM Tab Content */}
                {activeTab === 'custom_gm' && (
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs text-[var(--coffee-muted)]">{customGmList.length} 个命令</span>
                      <button
                        className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1"
                        onClick={() => {
                          setEditingCustomGm(null)
                          setCustomGmForm({ name: '', cmd: '' })
                          setShowCustomGmModal(true)
                        }}
                      >
                        <Plus size={14} />
                        新增
                      </button>
                    </div>

                    {customGmList.length === 0 ? (
                      <div className="text-[var(--coffee-muted)] text-sm py-12 text-center">
                        暂无自定义命令
                      </div>
                    ) : (
                      <div className="max-h-[calc(100vh-300px)] overflow-auto pr-1" style={gridStyle}>
                        {customGmList.map((item, i) => (
                          <div
                            key={i}
                            className="gm-btn-core group"
                            style={{ height: btnHeight }}
                            onClick={() => handleExecCustomGm(item.cmd)}
                            title={`${item.name}\n${item.cmd}`}
                          >
                            <div className="w-full text-left pr-7">
                              <span className="line-clamp-2">{item.name}</span>
                            </div>
                            <div
                              className="absolute right-0.5 top-0 bottom-0 flex flex-col justify-center gap-0"
                              style={{ display: 'flex', flexDirection: 'column' }}
                            >
                              <button
                                className="p-1 rounded-md text-[var(--coffee-muted)]/50 hover:text-[var(--coffee-deep)] hover:bg-[var(--cream-warm)] transition-all"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setEditingCustomGm(i)
                                  setCustomGmForm({ name: item.name, cmd: item.cmd })
                                  setShowCustomGmModal(true)
                                }}
                              >
                                <Edit size={11} />
                              </button>
                              <button
                                className="p-1 rounded-md text-[var(--coffee-muted)]/50 hover:text-[var(--terracotta)] hover:bg-[var(--error-soft)] transition-all"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleDeleteCustomGm(i)
                                }}
                              >
                                <Trash2 size={11} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'animator' && (
                  <AnimatorViewer
                    clients={clients}
                    selectedClient={selectedClient}
                    broadcastMode={broadcastMode}
                  />
                )}

                {activeTab === 'lua_inspector' && (
                  <LuaUiInspector
                    clients={clients}
                    selectedClient={selectedClient}
                    broadcastMode={broadcastMode}
                  />
                )}
              </div>
            </div>

            {/* Right Panel - Lua Input & Logs */}
            <div className="lg:col-span-4 space-y-4">
              {/* Lua Input */}
              <div className="glass-card p-5 animate-fade-in" style={{ animationDelay: '0.2s' }}>
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[var(--amber)] to-[var(--honey)] flex items-center justify-center">
                    <Terminal size={14} className="text-white" />
                  </div>
                  <h2 className="font-display text-base font-semibold text-[var(--coffee-deep)]">Lua 命令</h2>
                </div>
                <textarea
                  className="w-full h-36 bg-[var(--coffee-deep)] text-[var(--sage)] rounded-xl p-3 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-[var(--caramel)] placeholder-[var(--coffee-muted)]"
                  placeholder="输入 Lua 代码... (Ctrl+Enter 执行)"
                  value={luaInput}
                  onChange={e => setLuaInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && e.ctrlKey) handleExec()
                  }}
                />
                <div className="flex gap-2 mt-3">
                  <button className="btn-primary flex-1 flex items-center justify-center gap-2 py-2 text-sm" onClick={handleExec}>
                    <Send size={14} />
                    执行
                  </button>
                  <button className="btn-secondary flex-1 flex items-center justify-center gap-2 py-2 text-sm" onClick={handleBroadcast}>
                    <Megaphone size={14} />
                    广播
                  </button>
                </div>
              </div>

              {/* Logs */}
              <div className="glass-card p-5 flex-1 animate-fade-in" style={{ animationDelay: '0.25s' }}>
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-7 h-7 rounded-lg bg-[var(--cream-warm)] flex items-center justify-center">
                    <MessageSquare size={14} className="text-[var(--coffee-light)]" />
                  </div>
                  <h2 className="font-display text-base font-semibold text-[var(--coffee-deep)]">日志</h2>
                  {logs.length > 0 && (
                    <button
                      className="ml-auto text-xs text-[var(--coffee-muted)] hover:text-[var(--terracotta)] transition-colors"
                      onClick={() => setLogs([])}
                    >
                      清空
                    </button>
                  )}
                </div>
                <div className="min-h-[256px] h-64 bg-[var(--coffee-deep)] rounded-xl p-3 overflow-auto font-mono text-xs leading-relaxed">
                  {logs.length === 0 ? (
                    <div className="text-[var(--coffee-muted)] text-center py-8">暂无日志</div>
                  ) : (
                    logs.map((log, i) => (
                      <div
                        key={i}
                        className={`py-0.5 ${getLogColor(log.type)} hover:bg-white/5 px-1 -mx-1 rounded`}
                      >
                        {log.text}
                      </div>
                    ))
                  )}
                  <div ref={logsEndRef} />
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Add Listener Modal */}
      {showAddListener && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowAddListener(false) }}>
          <div
            className="glass-card p-6 w-96"
            style={{ animation: 'slideUp 0.3s ease' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-[var(--sage)] to-[var(--sage-soft)] flex items-center justify-center">
                  <Radio size={20} className="text-white" />
                </div>
                <h3 className="font-display text-lg font-semibold">添加监听端口</h3>
              </div>
              <button
                onClick={() => setShowAddListener(false)}
                className="p-2 rounded-lg hover:bg-[var(--cream-warm)] transition-colors text-[var(--coffee-muted)]"
              >
                <X size={20} />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-[var(--coffee-light)] mb-2">端口号</label>
                <input
                  type="number"
                  value={newPort}
                  onChange={e => setNewPort(e.target.value)}
                  placeholder="12581"
                  min="1"
                  max="65535"
                  className="font-mono"
                  onKeyDown={e => { if (e.key === 'Enter') handleAddListener() }}
                />
              </div>
              <div className="flex gap-3 pt-2">
                <button className="btn-secondary flex-1" onClick={() => setShowAddListener(false)}>取消</button>
                <button className="btn-primary flex-1" onClick={handleAddListener}>添加</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Custom GM Modal */}
      {showCustomGmModal && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowCustomGmModal(false) }}>
          <div
            className="glass-card p-6 w-[500px]"
            style={{ animation: 'slideUp 0.3s ease' }}
          >
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-[var(--caramel)] to-[var(--caramel-dark)] flex items-center justify-center">
                  <Layers size={20} className="text-white" />
                </div>
                <h3 className="font-display text-lg font-semibold">
                  {editingCustomGm !== null ? '编辑命令' : '新增命令'}
                </h3>
              </div>
              <button
                onClick={() => setShowCustomGmModal(false)}
                className="p-2 rounded-lg hover:bg-[var(--cream-warm)] transition-colors text-[var(--coffee-muted)]"
              >
                <X size={20} />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-[var(--coffee-light)] mb-2">名称</label>
                <input
                  type="text"
                  value={customGmForm.name}
                  onChange={e => setCustomGmForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="命令名称"
                />
              </div>
              <div>
                <label className="block text-sm text-[var(--coffee-light)] mb-2">Lua 命令</label>
                <textarea
                  className="w-full h-40 bg-[var(--coffee-deep)] text-[var(--sage)] rounded-xl p-3 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-[var(--caramel)] placeholder-[var(--coffee-muted)]"
                  value={customGmForm.cmd}
                  onChange={e => setCustomGmForm(prev => ({ ...prev, cmd: e.target.value }))}
                  placeholder="输入 Lua 代码..."
                />
              </div>
              <div className="flex gap-3 pt-2">
                <button className="btn-secondary flex-1" onClick={() => setShowCustomGmModal(false)}>取消</button>
                <button className="btn-primary flex-1" onClick={handleSaveCustomGm}>保存</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default GmConsole