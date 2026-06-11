import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Plus, Send, Radio, Smartphone, ChevronRight, ChevronDown,
  X, Trash2, Terminal, Users, Code, Megaphone, MessageSquare,
  Home, ZoomIn, ZoomOut, Edit, Layers, Play, Globe, RefreshCw,
  PanelLeftClose, PanelLeftOpen, Package, Database, Zap, Settings,
  Film, Video, Clock, Table2, Camera
} from 'lucide-react'
import { useToast } from '../components/Toast'

// ============================================================================
// 平台 SVG 图标（24x24 viewBox，stroke-width=2，匹配 Lucide/Tabler 视觉权重）
// 参考：Tabler Icons (MIT) / Lucide (ISC) — brand-android, brand-windows, apple, device-imac
// ============================================================================
const _platformIcons = {
  windows: ({ size, className }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className}
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.8 20l-12-1.5c-1-.1-1.8-.9-1.8-1.9v-9.2c0-1 .8-1.8 1.8-1.9l12-1.5c1.2-.1 2.2.8 2.2 1.9v12.1c0 1.2-1.1 2.1-2.2 1.9" />
      <path d="M12 5v14" />
      <path d="M4 12h16" />
    </svg>
  ),
  android: ({ size, className }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className}
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 10v6" />
      <path d="M20 10v6" />
      <path d="M7 9h10v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9a5 5 0 0 1 10 0" />
      <path d="M8 3l1 2" />
      <path d="M16 3l-1 2" />
      <path d="M9 18v3" />
      <path d="M15 18v3" />
    </svg>
  ),
  apple: ({ size, className }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className}
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 6.528V3a1 1 0 0 1 1-1" />
      <path d="M18.237 21A15 15 0 0 0 22 11a6 6 0 0 0-10-4.472A6 6 0 0 0 2 11a15.1 15.1 0 0 0 3.763 10 3 3 0 0 0 3.648.648 5.5 5.5 0 0 1 5.178 0A3 3 0 0 0 18.237 21" />
    </svg>
  ),
  mac: ({ size, className }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className}
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4z" />
      <path d="M3 13h18" />
      <path d="M8 21h8" />
      <path d="M10 17l-.5 4" />
      <path d="M14 17l.5 4" />
    </svg>
  ),
  unity: ({ size, className }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className}
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l8 5v10l-8 5-8-5V7z" />
      <path d="M4 7l8 5 8-5" />
      <path d="M12 12v10" />
    </svg>
  ),
}

function getPlatformKey(platform) {
  if (!platform) return null
  const p = platform.toLowerCase()
  // Editor は Unity キューブアイコンで Player と区別
  if (p.includes('windowseditor')) return 'unity'
  if (p.includes('windows')) return 'windows'
  if (p.includes('android')) return 'android'
  if (p.includes('iphone')) return 'apple'
  if (p.includes('osxeditor')) return 'unity'
  if (p.includes('osx')) return 'mac'
  return null
}

function PlatformIcon({ platform, size, className }) {
  const key = getPlatformKey(platform)
  if (!key || !_platformIcons[key]) {
    return <Smartphone size={size} className={className} />
  }
  const IconFn = _platformIcons[key]
  return <IconFn size={size} className={className} />
}
import AnimatorViewer from './AnimatorViewer'
import LuaUiInspector from './LuaUiInspector'
import TimelineMonitor from './TimelineMonitor'
import Hierarchy from './Hierarchy'
import HierarchyIcon from '../components/HierarchyIcon'
import SubPackageMonitor from './SubPackageMonitor'
import PlayerPrefsViewer from './PlayerPrefsViewer'
import AvMonitor from './AvMonitor'
import ProtoRequester from './ProtoRequester'
import TableViewer from './TableViewer'

// Tab 配置
const TAB_META = {
  lua_gm:        { label: 'LuaGM',    icon: Code,     gridSlider: true },
  custom_gm:     { label: '自定义',    icon: Layers,   gridSlider: true },
  lua_inspector: { label: 'Lua UI',    icon: ZoomIn },
  timeline:      { label: 'Timeline',  icon: Clock },
  hierarchy:     { label: 'Hierarchy', icon: HierarchyIcon },
  animator:      { label: 'Animator',  icon: Film },
  subpkg_monitor:{ label: '分包监控',  icon: Package },
  player_prefs:  { label: 'PlayerPrefs', icon: Database },
  av_monitor:    { label: 'AV Monitor', icon: Video },
  proto:         { label: 'Proto',    icon: Zap },
  table_monitor: { label: 'Table',    icon: Table2 },
}
const DEFAULT_TAB_ORDER = ['lua_gm', 'custom_gm', 'lua_inspector', 'timeline', 'hierarchy', 'animator', 'subpkg_monitor', 'player_prefs', 'av_monitor', 'proto', 'table_monitor']
const TAB_ORDER_KEY = 'gm_console_tab_order'

function loadTabOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(TAB_ORDER_KEY))
    if (!Array.isArray(saved)) return DEFAULT_TAB_ORDER
    // merge：保留已知顺序，新 tab 追加，已删除的过滤
    const known = new Set(Object.keys(TAB_META))
    const seen = new Set()
    const order = saved
      .map(id => id === 'cs_monitor' ? 'hierarchy' : id)
      .filter(id => known.has(id) && !seen.has(id) && seen.add(id))
    for (const id of DEFAULT_TAB_ORDER) {
      if (!order.includes(id)) order.push(id)
    }
    return order
  } catch { return DEFAULT_TAB_ORDER }
}

