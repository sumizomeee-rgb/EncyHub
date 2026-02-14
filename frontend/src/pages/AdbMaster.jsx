import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, RefreshCw, Smartphone, Wifi, Usb, FileText, Upload, Download,
  X, Package, RotateCcw, WifiOff, ChevronDown, ChevronRight, FolderOpen,
  Play, Square, Zap, Edit, Check
} from 'lucide-react'
import { useToast } from '../components/Toast'

function AdbMaster() {
  const navigate = useNavigate()
  const toast = useToast()
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedDevice, setSelectedDevice] = useState(null)
  const [logcat, setLogcat] = useState([])
  const [logcatRunning, setLogcatRunning] = useState(false)
  const wsRef = useRef(null)
  const logcatEndRef = useRef(null)

  // 展开面板状态
  const [expandLogcat, setExpandLogcat] = useState(true)
  const [expandTransfer, setExpandTransfer] = useState(false)

  // 弹窗状态
  const [showInstallModal, setShowInstallModal] = useState(false)

  // 表单状态
  const [pushLocalPath, setPushLocalPath] = useState('')
  const [pushRemotePath, setPushRemotePath] = useState('/sdcard/')
  const [pullRemotePath, setPullRemotePath] = useState('')
  const [pullLocalPath, setPullLocalPath] = useState('')
  const [installFile, setInstallFile] = useState(null)

  // 操作状态
  const [operating, setOperating] = useState(false)

  // 路径历史
  const [pushHistory, setPushHistory] = useState([])
  const [pullHistory, setPullHistory] = useState([])
  const [showPushHistory, setShowPushHistory] = useState(false)
  const [showPullHistory, setShowPullHistory] = useState(false)

  const fetchPathHistory = async () => {
    try {
      const [pushRes, pullRes] = await Promise.all([
        fetch('/api/adb_master/path-history/push'),
        fetch('/api/adb_master/path-history/pull'),
      ])
      if (pushRes.ok) {
        const data = await pushRes.json()
        setPushHistory(data.history || [])
      }
      if (pullRes.ok) {
        const data = await pullRes.json()
        setPullHistory(data.history || [])
      }
    } catch {}
  }

  // 昵称编辑
  const [editingNickname, setEditingNickname] = useState(false)
  const [nicknameInput, setNicknameInput] = useState('')

  const handleSaveNickname = async () => {
    if (!selectedDevice) return
    try {
      const res = await fetch(`/api/adb_master/devices/${selectedDevice.hardware_id}/nickname`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: nicknameInput }),
      })
      if (res.ok) {
        setEditingNickname(false)
        fetchDevices()
      } else {
        const data = await res.json()
        toast.error(data.detail || '保存失败')
      }
    } catch (err) {
      toast.error('保存失败: ' + err.message)
    }
  }

  const fetchDevices = async () => {
    try {
      const res = await fetch('/api/adb_master/devices')
      if (res.ok) {
        const data = await res.json()
        setDevices(data.devices || [])
        if (selectedDevice) {
          const updated = data.devices?.find(d => d.hardware_id === selectedDevice.hardware_id)
          if (updated) setSelectedDevice(updated)
        }
      }
    } catch (err) {
      console.error('获取设备列表失败:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchDevices()
    fetchPathHistory()
    const interval = setInterval(fetchDevices, 3000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    logcatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logcat])

  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [])

  // 获取连接状态徽章
  const getConnectionBadge = (device) => {
    if (device.usb_connected && device.wifi_connected) {
      return { icon: '◈', label: 'WiFi & USB', className: 'badge-dual' }
    } else if (device.wifi_connected) {
      return { icon: '◉', label: 'WiFi', className: 'badge-wifi' }
    } else if (device.usb_connected) {
      return { icon: '⚡', label: 'USB', className: 'badge-usb' }
    }
    return { icon: '○', label: '离线', className: 'badge-offline' }
  }

  // 开始/停止 Logcat
  const toggleLogcat = () => {
    if (logcatRunning) {
      if (wsRef.current) {
        wsRef.current.send('stop')
        wsRef.current.close()
        wsRef.current = null
      }
      setLogcatRunning(false)
    } else {
      if (!selectedDevice) return
      const wsUrl = `ws://${window.location.host}/api/adb_master/devices/${selectedDevice.hardware_id}/logcat`
      const ws = new WebSocket(wsUrl)
      let connectTimeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close()
          setLogcatRunning(false)
          toast.error('Logcat 连接超时')
        }
      }, 5000)
      ws.onopen = () => {
        clearTimeout(connectTimeout)
        setLogcatRunning(true)
        setLogcat([])
      }
      ws.onmessage = (e) => {
        if (e.data) {
          // 检查是否为 JSON 错误消息
          try {
            const json = JSON.parse(e.data)
            if (json.error) {
              toast.error(json.error)
              return
            }
          } catch {}
          setLogcat(prev => {
            const newLogs = [...prev, e.data]
            if (newLogs.length > 500) {
              return newLogs.slice(-500)
            }
            return newLogs
          })
        }
      }
      ws.onerror = () => {
        clearTimeout(connectTimeout)
        setLogcatRunning(false)
        toast.error('Logcat 连接失败')
      }
      ws.onclose = () => setLogcatRunning(false)
      wsRef.current = ws
    }
  }

  // 推送文件
  const handlePush = async () => {
    if (!pushLocalPath.trim() || !selectedDevice) return
    setOperating(true)
    try {
      const res = await fetch(`/api/adb_master/devices/${selectedDevice.hardware_id}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ local_path: pushLocalPath, remote_path: pushRemotePath }),
      })
      const text = await res.text()
      try {
        const data = JSON.parse(text)
        if (res.ok) {
          toast.success(data.message || '推送成功')
          fetchPathHistory()
        } else {
          toast.error(data.detail || '推送失败')
        }
      } catch {
        if (res.ok) toast.success('推送成功')
        else toast.error('推送失败: ' + text.substring(0, 100))
      }
    } catch (err) {
      toast.error('推送失败: ' + err.message)
    } finally {
      setOperating(false)
    }
  }

  // 拉取文件
  const handlePull = async () => {
    if (!pullRemotePath.trim() || !selectedDevice) return
    setOperating(true)
    try {
      const res = await fetch(`/api/adb_master/devices/${selectedDevice.hardware_id}/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: pullRemotePath, local_path: pullLocalPath || '' }),
      })
      if (res.ok) {
        const contentType = res.headers.get('content-type') || ''
        if (contentType.includes('application/json')) {
          const data = await res.json()
          toast.success(data.message || '拉取成功')
        } else {
          // FileResponse fallback - browser download
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = pullRemotePath.split('/').pop() || 'file'
          a.click()
          URL.revokeObjectURL(url)
          toast.success('拉取成功')
        }
        setPullRemotePath('')
        fetchPathHistory()
      } else {
        const text = await res.text()
        try {
          const data = JSON.parse(text)
          toast.error(data.detail || '拉取失败')
        } catch {
          toast.error('拉取失败: ' + text.substring(0, 100))
        }
      }
    } catch (err) {
      toast.error('拉取失败: ' + err.message)
    } finally {
      setOperating(false)
    }
  }

  // 安装 APK
  const handleInstall = async () => {
    if (!installFile || !selectedDevice) return
    setOperating(true)
    try {
      const formData = new FormData()
      formData.append('file', installFile)

      const res = await fetch(`/api/adb_master/devices/${selectedDevice.hardware_id}/install`, {
        method: 'POST',
        body: formData,
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(data.message || '安装成功')
        setShowInstallModal(false)
        setInstallFile(null)
      } else {
        toast.error(data.detail || '安装失败')
      }
    } catch (err) {
      toast.error('安装失败: ' + err.message)
    } finally {
      setOperating(false)
    }
  }

  // 重启前台应用
  const handleRestartApp = async () => {
    if (!selectedDevice) return
    try {
      const res = await fetch(`/api/adb_master/devices/${selectedDevice.hardware_id}/restart-app`, {
        method: 'POST',
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(data.message || '重启成功')
      } else {
        toast.error(data.detail || '重启失败')
      }
    } catch (err) {
      toast.error('重启失败: ' + err.message)
    }
  }

  // 连接 WiFi
  const handleConnectWifi = async () => {
    if (!selectedDevice) return
    try {
      const res = await fetch(`/api/adb_master/devices/${selectedDevice.hardware_id}/connect-wifi`, {
        method: 'POST',
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(data.message || '连接成功')
        fetchDevices()
      } else {
        toast.error(data.detail || '连接失败')
      }
    } catch (err) {
      toast.error('连接失败: ' + err.message)
    }
  }

  // 断开连接
  const handleDisconnect = async () => {
    if (!selectedDevice) return
    try {
      const res = await fetch(`/api/adb_master/devices/${selectedDevice.hardware_id}/disconnect`, {
        method: 'POST',
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(data.message || '已断开')
        fetchDevices()
      } else {
        toast.error(data.detail || '断开失败')
      }
    } catch (err) {
      toast.error('断开失败: ' + err.message)
    }
  }

  return (
    <div className="min-h-screen">
      {/* Top Bar */}
      <header className="sticky top-0 z-50 bg-[var(--glass-bg)] backdrop-blur-xl border-b border-[var(--glass-border)] px-6 py-4">
        <div className="max-w-[1400px] mx-auto flex items-center gap-4">
          <button
            className="btn-secondary p-2.5"
            onClick={() => navigate('/')}
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <h1 className="font-display text-2xl font-semibold text-[var(--coffee-deep)]">
              ADB Master
            </h1>
            <p className="text-[var(--coffee-muted)] text-sm">Android 设备管理</p>
          </div>
          <button
            className="btn-secondary flex items-center gap-2"
            onClick={async () => {
              const wifiOnly = devices.filter(d => d.wifi_connected && !d.usb_connected)
              for (const d of wifiOnly) {
                try {
                  await fetch(`/api/adb_master/devices/${d.hardware_id}/disconnect`, { method: 'POST' })
                } catch {}
              }
              if (wifiOnly.length > 0) toast.success(`已清除 ${wifiOnly.length} 个 WiFi 连接`)
              else toast.info('无需清除')
              fetchDevices()
            }}
          >
            <WifiOff size={16} />
            清除离线
          </button>
          <button
            className="btn-secondary flex items-center gap-2"
            onClick={fetchDevices}
          >
            <RefreshCw size={16} />
            刷新
          </button>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="spinner" />
          </div>
        ) : devices.length === 0 ? (
          <div className="glass-card p-12 text-center animate-fade-in">
            <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-[var(--cream-warm)] flex items-center justify-center">
              <Smartphone size={40} className="text-[var(--coffee-muted)]" />
            </div>
            <h3 className="font-display text-xl text-[var(--coffee-deep)] mb-2">未发现设备</h3>
            <p className="text-[var(--coffee-muted)] max-w-md mx-auto">
              请连接 Android 设备并确保已启用 USB 调试模式
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            {/* Device Discovery Hub */}
            <div className="xl:col-span-1">
              <div className="glass-card p-5 animate-fade-in">
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--caramel)] to-[var(--caramel-dark)] flex items-center justify-center">
                    <Smartphone size={16} className="text-white" />
                  </div>
                  <h2 className="font-display text-lg font-semibold text-[var(--coffee-deep)]">
                    设备发现
                  </h2>
                </div>
                <div className="space-y-2">
                  {devices.map(device => {
                    const badge = getConnectionBadge(device)
                    const isSelected = selectedDevice?.hardware_id === device.hardware_id
                    return (
                      <div
                        key={device.hardware_id}
                        className={`p-4 rounded-xl cursor-pointer transition-all border-l-4 ${
                          isSelected
                            ? 'bg-gradient-to-r from-[var(--caramel-light)]/20 to-transparent border-[var(--caramel)]'
                            : 'bg-[var(--cream-warm)]/50 border-transparent hover:border-[var(--caramel-light)] hover:bg-[var(--cream-warm)]'
                        }`}
                        onClick={() => setSelectedDevice(device)}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-[var(--coffee-deep)] truncate">
                                {device.nickname || device.model || device.hardware_id}
                              </span>
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                                badge.className === 'badge-dual' ? 'bg-[var(--amber-soft)]/30 text-[var(--amber)]' :
                                badge.className === 'badge-wifi' ? 'bg-[var(--sky-soft)]/30 text-[var(--sky)]' :
                                badge.className === 'badge-usb' ? 'bg-[var(--sage-soft)]/30 text-[var(--sage)]' :
                                'bg-[var(--cream-warm)] text-[var(--coffee-muted)]'
                              }`}>
                                {badge.icon} {badge.label}
                              </span>
                            </div>
                            <div className="text-xs text-[var(--coffee-muted)] mt-1 font-mono truncate">
                              {device.hardware_id?.slice(0, 16)}...
                            </div>
                            {device.wifi_ip && (
                              <div className="text-xs text-[var(--sky)] mt-0.5 font-mono">
                                ⊛ {device.wifi_ip}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            {/* Control Center */}
            <div className="xl:col-span-2">
              {selectedDevice ? (
                <div className="glass-card p-5 animate-fade-in">
                  {/* Device Header */}
                  <div className="flex items-center justify-between mb-6 pb-4 border-b border-[var(--glass-border)]">
                    <div className="flex items-center gap-3">
                      <span className={`text-lg ${
                        selectedDevice.usb_connected && selectedDevice.wifi_connected ? 'text-[var(--amber)]' :
                        selectedDevice.wifi_connected ? 'text-[var(--sky)]' :
                        'text-[var(--sage)]'
                      }`}>
                        {getConnectionBadge(selectedDevice).icon}
                      </span>
                      <div>
                        {editingNickname ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={nicknameInput}
                              onChange={e => setNicknameInput(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') handleSaveNickname(); if (e.key === 'Escape') setEditingNickname(false) }}
                              className="font-display text-lg font-semibold px-2 py-0.5 rounded-lg border border-[var(--caramel)] bg-white w-48"
                              autoFocus
                            />
                            <button
                              className="p-1 rounded-lg hover:bg-[var(--success-soft)] text-[var(--sage)] transition-colors"
                              onClick={handleSaveNickname}
                            >
                              <Check size={16} />
                            </button>
                            <button
                              className="p-1 rounded-lg hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] transition-colors"
                              onClick={() => setEditingNickname(false)}
                            >
                              <X size={16} />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 group/name">
                            <h3 className="font-display text-lg font-semibold text-[var(--coffee-deep)]">
                              {selectedDevice.nickname || selectedDevice.model || '设备控制'}
                            </h3>
                            <button
                              className="p-1 rounded-lg hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] opacity-0 group-hover/name:opacity-100 transition-all"
                              onClick={() => {
                                setNicknameInput(selectedDevice.nickname || selectedDevice.model || '')
                                setEditingNickname(true)
                              }}
                              title="编辑昵称"
                            >
                              <Edit size={14} />
                            </button>
                          </div>
                        )}
                        <p className="text-xs text-[var(--coffee-muted)] font-mono">
                          {selectedDevice.hardware_id}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        className="btn-primary flex items-center gap-2"
                        onClick={() => setShowInstallModal(true)}
                      >
                        <Package size={16} />
                        安装 APK
                      </button>
                      <button
                        className="btn-secondary flex items-center gap-2"
                        onClick={handleRestartApp}
                      >
                        <RotateCcw size={16} />
                        重启应用
                      </button>
                      {selectedDevice.usb_connected && !selectedDevice.wifi_connected && (
                        <button
                          className="btn-secondary flex items-center gap-2"
                          onClick={handleConnectWifi}
                        >
                          <Wifi size={16} />
                          WiFi 连接
                        </button>
                      )}
                      {selectedDevice.wifi_connected && (
                        <button
                          className="btn-danger flex items-center gap-2"
                          onClick={handleDisconnect}
                        >
                          <WifiOff size={16} />
                          断开
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Logcat Panel */}
                  <div className="mb-4">
                    <div
                      className="w-full flex items-center justify-between p-3 rounded-lg bg-[var(--cream-warm)]/50 hover:bg-[var(--cream-warm)] transition-colors cursor-pointer"
                      role="button"
                      onClick={() => setExpandLogcat(!expandLogcat)}
                    >
                      <div className="flex items-center gap-2">
                        {expandLogcat ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                        <FileText size={18} className="text-[var(--caramel)]" />
                        <span className="font-medium">Logcat 日志</span>
                      </div>
                      <button
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                          logcatRunning
                            ? 'bg-[var(--terracotta)] text-white'
                            : 'bg-[var(--sage)] text-white'
                        }`}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleLogcat()
                        }}
                      >
                        {logcatRunning ? (
                          <span className="flex items-center gap-1"><Square size={14} /> 停止</span>
                        ) : (
                          <span className="flex items-center gap-1"><Play size={14} /> 开始</span>
                        )}
                      </button>
                    </div>
                    {expandLogcat && (
                      <div className="mt-2 bg-[var(--coffee-deep)] rounded-xl p-4 h-72 max-h-[50vh] overflow-auto font-mono text-xs text-[var(--sage)] leading-relaxed">
                        {logcat.length === 0 ? (
                          <div className="text-[var(--coffee-muted)]">
                            {logcatRunning ? '等待日志输出...' : '点击"开始"按钮抓取日志'}
                          </div>
                        ) : (
                          logcat.map((line, i) => (
                            <div key={i} className="whitespace-pre-wrap hover:bg-white/5 px-1 -mx-1 rounded">
                              {line}
                            </div>
                          ))
                        )}
                        <div ref={logcatEndRef} />
                      </div>
                    )}
                  </div>

                  {/* File Transfer Panel */}
                  <div>
                    <button
                      className="w-full flex items-center justify-between p-3 rounded-lg bg-[var(--cream-warm)]/50 hover:bg-[var(--cream-warm)] transition-colors"
                      onClick={() => setExpandTransfer(!expandTransfer)}
                    >
                      <div className="flex items-center gap-2">
                        {expandTransfer ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                        <FolderOpen size={18} className="text-[var(--caramel)]" />
                        <span className="font-medium">文件传输</span>
                      </div>
                    </button>
                    {expandTransfer && (
                      <div className="mt-2 p-4 bg-[var(--cream-warm)]/30 rounded-xl space-y-4">
                        {/* Push Section */}
                        <div>
                          <div className="flex items-center gap-2 mb-3">
                            <Upload size={16} className="text-[var(--caramel)]" />
                            <span className="text-sm font-medium text-[var(--coffee-deep)]">推送文件 (本地 → 设备)</span>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div className="relative">
                              <label className="block text-xs text-[var(--coffee-muted)] mb-1">本地路径 (文件或文件夹)</label>
                              <input
                                type="text"
                                value={pushLocalPath}
                                onChange={e => setPushLocalPath(e.target.value)}
                                placeholder="例: D:\project\assets"
                                className="font-mono text-sm"
                              />
                            </div>
                            <div className="relative">
                              <label className="block text-xs text-[var(--coffee-muted)] mb-1">设备目标路径</label>
                              <input
                                type="text"
                                value={pushRemotePath}
                                onChange={e => setPushRemotePath(e.target.value)}
                                onFocus={() => setShowPushHistory(true)}
                                onBlur={() => setTimeout(() => setShowPushHistory(false), 200)}
                                placeholder="/sdcard/"
                                className="font-mono text-sm"
                              />
                              {showPushHistory && pushHistory.length > 0 && (
                                <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-white rounded-lg shadow-lg border border-[var(--glass-border)] max-h-40 overflow-auto">
                                  {pushHistory.map((p, i) => (
                                    <button
                                      key={i}
                                      className="w-full text-left px-3 py-1.5 text-xs font-mono text-[var(--coffee-light)] hover:bg-[var(--cream-warm)] transition-colors truncate"
                                      onMouseDown={() => { setPushRemotePath(p); setShowPushHistory(false) }}
                                    >
                                      {p}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                          <button
                            className="btn-primary mt-3 flex items-center gap-2"
                            onClick={handlePush}
                            disabled={!pushLocalPath.trim() || operating}
                          >
                            <Upload size={14} />
                            {operating ? '推送中...' : '推送'}
                          </button>
                        </div>

                        <div className="border-t border-[var(--glass-border)]" />

                        {/* Pull Section */}
                        <div>
                          <div className="flex items-center gap-2 mb-3">
                            <Download size={16} className="text-[var(--sky)]" />
                            <span className="text-sm font-medium text-[var(--coffee-deep)]">拉取文件 (设备 → 本地)</span>
                          </div>
                          <div className="relative">
                            <label className="block text-xs text-[var(--coffee-muted)] mb-1">设备文件路径</label>
                            <input
                              type="text"
                              value={pullRemotePath}
                              onChange={e => setPullRemotePath(e.target.value)}
                              onFocus={() => setShowPullHistory(true)}
                              onBlur={() => setTimeout(() => setShowPullHistory(false), 200)}
                              placeholder="/sdcard/Download/file.txt"
                              className="font-mono text-sm"
                            />
                            {showPullHistory && pullHistory.length > 0 && (
                              <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-white rounded-lg shadow-lg border border-[var(--glass-border)] max-h-40 overflow-auto">
                                {pullHistory.map((p, i) => (
                                  <button
                                    key={i}
                                    className="w-full text-left px-3 py-1.5 text-xs font-mono text-[var(--coffee-light)] hover:bg-[var(--cream-warm)] transition-colors truncate"
                                    onMouseDown={() => { setPullRemotePath(p); setShowPullHistory(false) }}
                                  >
                                    {p}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="mt-2">
                            <label className="block text-xs text-[var(--coffee-muted)] mb-1">本地保存路径 (留空则浏览器下载)</label>
                            <input
                              type="text"
                              value={pullLocalPath}
                              onChange={e => setPullLocalPath(e.target.value)}
                              placeholder="例: D:\Downloads\file.txt"
                              className="font-mono text-sm"
                            />
                          </div>
                          <button
                            className="btn-secondary mt-3 flex items-center gap-2"
                            onClick={handlePull}
                            disabled={!pullRemotePath.trim() || operating}
                          >
                            <Download size={14} />
                            {operating ? '拉取中...' : '拉取'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="glass-card p-12 text-center animate-fade-in">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-xl bg-[var(--cream-warm)] flex items-center justify-center">
                    <Zap size={28} className="text-[var(--coffee-muted)]" />
                  </div>
                  <h3 className="font-display text-lg text-[var(--coffee-deep)] mb-2">选择设备</h3>
                  <p className="text-[var(--coffee-muted)]">从左侧列表选择一个设备开始操作</p>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Install APK Modal */}
      {showInstallModal && (
        <div className="modal-overlay" onClick={() => setShowInstallModal(false)}>
          <div
            className="glass-card p-6 w-[450px] animate-fade-in"
            style={{ animation: 'slideUp 0.3s ease' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-[var(--caramel)] to-[var(--caramel-dark)] flex items-center justify-center">
                  <Package size={20} className="text-white" />
                </div>
                <h3 className="font-display text-lg font-semibold">安装 APK</h3>
              </div>
              <button
                onClick={() => setShowInstallModal(false)}
                className="p-2 rounded-lg hover:bg-[var(--cream-warm)] transition-colors text-[var(--coffee-muted)]"
              >
                <X size={20} />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-[var(--coffee-light)] mb-2">选择 APK 文件</label>
                <input
                  type="file"
                  accept=".apk"
                  id="apk-file-input"
                  className="hidden"
                  onChange={e => setInstallFile(e.target.files?.[0] || null)}
                />
                <button
                  className="btn-secondary w-full flex items-center justify-center gap-2 py-2.5"
                  onClick={() => document.getElementById('apk-file-input').click()}
                >
                  <Package size={16} />
                  {installFile ? installFile.name : '点击选择 APK 文件'}
                </button>
                {installFile && (
                  <div className="mt-2 p-3 bg-[var(--cream-warm)] rounded-lg">
                    <div className="text-sm font-medium text-[var(--coffee-deep)]">{installFile.name}</div>
                    <div className="text-xs text-[var(--coffee-muted)]">
                      {(installFile.size / 1024 / 1024).toFixed(2)} MB
                    </div>
                  </div>
                )}
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  className="btn-secondary flex-1"
                  onClick={() => setShowInstallModal(false)}
                >
                  取消
                </button>
                <button
                  className="btn-primary flex-1 flex items-center justify-center gap-2"
                  onClick={handleInstall}
                  disabled={!installFile || operating}
                >
                  {operating ? (
                    <>
                      <div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                      安装中...
                    </>
                  ) : (
                    <>
                      <Package size={16} />
                      安装
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default AdbMaster