function GmConsole() {
  const navigate = useNavigate()
  const toast = useToast()
  const [listeners, setListeners] = useState([])
  const [clients, setClients] = useState([])
  const [selectedClient, setSelectedClient] = useState(null)
  const [screenshot, setScreenshot] = useState(null) // { client_id, image, width, height }
  // 被系统自动选中的客户端 id；用于在格子上渲染发光边框，提示"这是系统帮你选的"
  const [autoSelectedClientId, setAutoSelectedClientId] = useState(null)
  const [broadcastMode, setBroadcastMode] = useState(false)
  // gmTree / currentNodes 派生自 selectedClient.gm_tree + breadcrumbPath，无需独立 state
  const [logs, setLogs] = useState([])
  const [luaInput, setLuaInput] = useState('')
  const [loading, setLoading] = useState(true)
  const logsContainerRef = useRef(null)
  const wsRef = useRef(null)

  // WS 连接状态: 'connecting' | 'connected' | 'disconnected'
  const [wsStatus, setWsStatus] = useState('connecting')
  const [activeTab, setActiveTab] = useState('lua_gm')
  const [luaUiContext, setLuaUiContext] = useState(null) // null=普通模式, "UIName"=LuaUI上下文模式
  const [pendingLocate, setPendingLocate] = useState(null) // 从 LuaUiInspector 联动到 Hierarchy 的 Locate 载荷
  // 自定义 GM 按钮拖拽排序
  const dragGmRef = useRef(null) // 当前正在拖动的按钮 index（用 ref 避免触发重渲染）
  const [dropGmTarget, setDropGmTarget] = useState(null) // { idx, side: 'left'|'right' }
  const [haruRootInfo, setHaruRootInfo] = useState({ haruroot: '', valid: false, protocolCount: 0 })
  const [tabOrder, setTabOrder] = useState(loadTabOrder)
  const dragTabRef = useRef(null)
  const tabBarRef = useRef(null)
  const [dropTarget, setDropTarget] = useState(null) // { id, side: 'left'|'right' }

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

  // 侧栏折叠状态
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return localStorage.getItem('gm_sidebarCollapsed') === 'true'
  })

  useEffect(() => { document.title = 'GM Console - EncyHub' }, [])

  // 加载/刷新 HaruRoot 配置
  const refreshHaruRootInfo = useCallback(() => {
    fetch('/api/gm_console/proto/config')
      .then(r => r.json())
      .then(data => setHaruRootInfo(data))
      .catch(() => {})
  }, [])

  useEffect(() => { refreshHaruRootInfo() }, [refreshHaruRootInfo])

  // 稳定引用的子组件回调：和 React.memo 配合，避免在自定义 GM 弹窗里敲键盘时
  // LuaUiInspector / Hierarchy 因每次新建箭头函数 prop 而被迫重渲染。
  const handleBindLuaUiConsole = useCallback((uiName) => setLuaUiContext(uiName), [])
  const handlePinLuaUiToMonitor = useCallback((locateData) => {
    setPendingLocate(locateData)
    setActiveTab('hierarchy')
  }, [])
  const handleLocateInHierarchy = useCallback((instanceId) => {
    setPendingLocate({ instanceId })
    setActiveTab('hierarchy')
  }, [])
  const handlePendingLocateConsumed = useCallback(() => setPendingLocate(null), [])

  // tab bar 鼠标滚轮横向滚动（必须用原生非 passive 监听器，React onWheel 无法 preventDefault）
  // 依赖 loading：tab bar DOM 在 loading=false 后才渲染，需等它出现再绑
  useEffect(() => {
    const el = tabBarRef.current
    if (!el) return
    const handler = e => { e.preventDefault(); el.scrollLeft += e.deltaY }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [loading])

  // 持久化滑块值
  useEffect(() => { localStorage.setItem('gm_btnMinWidth', String(btnMinWidth)) }, [btnMinWidth])
  useEffect(() => { localStorage.setItem('gm_btnHeight', String(btnHeight)) }, [btnHeight])
  useEffect(() => { localStorage.setItem('gm_sidebarCollapsed', String(sidebarCollapsed)) }, [sidebarCollapsed])

  // 面包屑导航：仅存路径（节点 name 数组），其余从 selectedClient.gm_tree 派生
  const [breadcrumbPath, setBreadcrumbPath] = useState([])

  // gm_tree 始终跟随 selectedClient（广播模式或未选中时为空）
  const gmTree = useMemo(() => {
    if (broadcastMode || !selectedClient) return []
    return Array.isArray(selectedClient.gm_tree) ? selectedClient.gm_tree : []
  }, [selectedClient, broadcastMode])

  // 握手端口：从后端 listeners 读取（单端口固定），后端未就绪时回退 12581
  const handshakePort = useMemo(() => listeners[0]?.port || 12581, [listeners])

  // 沿 breadcrumbPath 在 gmTree 里走，返回 { nodes(经过的节点), currentNodes, validPath }
  // 如果路径中某段在新 gmTree 中失效（例如刚刷新 GM 后子目录消失），在该处截断
  const breadcrumbResolved = useMemo(() => {
    let nodes = []
    let validPath = []
    let cursor = gmTree
    for (const name of breadcrumbPath) {
      const node = Array.isArray(cursor) ? cursor.find(n => n.name === name) : null
      if (!node || node.type !== 'SubBox' || !Array.isArray(node.children)) break
      nodes.push(node)
      validPath.push(name)
      cursor = node.children
    }
    return { nodes, currentNodes: cursor || [], validPath }
  }, [gmTree, breadcrumbPath])
  const breadcrumb = breadcrumbResolved.nodes
  const currentNodes = breadcrumbResolved.currentNodes

  // 若解析出的 validPath 比当前 path 短（说明部分路径失效），自动回退到有效位置
  useEffect(() => {
    if (breadcrumbResolved.validPath.length !== breadcrumbPath.length) {
      setBreadcrumbPath(breadcrumbResolved.validPath)
    }
  }, [breadcrumbResolved.validPath, breadcrumbPath])

  // GM UI 状态 (Toggle/Input values per client)
  const [gmUiStates, setGmUiStates] = useState({})

  // 自定义 GM
  const [customGmList, setCustomGmList] = useState([])
  // 弹窗规格：null = 关闭；{ editingIndex, initial } = 打开。
  // 表单内部 state 收敛在 <CustomGmModal> 里，避免敲键盘触发顶层 GmConsole 重渲染。
  const [customGmModal, setCustomGmModal] = useState(null)

  // 搜索过滤
  const [searchFilter, setSearchFilter] = useState('')

  // HTTP fallback fetch
  const fetchDataHttp = useCallback(async () => {
    try {
      const [clientsRes, logsRes] = await Promise.all([
        fetch('/api/gm_console/clients'),
        fetch('/api/gm_console/logs?limit=50'),
      ])
      if (clientsRes.ok) {
        const data = await clientsRes.json()
        const newClients = data.clients || []
        setClients(newClients)
        setSelectedClient(prev => {
          if (!prev) return null
          const updated = newClients.find(c => c.id === prev.id)
          return updated || null
        })
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
        if (e.data === 'pong') return
        try {
          const event = JSON.parse(e.data)
          if (event.type === 'init' || event.type === 'update') {
            if (event.listeners) setListeners(event.listeners)
            if (event.clients) {
              setClients(event.clients)
              // 客户端重连后自动同步 selectedClient 数据（ID 不变但 gm_tree 等可能更新）
              setSelectedClient(prev => {
                if (!prev) return null
                const updated = event.clients.find(c => c.id === prev.id)
                return updated || null
              })
            }
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
          } else if (event.type === 'screenshot') {
            setScreenshot({
              client_id: event.client_id,
              image: event.image,
              width: event.width,
              height: event.height,
            })
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
    const el = logsContainerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  // 选择客户端时更新 GM 树
  // auto=true 表示由系统自动选中（首次/掉线重连），会点亮发光边框
  // auto=false 表示用户主动点击；若点的就是当前发光那个，视为"确认"，消光
  const handleSelectClient = useCallback((client, { auto = false } = {}) => {
    try {
      setBroadcastMode(false)
      setSelectedClient(client)
      setBreadcrumbPath([])
      setSearchFilter('')
      if (auto) {
        setAutoSelectedClientId(client.id)
      } else {
        setAutoSelectedClientId(prev => (prev === client.id ? null : prev))
      }
    } catch (err) {
      console.error('选择客户端失败:', err)
      toast.error('选择客户端时出错')
    }
  }, [toast])

  // 选择广播模式
  const handleSelectBroadcast = useCallback(() => {
    setBroadcastMode(true)
    setSelectedClient(null)
    setAutoSelectedClientId(null) // 切走即消光（用户意图为主）
    // 广播模式下 gmTree 派生为空（不显示特定设备的 GM 树）
    setBreadcrumbPath([])
    setSearchFilter('')
  }, [])

  // 没有选中任何客户端且非广播模式时，若列表里有客户端就自动选第1个
  // 痛点：唯一客户端掉线 → 重连后用户不必再手动点一次
  useEffect(() => {
    if (!broadcastMode && !selectedClient && clients.length > 0) {
      handleSelectClient(clients[0], { auto: true })
    }
  }, [clients, selectedClient, broadcastMode, handleSelectClient])

  // 面包屑导航 - 进入子目录（基于当前层位置追加一段）
  const navigateToNode = useCallback((node) => {
    if (node.type === 'SubBox' && Array.isArray(node.children)) {
      setBreadcrumbPath(prev => [...prev, node.name])
      setSearchFilter('')
    }
  }, [])

  // 面包屑 - 回到根
  const navigateToRoot = useCallback(() => {
    setBreadcrumbPath([])
    setSearchFilter('')
  }, [])

  // 面包屑 - 回到某一级
  const navigateToBreadcrumb = useCallback((index) => {
    if (index < 0) {
      navigateToRoot()
      return
    }
    setBreadcrumbPath(prev => prev.slice(0, index + 1))
    setSearchFilter('')
  }, [navigateToRoot])

  // 执行 Lua 命令
  const handleExec = async () => {
    if (!luaInput.trim()) return
    if (!selectedClient && !broadcastMode) {
      toast.warning('请先选择一个客户端或广播模式')
      return
    }
    // LuaUI 上下文模式：包装代码注入 self + 重定向 print 到 web 日志
    let cmd = luaInput
    if (luaUiContext) {
      const escaped = luaUiContext.replace(/"/g, '\\"')
      cmd = `do
local self = XLuaUiManager.GetTopLuaUi("${escaped}")
if not self then RuntimeGMClient.SendLog("error", "UI not found: ${escaped}") return end
local __op = rawget(_G, "print")
rawset(_G, "print", function(...) local a={...}; for i,v in ipairs(a) do a[i]=tostring(v) end; if __op then pcall(__op, table.unpack(a)) end; RuntimeGMClient.SendLog("info", table.concat(a, "\\t")) end)
local __ok, __ret = pcall(function()
${luaInput}
end)
rawset(_G, "print", __op)
if not __ok then RuntimeGMClient.SendLog("error", "Error: " .. tostring(__ret))
elseif __ret ~= nil then RuntimeGMClient.SendLog("info", "→ " .. tostring(__ret)) end
end`
    }
    try {
      const url = broadcastMode
        ? '/api/gm_console/broadcast'
        : `/api/gm_console/clients/${encodeURIComponent(selectedClient.id)}/exec`
      if (!broadcastMode) setAutoSelectedClientId(null) // 对当前客户端发命令，消光
      const logType = luaUiContext ? 'cmd' : (broadcastMode ? 'broadcast' : 'cmd')
      const logText = luaUiContext ? `[self=${luaUiContext}] ${luaInput}` : (broadcastMode ? `[广播] ${luaInput}` : `> ${luaInput}`)
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
  // 请求客户端截图
  const handleRequestScreenshot = async (clientId) => {
    try {
      const res = await fetch(`/api/gm_console/clients/${encodeURIComponent(clientId)}/screenshot`, { method: 'POST' })
      if (res.ok) {
        toast.success('已请求截图，等待客户端响应...')
      } else {
        const data = await res.json().catch(() => ({}))
        toast.error(data.detail || '请求失败')
      }
    } catch (err) {
      toast.error('请求截图失败: ' + err.message)
    }
  }

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
    if (!broadcastMode) setAutoSelectedClientId(null) // 对当前客户端发命令，消光

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
    if (!broadcastMode) setAutoSelectedClientId(null) // 对当前客户端发命令，消光

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

  // 自定义 GM CRUD：保存逻辑收敛到 <CustomGmModal> 内部。
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

  // 自定义 GM 拖拽重排：本地立即生效 + 后端持久化（乐观更新）
  const handleReorderCustomGm = useCallback((fromIdx, toIdx) => {
    if (fromIdx === toIdx) return
    setCustomGmList(prev => {
      const next = [...prev]
      const [item] = next.splice(fromIdx, 1)
      const adjusted = toIdx > fromIdx ? toIdx - 1 : toIdx
      next.splice(adjusted, 0, item)
      fetch('/api/gm_console/custom-gm/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands: next }),
      }).catch(err => console.error('GM 重排同步后端失败:', err))
      return next
    })
  }, [])

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
        <div className="max-w-[1920px] mx-auto flex items-center gap-4">
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
        </div>
      </header>

      <main className="max-w-[1920px] mx-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="spinner" />
          </div>
        ) : (
          <div className="flex flex-col lg:flex-row gap-5" style={{ minHeight: 'calc(100vh - 120px)' }}>
            {/* Left Sidebar - Collapsible */}
            <div className={`shrink-0 transition-all duration-300 ease-in-out overflow-hidden ${sidebarCollapsed ? 'lg:w-[52px]' : 'lg:w-[260px]'}`}>
              {/* Toggle button - desktop only */}
              <button
                className="hidden lg:flex w-full items-center justify-center p-1.5 mb-2 rounded-lg hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] transition-colors"
                onClick={() => setSidebarCollapsed(prev => !prev)}
                title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
              >
                {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
              </button>

              {/* Collapsed view - desktop only when collapsed */}
              <div className={`${sidebarCollapsed ? 'lg:flex' : 'lg:hidden'} hidden flex-col items-center gap-3`}>
                <div className="glass-card p-2 w-full flex justify-center">
                  <div className="relative" title={`握手端口 ${handshakePort}`}>
                    <Radio size={18} className="text-[var(--sage)]" />
                  </div>
                </div>
                <div className="glass-card p-2.5 w-full">
                  <div className="flex flex-col items-center gap-1.5">
                    <div
                      className={`p-1.5 rounded-lg cursor-pointer transition-all ${broadcastMode ? 'bg-[var(--amber-soft)]/30' : 'hover:bg-[var(--cream-warm)]'}`}
                      onClick={handleSelectBroadcast}
                      title={`全部广播 (${clients.length})`}
                    >
                      <Globe size={16} className={broadcastMode ? 'text-[var(--amber)]' : 'text-[var(--coffee-muted)]'} />
                    </div>
                    {clients.map(client => (
                      <div
                        key={client.id}
                        className={`p-1.5 rounded-lg cursor-pointer transition-all ${
                          selectedClient?.id === client.id && !broadcastMode
                            ? 'bg-[var(--caramel-light)]/20'
                            : 'hover:bg-[var(--cream-warm)]'
                        } ${
                          autoSelectedClientId === client.id
                            ? 'auto-select-glow'
                            : ''
                        }`}
                        onClick={() => handleSelectClient(client)}
                        title={`${client.device || 'Unknown'}\n#${client.pid || '?'} · ${client.ip || ''} · ${client.platform || ''}`}
                      >
                        <PlatformIcon platform={client.platform} size={14}
                          className={
                            selectedClient?.id === client.id && !broadcastMode
                              ? 'text-[var(--caramel)]'
                              : 'text-[var(--coffee-muted)]'
                          } />
                      </div>
                    ))}
                    {clients.length === 0 && (
                      <span className="text-[var(--coffee-muted)] text-[9px]">无连接</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Expanded view - always on mobile, conditional on desktop */}
              <div className={`space-y-4 ${sidebarCollapsed ? 'lg:hidden' : ''}`}>
              {/* Handshake Port (read-only) */}
              <div className="glass-card p-5 animate-fade-in">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[var(--sage)] to-[var(--sage-soft)] flex items-center justify-center">
                      <Radio size={14} className="text-white" />
                    </div>
                    <h2 className="font-display text-base font-semibold text-[var(--coffee-deep)]">握手端口</h2>
                  </div>
                  <div className="flex items-center gap-1.5" title="所有分支 / 设备统一连接此固定端口">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--sage)] animate-pulse" />
                    <span className="font-mono text-sm font-semibold text-[var(--coffee-deep)]">:{handshakePort}</span>
                  </div>
                </div>
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
                      ? 'bg-gradient-to-r from-[var(--amber-soft)]/20 to-transparent border-l-[3px] border-[var(--amber)]'
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
                        className={`group flex items-center gap-2 p-2.5 rounded-lg cursor-pointer transition-all ${
                          selectedClient?.id === client.id && !broadcastMode
                            ? 'bg-gradient-to-r from-[var(--caramel-light)]/20 to-transparent border-l-[3px] border-[var(--caramel)]'
                            : 'bg-[var(--cream-warm)]/50 hover:bg-[var(--cream-warm)]'
                        } ${
                          autoSelectedClientId === client.id
                            ? 'auto-select-glow'
                            : ''
                        }`}
                        onClick={() => handleSelectClient(client)}
                      >
                        <span title={`${client.device || 'Unknown'}\n${client.ip || ''} · #${client.pid || '?'} · ${client.platform || ''}${client.svnAuthor ? '\n' + client.svnAuthor : ''}`}>
                          <PlatformIcon platform={client.platform} size={14}
                            className="text-[var(--caramel)] shrink-0" />
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-xs text-[var(--coffee-deep)] truncate">
                            {client.device || 'Unknown'}
                          </div>
                          <div className="text-[10px] text-[var(--coffee-muted)] overflow-hidden whitespace-nowrap">
                            {client.ip && (
                              <span className="font-mono text-[var(--coffee-deep)]">{client.ip}</span>
                            )}
                            {client.ip && client.pid > 0 ? ' · ' : ''}
                            {client.pid > 0 && (
                              <span className="font-mono text-[var(--coffee-light)]">#{client.pid}</span>
                            )}
                            {(client.ip || client.pid > 0) && client.svnAuthor ? ' · ' : ''}
                            {client.svnAuthor && (
                              <span className="inline-block max-w-[80px] overflow-hidden text-ellipsis whitespace-nowrap align-bottom" title={client.svnAuthor}>{client.svnAuthor}</span>
                            )}
                          </div>
                        </div>
                        <button
                          className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--cream-warm)] transition-all shrink-0"
                          title="抓取截图"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleRequestScreenshot(client.id)
                          }}
                        >
                          <Camera size={12} className="text-[var(--coffee-muted)]" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              </div>
            </div>

            {/* Center Panel - GM Commands (Tabs + Grid) */}
            <div className="flex-[3] min-w-0">
              <div className="glass-card p-5 h-full animate-fade-in" style={{ animationDelay: '0.15s' }}>
                {/* Tab Bar */}
                <div className="flex items-center justify-between mb-2">
                  <div className="bg-[var(--cream-warm)] rounded-lg p-1 min-w-0 flex-1">
                    <div ref={tabBarRef} className="flex items-center gap-1 px-2 overflow-x-auto scrollbar-hide" style={{ maskImage: 'linear-gradient(to right, transparent, black 14px, black calc(100% - 14px), transparent)', WebkitMaskImage: 'linear-gradient(to right, transparent, black 14px, black calc(100% - 14px), transparent)' }}>
                    {tabOrder.map(tabId => {
                      const meta = TAB_META[tabId]
                      if (!meta) return null
                      const Icon = meta.icon
                      const isActive = activeTab === tabId
                      const isDragging = dragTabRef.current === tabId
                      return (
                        <button
                          key={tabId}
                          draggable
                          onDragStart={e => {
                            dragTabRef.current = tabId
                            e.dataTransfer.effectAllowed = 'move'
                            e.currentTarget.style.opacity = '0.5'
                            e.currentTarget.style.transform = 'scale(1.05)'
                            e.currentTarget.style.zIndex = '10'
                          }}
                          onDragEnd={e => {
                            dragTabRef.current = null
                            setDropTarget(null)
                            e.currentTarget.style.opacity = ''
                            e.currentTarget.style.transform = ''
                            e.currentTarget.style.zIndex = ''
                          }}
                          onDragOver={e => {
                            e.preventDefault()
                            e.dataTransfer.dropEffect = 'move'
                            if (dragTabRef.current && dragTabRef.current !== tabId) {
                              const rect = e.currentTarget.getBoundingClientRect()
                              const side = (e.clientX - rect.left) < rect.width / 2 ? 'left' : 'right'
                              setDropTarget({ id: tabId, side })
                            }
                          }}
                          onDragLeave={() => {
                            setDropTarget(prev => prev?.id === tabId ? null : prev)
                          }}
                          onDrop={e => {
                            e.preventDefault()
                            const fromId = dragTabRef.current
                            if (!fromId || fromId === tabId) return
                            const rect = e.currentTarget.getBoundingClientRect()
                            const side = (e.clientX - rect.left) < rect.width / 2 ? 'left' : 'right'
                            setTabOrder(prev => {
                              const next = prev.filter(id => id !== fromId)
                              const targetIdx = next.indexOf(tabId)
                              const insertIdx = side === 'left' ? targetIdx : targetIdx + 1
                              next.splice(insertIdx, 0, fromId)
                              localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(next))
                              return next
                            })
                            setDropTarget(null)
                          }}
                          className={`relative px-3 py-1.5 rounded-md text-sm font-medium transition-all whitespace-nowrap flex-shrink-0 cursor-grab active:cursor-grabbing ${
                            isActive
                              ? 'bg-white text-[var(--coffee-deep)] shadow-sm'
                              : 'text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)]'
                          }`}
                          onClick={() => setActiveTab(tabId)}
                        >
                          {dropTarget?.id === tabId && (
                            <span className={`absolute top-1 bottom-1 w-0.5 rounded-full bg-[var(--caramel)] ${dropTarget.side === 'left' ? '-left-0.5' : '-right-0.5'}`} />
                          )}
                          <span className="flex items-center gap-1.5">
                            <Icon size={14} />
                            {meta.label}
                          </span>
                        </button>
                      )
                    })}
                    </div>
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
                          setAutoSelectedClientId(null) // 对当前客户端发命令，消光
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

                {TAB_META[activeTab]?.gridSlider && (
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
                )}

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
                        onClick={() => setCustomGmModal({ editingIndex: null, initial: { name: '', cmd: '' } })}
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
                        {customGmList.map((item, i) => {
                          const cmdTitle = item.cmd && item.cmd.length > 500
                            ? `${item.cmd.slice(0, 500)}...`
                            : item.cmd
                          return (
                            <div
                            key={i}
                            draggable
                            onDragStart={e => {
                              dragGmRef.current = i
                              e.dataTransfer.effectAllowed = 'move'
                              e.currentTarget.style.opacity = '0.5'
                            }}
                            onDragEnd={e => {
                              dragGmRef.current = null
                              setDropGmTarget(null)
                              e.currentTarget.style.opacity = ''
                            }}
                            onDragOver={e => {
                              if (dragGmRef.current === null || dragGmRef.current === i) return
                              e.preventDefault()
                              e.dataTransfer.dropEffect = 'move'
                              const rect = e.currentTarget.getBoundingClientRect()
                              const side = (e.clientX - rect.left) < rect.width / 2 ? 'left' : 'right'
                              setDropGmTarget({ idx: i, side })
                            }}
                            onDragLeave={() => setDropGmTarget(prev => prev?.idx === i ? null : prev)}
                            onDrop={e => {
                              e.preventDefault()
                              const fromIdx = dragGmRef.current
                              if (fromIdx === null || fromIdx === i) { setDropGmTarget(null); return }
                              const rect = e.currentTarget.getBoundingClientRect()
                              const side = (e.clientX - rect.left) < rect.width / 2 ? 'left' : 'right'
                              const insertIdx = side === 'left' ? i : i + 1
                              handleReorderCustomGm(fromIdx, insertIdx)
                              dragGmRef.current = null
                              setDropGmTarget(null)
                            }}
                            className="gm-btn-core group relative cursor-grab active:cursor-grabbing"
                            style={{ height: btnHeight }}
                            onClick={() => handleExecCustomGm(item.cmd)}
                            title={`${item.name}\n${cmdTitle}\n（按住可拖动排序）`}
                          >
                            {dropGmTarget?.idx === i && (
                              <span className={`absolute top-1 bottom-1 w-0.5 rounded-full bg-[var(--caramel)] z-10 ${dropGmTarget.side === 'left' ? '-left-1' : '-right-1'}`} />
                            )}
                            <div className="w-full text-left pr-7">
                              <span className="line-clamp-2">{item.name}</span>
                            </div>
                            <div
                              className="absolute right-0.5 top-0 bottom-0 flex flex-col justify-center gap-0"
                              style={{ display: 'flex', flexDirection: 'column' }}
                            >
                              <button
                                draggable={false}
                                className="p-1 rounded-md text-[var(--coffee-muted)]/50 hover:text-[var(--coffee-deep)] hover:bg-[var(--cream-warm)] transition-all"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setCustomGmModal({ editingIndex: i, initial: { name: item.name, cmd: item.cmd } })
                                }}
                              >
                                <Edit size={11} />
                              </button>
                              <button
                                draggable={false}
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
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: activeTab === 'animator' ? 'contents' : 'none' }}>
                  <AnimatorViewer
                    clients={clients}
                    selectedClient={selectedClient}
                    broadcastMode={broadcastMode}
                    active={activeTab === 'animator'}
                  />
                </div>

                <div style={{ display: activeTab === 'lua_inspector' ? 'contents' : 'none' }}>
                  <LuaUiInspector
                    clients={clients}
                    selectedClient={selectedClient}
                    broadcastMode={broadcastMode}
                    luaUiContext={luaUiContext}
                    onBindConsole={handleBindLuaUiConsole}
                    onPinToMonitor={handlePinLuaUiToMonitor}
                    onLocateInHierarchy={handleLocateInHierarchy}
                    active={activeTab === 'lua_inspector'}
                  />
                </div>

                <div style={{ display: activeTab === 'timeline' ? 'contents' : 'none' }}>
                  <TimelineMonitor
                    clients={clients}
                    selectedClient={selectedClient}
                    broadcastMode={broadcastMode}
                    active={activeTab === 'timeline'}
                  />
                </div>

                <div style={{ display: activeTab === 'hierarchy' ? 'contents' : 'none' }}>
                  <Hierarchy
                    clients={clients}
                    selectedClient={selectedClient}
                    pendingLocate={pendingLocate}
                    onPendingLocateConsumed={handlePendingLocateConsumed}
                    active={activeTab === 'hierarchy'}
                  />
                </div>

                <div style={{ display: activeTab === 'subpkg_monitor' ? 'contents' : 'none' }}>
                  <SubPackageMonitor
                    clients={clients}
                    selectedClient={selectedClient}
                    broadcastMode={broadcastMode}
                    active={activeTab === 'subpkg_monitor'}
                  />
                </div>

                <div style={{ display: activeTab === 'player_prefs' ? 'contents' : 'none' }}>
                  <PlayerPrefsViewer
                    clients={clients}
                    selectedClient={selectedClient}
                    active={activeTab === 'player_prefs'}
                  />
                </div>

                <div style={{ display: activeTab === 'av_monitor' ? 'contents' : 'none' }}>
                  <AvMonitor
                    clients={clients}
                    selectedClient={selectedClient}
                    active={activeTab === 'av_monitor'}
                  />
                </div>

                <div style={{ display: activeTab === 'proto' ? 'contents' : 'none' }}>
                  <ProtoRequester
                    clients={clients}
                    selectedClient={selectedClient}
                    active={activeTab === 'proto'}
                    haruRootInfo={haruRootInfo}
                  />
                </div>

                <div style={{ display: activeTab === 'table_monitor' ? 'contents' : 'none' }}>
                  <TableViewer
                    clients={clients}
                    selectedClient={selectedClient}
                    broadcastMode={broadcastMode}
                    active={activeTab === 'table_monitor'}
                  />
                </div>
              </div>
            </div>

            {/* Right Panel - Lua Input & Logs */}
            <div className="flex-[2] min-w-0 space-y-4">
              {/* Lua Input */}
              <div className="glass-card p-5 animate-fade-in" style={{ animationDelay: '0.2s' }}>
                <div className="flex items-center gap-2 mb-3">
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${luaUiContext ? 'bg-gradient-to-br from-[var(--caramel)] to-[var(--amber)]' : 'bg-gradient-to-br from-[var(--amber)] to-[var(--honey)]'}`}>
                    <Terminal size={14} className="text-white" />
                  </div>
                  <h2 className="font-display text-base font-semibold text-[var(--coffee-deep)]">
                    {luaUiContext ? 'Lua 命令' : 'Lua 命令'}
                  </h2>
                  {luaUiContext && (
                    <span className="flex items-center gap-1.5 ml-1 px-2 py-0.5 rounded-full bg-[var(--caramel)]/15 text-[var(--caramel)] text-xs font-mono">
                      🔗 self = {luaUiContext}
                      <button onClick={() => setLuaUiContext(null)} className="hover:text-[var(--terracotta)] ml-0.5" title="退出 LuaUI 模式">✕</button>
                    </span>
                  )}
                </div>
                <textarea
                  className={`w-full h-36 bg-[var(--coffee-deep)] text-[var(--sage)] rounded-xl p-3 text-xs font-mono resize-none focus:outline-none focus:ring-2 placeholder-[var(--coffee-muted)] ${luaUiContext ? 'ring-2 ring-[var(--caramel)]/40 focus:ring-[var(--caramel)]' : 'focus:ring-[var(--caramel)]'}`}
                  placeholder={luaUiContext ? `self 已绑定到 ${luaUiContext}，直接用 self.xxx / self:Method() / print(self.Name) ...` : '输入 Lua 代码... (Ctrl+Enter 执行)'}
                  value={luaInput}
                  onChange={e => setLuaInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && e.ctrlKey) handleExec()
                  }}
                />
                <div className="flex gap-2 mt-3">
                  <button className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm ${luaUiContext ? 'btn-primary bg-[var(--caramel)] hover:bg-[var(--caramel)]/90' : 'btn-primary'}`} onClick={handleExec}>
                    <Send size={14} />
                    {luaUiContext ? `执行 (self)` : '执行'}
                  </button>
                  {!luaUiContext && (
                    <button className="btn-secondary flex-1 flex items-center justify-center gap-2 py-2 text-sm" onClick={handleBroadcast}>
                      <Megaphone size={14} />
                      广播
                    </button>
                  )}
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
                <div ref={logsContainerRef} className="min-h-[256px] h-64 bg-[var(--coffee-deep)] rounded-xl p-3 overflow-auto font-mono text-xs leading-relaxed">
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
                </div>
              </div>

              {/* HaruRoot Config */}
              <div className="glass-card p-4 animate-fade-in" style={{ animationDelay: '0.3s' }}>
                <HaruRootConfig haruRootInfo={haruRootInfo} onConfigChange={setHaruRootInfo} onRefresh={refreshHaruRootInfo} />
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Screenshot Modal */}
      {screenshot && (
        <div className="modal-overlay" onMouseDown={() => setScreenshot(null)}>
          <div className="glass-card p-4 max-w-[90vw] max-h-[90vh]" onClick={e => e.stopPropagation()}
            style={{ animation: 'slideUp 0.3s ease' }}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[var(--caramel)] to-[var(--caramel-light)] flex items-center justify-center">
                  <Camera size={14} className="text-white" />
                </div>
                <h3 className="font-display text-sm font-semibold text-[var(--coffee-deep)]">
                  截图 · {clients.find(c => c.id === screenshot.client_id)?.device || screenshot.client_id}
                </h3>
              </div>
              <button onClick={() => setScreenshot(null)}
                className="p-2 rounded-lg hover:bg-[var(--cream-warm)] transition-colors text-[var(--coffee-muted)]">
                <X size={20} />
              </button>
            </div>
            <img src={`data:image/jpeg;base64,${screenshot.image}`}
              alt="客户端截图"
              className="rounded-lg max-h-[70vh] object-contain"
              style={{ width: screenshot.width, maxWidth: '100%', height: 'auto' }} />
          </div>
        </div>
      )}

      {/* Custom GM Modal */}
      <CustomGmModal
        spec={customGmModal}
        onClose={() => setCustomGmModal(null)}
        onSaved={() => { setCustomGmModal(null); fetchCustomGm() }}
      />
    </div>
  )
}

export default GmConsole


// ============================================================================
// HaruRoot 配置组件
// ============================================================================
function HaruRootConfig({ haruRootInfo, onConfigChange, onRefresh }) {
  const [haruroot, setHaruroot] = useState(haruRootInfo?.haruroot || '')
  const [saving, setSaving] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    setHaruroot(haruRootInfo?.haruroot || '')
  }, [haruRootInfo?.haruroot])

  const handleSave = async () => {
    setSaving(true)
    setErrorMsg('')
    try {
      const resp = await fetch('/api/gm_console/proto/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ haruroot: haruroot.trim() })
      })
      const data = await resp.json()
      if (!resp.ok) {
        setErrorMsg(data.detail || '保存失败')
      } else {
        onRefresh?.()
      }
    } catch (e) {
      setErrorMsg('保存失败: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    setSaving(true)
    try {
      const resp = await fetch('/api/gm_console/proto/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ haruroot: '' })
      })
      if (resp.ok) {
        onRefresh?.()
      }
    } catch {
      // ignore
    } finally {
      setSaving(false)
    }
  }

  const inputCls = "px-2 py-1 text-xs rounded border border-[var(--glass-border)] bg-white/50 focus:outline-none focus:border-[var(--caramel)]"

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Settings size={14} className="text-[var(--coffee-light)]" />
        <h3 className="text-xs font-semibold text-[var(--coffee-deep)]">HaruRoot</h3>
        {haruRootInfo?.valid && (
          <span className={`w-1.5 h-1.5 rounded-full bg-[var(--sage)]`} />
        )}
        {!haruRootInfo?.valid && haruRootInfo?.haruroot && (
          <span className={`w-1.5 h-1.5 rounded-full bg-[var(--terracotta)]`} title="路径无效" />
        )}
      </div>
      <div className="flex items-center gap-2">
        <input type="text" value={haruroot}
          onChange={e => setHaruroot(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
          placeholder="游戏项目根路径 (含 Dev/Client 和 Product/Lua)"
          className={`flex-1 ${inputCls}`}
        />
        <button onClick={handleSave} disabled={saving || !haruroot.trim()}
          className="px-2 py-1 rounded text-[10px] bg-[var(--cream-warm)] text-[var(--coffee-deep)] hover:bg-[var(--caramel)]/20 disabled:opacity-30 transition-colors">
          {saving ? '...' : '保存'}
        </button>
        {haruRootInfo?.haruroot && (
          <button onClick={handleClear} disabled={saving}
            className="px-2 py-1 rounded text-[10px] bg-[var(--terracotta)]/10 text-[var(--terracotta)] hover:bg-[var(--terracotta)]/20 disabled:opacity-30 transition-colors">
            清除
          </button>
        )}
      </div>
      {!haruRootInfo?.valid && haruRootInfo?.haruroot && !errorMsg && (
        <div className="mt-1 text-[10px] text-[var(--terracotta)]">路径无效，需包含 Dev/Client 和 Product/Lua</div>
      )}
      {errorMsg && (
        <div className="mt-1 text-[10px] text-[var(--terracotta)]">{errorMsg}</div>
      )}
    </div>
  )
}

// ============================================================================
// 自定义 GM 弹窗
// 拆出独立组件的目的：把表单 state 限制在 modal 内，让敲键盘不再触发顶层 GmConsole
// 以及那 9 个 display:none 常驻挂载的兄弟 tab 子组件全树重渲染。
// ============================================================================
function CustomGmModal({ spec, onClose, onSaved }) {
  const toast = useToast()
  const open = spec !== null
  const editingIndex = spec?.editingIndex ?? null
  const initialCmd = spec?.initial?.cmd || ''
  const [name, setName] = useState(() => spec?.initial?.name || '')
  const overlayRef = useRef(null)
  const cmdRef = useRef(null)
  const [saving, setSaving] = useState(false)

  // 每次打开/切换条目时，把表单重置为传入的 initial。关闭时不重置（避免动画期间内容闪烁）。
  useEffect(() => {
    if (!open) return
    setName(spec.initial?.name || '')
    if (cmdRef.current) {
      cmdRef.current.value = spec.initial?.cmd || ''
    }
  }, [open, spec])

  useEffect(() => {
    if (!open) return
    const overlay = overlayRef.current
    if (!overlay) return

    const handleWheel = (e) => {
      const textarea = cmdRef.current
      if (textarea && textarea.contains(e.target)) {
        const atTop = textarea.scrollTop <= 0
        const atBottom = textarea.scrollTop + textarea.clientHeight >= textarea.scrollHeight - 1
        if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) {
          e.preventDefault()
        }
        e.stopPropagation()
        return
      }
      e.preventDefault()
      e.stopPropagation()
    }

    const handleTouchMove = (e) => {
      const textarea = cmdRef.current
      if (textarea && textarea.contains(e.target)) return
      e.preventDefault()
      e.stopPropagation()
    }

    overlay.addEventListener('wheel', handleWheel, { passive: false })
    overlay.addEventListener('touchmove', handleTouchMove, { passive: false })
    return () => {
      overlay.removeEventListener('wheel', handleWheel)
      overlay.removeEventListener('touchmove', handleTouchMove)
    }
  }, [open])

  if (!open) return null

  const handleSave = async () => {
    const cmd = cmdRef.current?.value || ''
    if (!name.trim() || !cmd.trim()) {
      toast.warning('请填写名称和命令')
      return
    }
    setSaving(true)
    try {
      const url = editingIndex !== null
        ? `/api/gm_console/custom-gm/${editingIndex}`
        : '/api/gm_console/custom-gm'
      const method = editingIndex !== null ? 'PUT' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, cmd }),
      })
      if (res.ok) {
        toast.success(editingIndex !== null ? '已更新' : '已添加')
        onSaved?.()
      } else {
        const data = await res.json()
        toast.error(data.detail || '保存失败')
      }
    } catch (err) {
      toast.error('保存失败: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(74, 64, 58, 0.38)',
        backdropFilter: 'none',
        WebkitBackdropFilter: 'none',
        overscrollBehavior: 'contain',
      }}
      onWheel={(e) => {
        if (e.target === e.currentTarget) e.preventDefault()
      }}
      onTouchMove={(e) => {
        if (e.target === e.currentTarget) e.preventDefault()
      }}
    >
      <div
        className="absolute inset-0"
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(74, 64, 58, 0.24)',
          pointerEvents: 'auto',
        }}
        onWheel={(e) => e.preventDefault()}
        onTouchMove={(e) => e.preventDefault()}
        onMouseDown={onClose}
      />
      <div
        className="relative z-10 overflow-hidden p-6 w-[min(780px,92vw)]"
        style={{
          position: 'relative',
          zIndex: 10,
          overflow: 'hidden',
          padding: 24,
          width: 'min(780px, 92vw)',
          maxHeight: 'calc(100vh - 48px)',
          animation: 'slideUp 0.2s ease',
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--glass-border)',
          boxShadow: 'var(--glass-shadow)',
          background: 'rgba(255, 252, 247, 0.96)',
          overscrollBehavior: 'contain',
        }}
        onWheel={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
      >
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background: 'linear-gradient(135deg, rgba(255,255,255,0.72) 0%, rgba(255,248,238,0.42) 48%, rgba(245,237,227,0.7) 100%)',
          }}
        />
        <div className="relative z-10" style={{ position: 'relative', zIndex: 10 }}>
          <div className="flex items-center justify-between mb-5" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div className="flex items-center gap-3" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                className="w-10 h-10 rounded-lg bg-gradient-to-br from-[var(--caramel)] to-[var(--caramel-dark)] flex items-center justify-center"
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  background: 'linear-gradient(135deg, var(--caramel), var(--caramel-dark))',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Layers size={20} className="text-white" />
              </div>
              <h3 className="font-display text-lg font-semibold">
                {editingIndex !== null ? '编辑命令' : '新增命令'}
              </h3>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-[var(--cream-warm)] transition-colors text-[var(--coffee-muted)]"
              style={{ width: 36, height: 36, padding: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <X size={20} />
            </button>
          </div>
          <div className="space-y-4" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label className="block text-sm text-[var(--coffee-light)] mb-2" style={{ display: 'block', marginBottom: 8, color: 'var(--coffee-light)', fontSize: 14 }}>名称</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="命令名称"
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
            </div>
            <div>
              <label className="block text-sm text-[var(--coffee-light)] mb-2" style={{ display: 'block', marginBottom: 8, color: 'var(--coffee-light)', fontSize: 14 }}>Lua 命令</label>
              <textarea
                ref={cmdRef}
                className="w-full h-80 bg-[var(--coffee-deep)] text-[var(--sage)] rounded-xl p-3 text-xs font-mono resize-none overflow-auto focus:outline-none focus:ring-2 focus:ring-[var(--caramel)] placeholder-[var(--coffee-muted)]"
                style={{
                  width: '100%',
                  height: 320,
                  minHeight: 320,
                  boxSizing: 'border-box',
                  background: 'var(--coffee-deep)',
                  color: 'var(--sage)',
                  borderRadius: 12,
                  padding: 12,
                  fontSize: 12,
                  fontFamily: 'var(--font-mono)',
                  lineHeight: 1.45,
                  resize: 'none',
                  overflow: 'auto',
                  outline: 'none',
                  overscrollBehavior: 'contain',
                  transition: 'none',
                }}
                defaultValue={initialCmd}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder="输入 Lua 代码..."
              />
            </div>
            <div className="flex gap-3 pt-2" style={{ display: 'flex', gap: 12, paddingTop: 8 }}>
              <button className="btn-secondary flex-1" style={{ flex: 1 }} onClick={onClose} disabled={saving}>取消</button>
              <button className="btn-primary flex-1" style={{ flex: 1 }} onClick={handleSave} disabled={saving}>{saving ? '保存中...' : '保存'}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
