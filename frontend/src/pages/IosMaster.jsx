import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, RefreshCw, Smartphone, Usb, FileText, Upload, Download,
  X, Package, ChevronDown, ChevronRight, FolderOpen,
  Edit, Check, Search, Camera, Trash2, Info, HardDrive
} from 'lucide-react'
import { useToast } from '../components/Toast'

function IosMaster() {
  const navigate = useNavigate()
  const toast = useToast()
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedDevice, setSelectedDevice] = useState(null)
  const [syslog, setSyslog] = useState([])
  const [syslogRunning, setSyslogRunning] = useState(false)
  const wsRef = useRef(null)
  const syslogEndRef = useRef(null)
  const syslogContainerRef = useRef(null)

  // 展开面板状态
  const [expandInfo, setExpandInfo] = useState(true)
  const [expandSyslog, setExpandSyslog] = useState(false)
  const [expandTransfer, setExpandTransfer] = useState(false)
  const [expandApps, setExpandApps] = useState(false)
  const [expandScreenshot, setExpandScreenshot] = useState(false)

  // 设备信息
  const [deviceInfo, setDeviceInfo] = useState(null)

  // 昵称编辑
  const [editingNickname, setEditingNickname] = useState(false)
  const [nicknameInput, setNicknameInput] = useState('')

  // 应用列表
  const [apps, setApps] = useState([])
  const [appsLoading, setAppsLoading] = useState(false)
  const [appSearch, setAppSearch] = useState('')
  const [showSystemApps, setShowSystemApps] = useState(false)

  // 文件传输
  const [transferMode, setTransferMode] = useState('media') // 'media' | 'app'
  const [pushLocalPath, setPushLocalPath] = useState(() => localStorage.getItem('ios_pushLocalPath') || '')
  const [pushRemotePath, setPushRemotePath] = useState(() => localStorage.getItem('ios_pushRemotePath') || '/Downloads/')
  const [pullRemotePath, setPullRemotePath] = useState(() => localStorage.getItem('ios_pullRemotePath') || '')
  const [pullLocalPath, setPullLocalPath] = useState(() => localStorage.getItem('ios_pullLocalPath') || '')
  const [pushHistory, setPushHistory] = useState([])
  const [pullHistory, setPullHistory] = useState([])
  const [showPushHistory, setShowPushHistory] = useState(false)
  const [showPullHistory, setShowPullHistory] = useState(false)
  const [operating, setOperating] = useState(false)

  // 远程模式
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  const [pushUploadFile, setPushUploadFile] = useState(null)
  const [pushUploadRemotePath, setPushUploadRemotePath] = useState('/Downloads/')
  const [pushUploadProgress, setPushUploadProgress] = useState(null)
  const pushUploadInputRef = useRef(null)
  const [pullDownloadRemotePath, setPullDownloadRemotePath] = useState('')
  const [pullDownloadResult, setPullDownloadResult] = useState(null)
  const pullDownloadUrlRef = useRef(null)

  // App 沙盒模式
  const [selectedBundleId, setSelectedBundleId] = useState('')
  const [appPushLocalPath, setAppPushLocalPath] = useState('')
  const [appPushRemotePath, setAppPushRemotePath] = useState('/Documents/')
  const [appPullRemotePath, setAppPullRemotePath] = useState('')
  const [appPullLocalPath, setAppPullLocalPath] = useState('')

  // 截图
  const [screenshotUrl, setScreenshotUrl] = useState(null)
  const [screenshotLoading, setScreenshotLoading] = useState(false)

  // IPA 安装
  const [showInstallModal, setShowInstallModal] = useState(false)
  const [installFile, setInstallFile] = useState(null)
  const [installProgress, setInstallProgress] = useState(null)

  // AFC 目录浏览
  const [afcEntries, setAfcEntries] = useState([])
  const [afcPath, setAfcPath] = useState('/')
  const [afcLoading, setAfcLoading] = useState(false)

  // ── Fetch Devices ──
  const fetchDevices = async () => {
    try {
      const res = await fetch('/api/ios_master/devices')
      if (res.ok) {
        const data = await res.json()
        setDevices(data.devices || [])
        if (selectedDevice) {
          const updated = (data.devices || []).find(d => d.udid === selectedDevice.udid)
          if (updated) setSelectedDevice(updated)
        }
      }
    } catch (err) {
      console.error('设备列表获取失败:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchDevices()
    const interval = setInterval(fetchDevices, 3000)
    return () => clearInterval(interval)
  }, [])

  // ── Fetch Path History ──
  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const [pushRes, pullRes] = await Promise.all([
          fetch('/api/ios_master/path-history/push'),
          fetch('/api/ios_master/path-history/pull'),
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
    fetchHistory()
  }, [])

  // ── Syslog Auto-scroll ──
  useEffect(() => {
    if (syslogEndRef.current && syslogContainerRef.current) {
      const container = syslogContainerRef.current
      const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100
      if (isNearBottom) syslogEndRef.current.scrollIntoView({ behavior: 'auto' })
    }
  }, [syslog])

  // cleanup
  useEffect(() => {
    return () => {
      if (wsRef.current) { try { wsRef.current.close() } catch {} }
      if (pullDownloadUrlRef.current) URL.revokeObjectURL(pullDownloadUrlRef.current)
    }
  }, [])

  // ── Device Selection ──
  const handleSelectDevice = async (device) => {
    setSelectedDevice(device)
    setDeviceInfo(null)
    setSyslog([])
    setSyslogRunning(false)
    setApps([])
    setAfcEntries([])
    if (wsRef.current) { try { wsRef.current.close() } catch {} }

    // Fetch device info
    try {
      const res = await fetch(`/api/ios_master/devices/${device.udid}/info`)
      if (res.ok) {
        const data = await res.json()
        setDeviceInfo(data)
      }
    } catch {}
  }

  // ── Nickname ──
  const handleSaveNickname = async () => {
    if (!selectedDevice) return
    try {
      const res = await fetch(`/api/ios_master/devices/${selectedDevice.udid}/nickname`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: nicknameInput }),
      })
      if (res.ok) {
        toast.success('昵称已更新')
        setEditingNickname(false)
        fetchDevices()
      }
    } catch (err) {
      toast.error('更新失败: ' + err.message)
    }
  }

  // ── Syslog ──
  const startSyslog = () => {
    if (!selectedDevice || syslogRunning) return
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/ios_master/devices/${selectedDevice.udid}/syslog`)
    wsRef.current = ws
    ws.onopen = () => {
      setSyslogRunning(true)
      toast.success('Syslog 已连接')
    }
    ws.onmessage = (e) => {
      setSyslog(prev => {
        const next = [...prev, e.data]
        return next.length > 5000 ? next.slice(-3000) : next
      })
    }
    ws.onerror = () => toast.error('Syslog 连接失败')
    ws.onclose = () => setSyslogRunning(false)
  }

  const stopSyslog = () => {
    if (wsRef.current) {
      try { wsRef.current.send('stop') } catch {}
      try { wsRef.current.close() } catch {}
    }
    setSyslogRunning(false)
  }

  // ── Apps ──
  const fetchApps = async () => {
    if (!selectedDevice) return
    setAppsLoading(true)
    try {
      const appType = showSystemApps ? 'Any' : 'User'
      const res = await fetch(`/api/ios_master/devices/${selectedDevice.udid}/apps?app_type=${appType}`)
      if (res.ok) {
        const data = await res.json()
        setApps(data.apps || [])
      }
    } catch (err) {
      toast.error('获取应用列表失败')
    } finally {
      setAppsLoading(false)
    }
  }

  const handleUninstall = async (bundleId) => {
    if (!selectedDevice || !confirm(`确认卸载 ${bundleId}？`)) return
    try {
      const res = await fetch(`/api/ios_master/devices/${selectedDevice.udid}/apps/uninstall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundle_id: bundleId }),
      })
      if (res.ok) {
        toast.success(`已卸载 ${bundleId}`)
        fetchApps()
      } else {
        const data = await res.json()
        toast.error(data.detail || '卸载失败')
      }
    } catch (err) {
      toast.error('卸载失败: ' + err.message)
    }
  }

  // ── File Transfer (Media) ──
  const handlePush = async () => {
    if (!pushLocalPath.trim() || !selectedDevice) return
    setOperating(true)
    try {
      const res = await fetch(`/api/ios_master/devices/${selectedDevice.udid}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ local_path: pushLocalPath, remote_path: pushRemotePath }),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(data.message)
        localStorage.setItem('ios_pushLocalPath', pushLocalPath)
        localStorage.setItem('ios_pushRemotePath', pushRemotePath)
      } else {
        toast.error(data.detail || '推送失败')
        localStorage.setItem('ios_pushLocalPath', pushLocalPath)
        localStorage.setItem('ios_pushRemotePath', pushRemotePath)
      }
    } catch (err) { toast.error('推送失败: ' + err.message) }
    finally { setOperating(false) }
  }

  const handlePull = async () => {
    if (!pullRemotePath.trim() || !selectedDevice) return
    setOperating(true)
    try {
      const res = await fetch(`/api/ios_master/devices/${selectedDevice.udid}/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: pullRemotePath, local_path: pullLocalPath || '' }),
      })
      if (res.ok) {
        const contentType = res.headers.get('content-type')
        if (contentType?.includes('application/json')) {
          const data = await res.json()
          toast.success(data.message)
        } else {
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url; a.download = pullRemotePath.split('/').pop() || 'file'
          a.click(); URL.revokeObjectURL(url)
          toast.success('文件已下载')
        }
        localStorage.setItem('ios_pullRemotePath', pullRemotePath)
        if (pullLocalPath) localStorage.setItem('ios_pullLocalPath', pullLocalPath)
      } else {
        const data = await res.json()
        toast.error(data.detail || '拉取失败')
      }
    } catch (err) { toast.error('拉取失败: ' + err.message) }
    finally { setOperating(false) }
  }

  const handlePushUpload = async () => {
    if (!pushUploadFile || !selectedDevice) return
    setOperating(true)
    const formData = new FormData()
    formData.append('file', pushUploadFile)
    try {
      const xhr = new XMLHttpRequest()
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          setPushUploadProgress({ stage: 'uploading', percent: Math.round(e.loaded / e.total * 100) })
        }
      }
      xhr.onload = () => {
        setPushUploadProgress(null)
        setOperating(false)
        if (xhr.status === 200) {
          toast.success('推送成功')
          setPushUploadFile(null)
          if (pushUploadInputRef.current) pushUploadInputRef.current.value = ''
        } else {
          try { toast.error(JSON.parse(xhr.responseText).detail || '推送失败') } catch { toast.error('推送失败') }
        }
      }
      xhr.onerror = () => { setPushUploadProgress(null); setOperating(false); toast.error('上传失败') }
      xhr.open('POST', `/api/ios_master/devices/${selectedDevice.udid}/push-upload?remote_path=${encodeURIComponent(pushUploadRemotePath)}`)
      xhr.send(formData)
      setPushUploadProgress({ stage: 'pushing', percent: 0 })
    } catch (err) { setPushUploadProgress(null); setOperating(false); toast.error('推送失败: ' + err.message) }
  }

  const handlePullDownload = async () => {
    const remotePath = pullDownloadRemotePath
    if (!remotePath.trim() || !selectedDevice) return
    setOperating(true)
    setPullDownloadResult({ pulling: true })
    try {
      const res = await fetch(`/api/ios_master/devices/${selectedDevice.udid}/pull-download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: remotePath }),
      })
      if (res.ok) {
        const blob = await res.blob()
        if (pullDownloadUrlRef.current) URL.revokeObjectURL(pullDownloadUrlRef.current)
        const downloadUrl = URL.createObjectURL(blob)
        pullDownloadUrlRef.current = downloadUrl
        let filename = remotePath.split('/').pop() || 'file'
        if (blob.type === 'application/zip' && !filename.endsWith('.zip')) filename += '.zip'
        setPullDownloadResult({ ready: true, filename, downloadUrl })
        toast.success('文件已就绪')
      } else {
        const data = await res.json()
        setPullDownloadResult(null)
        toast.error(data.detail || '拉取失败')
      }
    } catch (err) { setPullDownloadResult(null); toast.error('拉取失败: ' + err.message) }
    finally { setOperating(false) }
  }

  // ── App Sandbox Transfer ──
  const handleAppPush = async () => {
    if (!appPushLocalPath.trim() || !selectedBundleId || !selectedDevice) return
    setOperating(true)
    try {
      const res = await fetch(`/api/ios_master/devices/${selectedDevice.udid}/app-push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundle_id: selectedBundleId, local_path: appPushLocalPath, remote_path: appPushRemotePath }),
      })
      const data = await res.json()
      if (res.ok) toast.success(data.message)
      else toast.error(data.detail || '推送失败')
    } catch (err) { toast.error('推送失败: ' + err.message) }
    finally { setOperating(false) }
  }

  const handleAppPull = async () => {
    if (!appPullRemotePath.trim() || !selectedBundleId || !selectedDevice) return
    setOperating(true)
    try {
      const res = await fetch(`/api/ios_master/devices/${selectedDevice.udid}/app-pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundle_id: selectedBundleId, path: appPullRemotePath, local_path: appPullLocalPath || '' }),
      })
      if (res.ok) {
        const contentType = res.headers.get('content-type')
        if (contentType?.includes('application/json')) {
          const data = await res.json()
          toast.success(data.message)
        } else {
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a'); a.href = url; a.download = appPullRemotePath.split('/').pop() || 'file'
          a.click(); URL.revokeObjectURL(url)
          toast.success('文件已下载')
        }
      } else {
        const data = await res.json()
        toast.error(data.detail || '拉取失败')
      }
    } catch (err) { toast.error('拉取失败: ' + err.message) }
    finally { setOperating(false) }
  }

  // ── Screenshot ──
  const handleScreenshot = async () => {
    if (!selectedDevice) return
    setScreenshotLoading(true)
    try {
      const res = await fetch(`/api/ios_master/devices/${selectedDevice.udid}/screenshot`, { method: 'POST' })
      if (res.ok) {
        const blob = await res.blob()
        if (screenshotUrl) URL.revokeObjectURL(screenshotUrl)
        setScreenshotUrl(URL.createObjectURL(blob))
        toast.success('截图成功')
      } else {
        const data = await res.json()
        toast.error(data.detail || '截图失败')
      }
    } catch (err) { toast.error('截图失败: ' + err.message) }
    finally { setScreenshotLoading(false) }
  }

  // ── IPA Install ──
  const handleInstallIpa = async () => {
    if (!installFile || !selectedDevice) return
    setInstallProgress('installing')
    const formData = new FormData()
    formData.append('file', installFile)
    try {
      const res = await fetch(`/api/ios_master/devices/${selectedDevice.udid}/install`, {
        method: 'POST',
        body: formData,
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(data.message)
        setShowInstallModal(false)
        setInstallFile(null)
      } else {
        toast.error(data.detail || '安装失败')
      }
    } catch (err) { toast.error('安装失败: ' + err.message) }
    finally { setInstallProgress(null) }
  }

  // ── AFC Browse ──
  const browseAfc = async (path = '/') => {
    if (!selectedDevice) return
    setAfcLoading(true)
    try {
      const res = await fetch(`/api/ios_master/devices/${selectedDevice.udid}/afc/ls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      if (res.ok) {
        const data = await res.json()
        setAfcEntries(data.entries || [])
        setAfcPath(path)
      }
    } catch {}
    finally { setAfcLoading(false) }
  }

  // ── Helpers ──
  const formatBytes = (bytes) => {
    if (!bytes || bytes <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i]
  }

  const filteredApps = apps.filter(a =>
    !a.error &&
    (a.name?.toLowerCase().includes(appSearch.toLowerCase()) ||
     a.bundle_id?.toLowerCase().includes(appSearch.toLowerCase()))
  )

  const mediaPresets = ['/Downloads/', '/DCIM/', '/Books/', '/Recordings/', '/iTunes_Control/']

  // ── Render ──
  return (
    <div className="min-h-screen bg-gradient-to-b from-[var(--latte)] to-[var(--cream)]">
      <header className="bg-white/70 backdrop-blur-xl border-b border-[var(--glass-border)] px-6 py-4 flex items-center justify-between sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <button className="btn-secondary p-2" onClick={() => navigate('/')}>
            <ArrowLeft size={18} />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
              <Smartphone size={16} className="text-white" />
            </div>
            <h1 className="font-display text-xl font-bold text-[var(--coffee-deep)]">iOS Master</h1>
          </div>
        </div>
        <button className="btn-secondary flex items-center gap-2" onClick={fetchDevices}>
          <RefreshCw size={16} />
          刷新
        </button>
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
            <h3 className="font-display text-xl text-[var(--coffee-deep)] mb-2">未发现 iOS 设备</h3>
            <p className="text-[var(--coffee-muted)] max-w-md mx-auto">
              请通过 USB 连接 iPhone/iPad，并在设备上点击"信任此电脑"
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            {/* Device List */}
            <div className="xl:col-span-1">
              <div className="glass-card p-5 animate-fade-in">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
                      <Smartphone size={16} className="text-white" />
                    </div>
                    <h2 className="font-display text-lg font-semibold text-[var(--coffee-deep)]">
                      设备发现
                    </h2>
                  </div>
                </div>
                <div className="space-y-2">
                  {devices.map(device => {
                    const isSelected = selectedDevice?.udid === device.udid
                    return (
                      <div
                        key={device.udid}
                        className={`p-4 rounded-xl cursor-pointer transition-all border-l-4 ${
                          isSelected
                            ? 'bg-gradient-to-r from-blue-500/10 to-transparent border-blue-500'
                            : 'bg-[var(--cream-warm)]/50 border-transparent hover:border-blue-300 hover:bg-[var(--cream-warm)]'
                        }`}
                        onClick={() => handleSelectDevice(device)}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-[var(--coffee-deep)] truncate">
                                {device.nickname || device.name || device.product_type || device.udid.slice(0, 12)}
                              </span>
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--sage-soft)]/30 text-[var(--sage)]">
                                <Usb size={10} /> USB
                              </span>
                            </div>
                            <div className="text-xs text-[var(--coffee-muted)] mt-1 font-mono truncate">
                              {device.udid.slice(0, 20)}...
                            </div>
                            {device.ios_version && (
                              <div className="text-xs text-blue-500 mt-0.5">
                                iOS {device.ios_version}
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
                      <span className="text-lg text-blue-500"><Usb size={20} /></span>
                      <div>
                        {editingNickname ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={nicknameInput}
                              onChange={e => setNicknameInput(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') handleSaveNickname(); if (e.key === 'Escape') setEditingNickname(false) }}
                              className="font-display text-lg font-semibold px-2 py-0.5 rounded-lg border border-blue-400 bg-white w-48"
                              autoFocus
                            />
                            <button className="p-1 rounded-lg hover:bg-[var(--success-soft)] text-[var(--sage)] transition-colors" onClick={handleSaveNickname}><Check size={16} /></button>
                            <button className="p-1 rounded-lg hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] transition-colors" onClick={() => setEditingNickname(false)}><X size={16} /></button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 group/name">
                            <h3 className="font-display text-lg font-semibold text-[var(--coffee-deep)]">
                              {selectedDevice.nickname || selectedDevice.name || selectedDevice.product_type || '设备控制'}
                            </h3>
                            <button
                              className="p-1 rounded-lg hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] opacity-0 group-hover/name:opacity-100 transition-all"
                              onClick={() => { setNicknameInput(selectedDevice.nickname || selectedDevice.name || ''); setEditingNickname(true) }}
                              title="编辑昵称"
                            ><Edit size={14} /></button>
                          </div>
                        )}
                        <p className="text-xs text-[var(--coffee-muted)] font-mono">{selectedDevice.udid}</p>
                      </div>
                    </div>
                    <button className="btn-primary flex items-center gap-2" onClick={() => setShowInstallModal(true)}>
                      <Package size={16} />
                      安装 IPA
                    </button>
                  </div>

                  {/* Panels */}
                  <div className="space-y-3">

                    {/* ── Device Info Panel ── */}
                    <button className="w-full flex items-center justify-between p-3 rounded-lg bg-[var(--cream-warm)]/50 hover:bg-[var(--cream-warm)] transition-colors" onClick={() => setExpandInfo(!expandInfo)}>
                      <div className="flex items-center gap-2">
                        {expandInfo ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                        <Info size={18} className="text-blue-500" />
                        <span className="font-medium">设备信息</span>
                      </div>
                    </button>
                    {expandInfo && deviceInfo && (
                      <div className="p-4 bg-[var(--cream-warm)]/30 rounded-xl">
                        <div className="grid grid-cols-2 gap-3 text-sm">
                          {[
                            ['设备名称', deviceInfo.DeviceName],
                            ['型号', deviceInfo.ProductType],
                            ['iOS 版本', `${deviceInfo.ProductVersion} (${deviceInfo.BuildVersion})`],
                            ['序列号', deviceInfo.SerialNumber],
                            ['WiFi MAC', deviceInfo.WiFiAddress],
                            ['设备类型', deviceInfo.DeviceClass],
                            ['存储空间', deviceInfo.TotalDiskCapacity ? `${formatBytes(deviceInfo.TotalDiskCapacity)}（可用 ${formatBytes(deviceInfo.TotalDataAvailable)}）` : '-'],
                            ['电池', deviceInfo.BatteryCurrentCapacity >= 0 ? `${deviceInfo.BatteryCurrentCapacity}%${deviceInfo.BatteryIsCharging ? ' · 充电中' : ''}` : '-'],
                            ['CPU 架构', deviceInfo.CPUArchitecture],
                            ['硬件型号', deviceInfo.HardwareModel],
                          ].map(([label, value]) => (
                            <div key={label} className="flex gap-2">
                              <span className="text-[var(--coffee-muted)] shrink-0 w-20">{label}</span>
                              <span className="text-[var(--coffee-deep)] font-mono text-xs break-all">{value || '-'}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ── Syslog Panel ── */}
                    <button className="w-full flex items-center justify-between p-3 rounded-lg bg-[var(--cream-warm)]/50 hover:bg-[var(--cream-warm)] transition-colors" onClick={() => setExpandSyslog(!expandSyslog)}>
                      <div className="flex items-center gap-2">
                        {expandSyslog ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                        <FileText size={18} className="text-[var(--caramel)]" />
                        <span className="font-medium">Syslog 日志</span>
                      </div>
                      {syslogRunning && (
                        <span className="px-3 py-1.5 rounded-lg text-sm font-medium bg-[var(--sage)]/15 text-[var(--sage)] flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-[var(--sage)] animate-pulse" />
                          运行中
                        </span>
                      )}
                    </button>
                    {expandSyslog && (
                      <div className="p-4 bg-[var(--cream-warm)]/30 rounded-xl space-y-3">
                        <div className="flex gap-2">
                          {!syslogRunning ? (
                            <button className="btn-primary flex items-center gap-2 text-sm" onClick={startSyslog}>
                              <FileText size={14} /> 启动 Syslog
                            </button>
                          ) : (
                            <button className="btn-secondary flex items-center gap-2 text-sm" onClick={stopSyslog}>
                              <X size={14} /> 停止
                            </button>
                          )}
                          {syslog.length > 0 && (
                            <button className="btn-secondary text-sm" onClick={() => setSyslog([])}>清空</button>
                          )}
                        </div>
                        <div ref={syslogContainerRef} className="bg-[var(--coffee-deep)] text-green-300 font-mono text-xs rounded-xl p-4 h-80 overflow-auto">
                          {syslog.length === 0 ? (
                            <div className="text-[var(--coffee-muted)] text-center py-8">
                              {syslogRunning ? '等待日志...' : '点击启动按钮开始监听系统日志'}
                            </div>
                          ) : (
                            syslog.map((line, i) => <div key={i} className="leading-5 hover:bg-white/5">{line}</div>)
                          )}
                          <div ref={syslogEndRef} />
                        </div>
                      </div>
                    )}

                    {/* ── File Transfer Panel ── */}
                    <button className="w-full flex items-center justify-between p-3 rounded-lg bg-[var(--cream-warm)]/50 hover:bg-[var(--cream-warm)] transition-colors" onClick={() => setExpandTransfer(!expandTransfer)}>
                      <div className="flex items-center gap-2">
                        {expandTransfer ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                        <FolderOpen size={18} className="text-[var(--caramel)]" />
                        <span className="font-medium">文件传输</span>
                      </div>
                    </button>
                    {expandTransfer && (
                      <div className="p-4 bg-[var(--cream-warm)]/30 rounded-xl space-y-4">
                        {/* Mode Switch */}
                        <div className="flex gap-2 p-1 bg-[var(--cream-warm)] rounded-lg w-fit">
                          <button
                            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${transferMode === 'media' ? 'bg-white shadow-sm text-[var(--coffee-deep)]' : 'text-[var(--coffee-muted)]'}`}
                            onClick={() => setTransferMode('media')}
                          >
                            <HardDrive size={14} className="inline mr-1.5" />Media 目录
                          </button>
                          <button
                            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${transferMode === 'app' ? 'bg-white shadow-sm text-[var(--coffee-deep)]' : 'text-[var(--coffee-muted)]'}`}
                            onClick={() => { setTransferMode('app'); if (apps.length === 0 && selectedDevice) fetchApps() }}
                          >
                            <Package size={14} className="inline mr-1.5" />App 沙盒
                          </button>
                        </div>

                        {transferMode === 'media' ? (
                          <>
                            {/* Push Section */}
                            <div>
                              <div className="flex items-center gap-2 mb-3">
                                <Upload size={16} className="text-[var(--caramel)]" />
                                <span className="text-sm font-medium text-[var(--coffee-deep)]">推送文件 (本地 → 设备 Media)</span>
                              </div>
                              {isLocalhost ? (
                                <div className="space-y-2.5">
                                  <div>
                                    <label className="block text-xs text-[var(--coffee-muted)] mb-1">部署机路径</label>
                                    <div className="flex gap-2">
                                      <input type="text" value={pushLocalPath} onChange={e => setPushLocalPath(e.target.value)} placeholder="例: D:\project\assets" className="font-mono text-sm flex-1" />
                                      <button className="btn-secondary p-2 shrink-0" onClick={async () => {
                                        if (!pushLocalPath.trim()) return
                                        try { const res = await fetch('/api/ios_master/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: pushLocalPath }) }); if (!res.ok) { const d = await res.json(); toast.error(d.detail || '打开失败') } } catch (err) { toast.error('打开失败') }
                                      }} title="在文件管理器中打开"><FolderOpen size={16} /></button>
                                    </div>
                                  </div>
                                  <div className="relative">
                                    <label className="block text-xs text-[var(--coffee-muted)] mb-1">设备目标路径 (Media 下)</label>
                                    <input type="text" value={pushRemotePath} onChange={e => setPushRemotePath(e.target.value)} onFocus={() => setShowPushHistory(true)} onBlur={() => setTimeout(() => setShowPushHistory(false), 200)} placeholder="/Downloads/" className="font-mono text-sm" />
                                    {showPushHistory && (
                                      <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-white rounded-lg shadow-lg border border-[var(--glass-border)] max-h-40 overflow-auto">
                                        {mediaPresets.map((p, i) => (
                                          <button key={'p'+i} className="w-full text-left px-3 py-1.5 text-xs font-mono text-blue-500 hover:bg-[var(--cream-warm)] transition-colors" onMouseDown={() => { setPushRemotePath(p); setShowPushHistory(false) }}>{p} (预设)</button>
                                        ))}
                                        {pushHistory.filter(h => !mediaPresets.includes(h)).map((p, i) => (
                                          <button key={i} className="w-full text-left px-3 py-1.5 text-xs font-mono text-[var(--coffee-light)] hover:bg-[var(--cream-warm)] transition-colors truncate" onMouseDown={() => { setPushRemotePath(p); setShowPushHistory(false) }}>{p}</button>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                  <button className="btn-primary flex items-center gap-2" onClick={handlePush} disabled={!pushLocalPath.trim() || operating}><Upload size={14} />{operating ? '推送中...' : '推送'}</button>
                                </div>
                              ) : (
                                <div className="space-y-2.5">
                                  <div>
                                    <label className="block text-xs text-[var(--coffee-muted)] mb-1">选择文件并推送到设备</label>
                                    <input ref={pushUploadInputRef} type="file" className="hidden" onChange={e => setPushUploadFile(e.target.files?.[0] || null)} />
                                    <button className="btn-secondary w-full flex items-center justify-center gap-2 py-2.5" onClick={() => pushUploadInputRef.current?.click()}>
                                      <Upload size={16} />{pushUploadFile ? pushUploadFile.name : '点击选择文件（文件夹请压缩为 zip）'}
                                    </button>
                                    {pushUploadFile && (
                                      <div className="mt-2 p-3 bg-[var(--cream-warm)] rounded-lg">
                                        <div className="text-sm font-medium text-[var(--coffee-deep)]">{pushUploadFile.name}</div>
                                        <div className="text-xs text-[var(--coffee-muted)]">{formatBytes(pushUploadFile.size)}{pushUploadFile.name.toLowerCase().endsWith('.zip') && ' (zip 将自动解压后推送)'}</div>
                                      </div>
                                    )}
                                  </div>
                                  <div className="relative">
                                    <label className="block text-xs text-[var(--coffee-muted)] mb-1">设备目标路径 (Media 下)</label>
                                    <input type="text" value={pushUploadRemotePath} onChange={e => setPushUploadRemotePath(e.target.value)} placeholder="/Downloads/" className="font-mono text-sm" />
                                  </div>
                                  {pushUploadProgress && (
                                    <div className="p-3 bg-[var(--cream-warm)] rounded-lg space-y-2">
                                      <div className="flex items-center gap-2 text-sm text-[var(--coffee-deep)]">
                                        <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                                        {pushUploadProgress.stage === 'uploading' ? `上传中... ${pushUploadProgress.percent}%` : '推送中...'}
                                      </div>
                                      <div className="w-full h-2 bg-white rounded-full overflow-hidden">
                                        <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${pushUploadProgress.stage === 'uploading' ? pushUploadProgress.percent : 100}%` }} />
                                      </div>
                                    </div>
                                  )}
                                  <button className="btn-primary flex items-center gap-2" onClick={handlePushUpload} disabled={!pushUploadFile || operating}>
                                    <Upload size={14} />{operating ? '推送中...' : '推送'}
                                  </button>
                                </div>
                              )}
                            </div>

                            <div className="border-t border-[var(--glass-border)]" />

                            {/* Pull Section */}
                            <div>
                              <div className="flex items-center gap-2 mb-3">
                                <Download size={16} className="text-[var(--sky)]" />
                                <span className="text-sm font-medium text-[var(--coffee-deep)]">拉取文件 (设备 Media → 本地)</span>
                              </div>
                              {isLocalhost ? (
                                <div className="space-y-2.5">
                                  <div className="relative">
                                    <label className="block text-xs text-[var(--coffee-muted)] mb-1">设备文件路径 (Media 下)</label>
                                    <input type="text" value={pullRemotePath} onChange={e => setPullRemotePath(e.target.value)} onFocus={() => setShowPullHistory(true)} onBlur={() => setTimeout(() => setShowPullHistory(false), 200)} placeholder="/DCIM/100APPLE/IMG_001.JPG" className="font-mono text-sm" />
                                    {showPullHistory && pullHistory.length > 0 && (
                                      <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-white rounded-lg shadow-lg border border-[var(--glass-border)] max-h-40 overflow-auto">
                                        {pullHistory.map((p, i) => (
                                          <button key={i} className="w-full text-left px-3 py-1.5 text-xs font-mono text-[var(--coffee-light)] hover:bg-[var(--cream-warm)] transition-colors truncate" onMouseDown={() => { setPullRemotePath(p); setShowPullHistory(false) }}>{p}</button>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                  <div>
                                    <label className="block text-xs text-[var(--coffee-muted)] mb-1">本地保存路径 (空则保存到设备同步目录)</label>
                                    <input type="text" value={pullLocalPath} onChange={e => setPullLocalPath(e.target.value)} placeholder="留空使用默认路径" className="font-mono text-sm" />
                                  </div>
                                  <button className="btn-primary flex items-center gap-2" onClick={handlePull} disabled={!pullRemotePath.trim() || operating}>
                                    <Download size={14} />{operating ? '拉取中...' : '拉取'}
                                  </button>
                                </div>
                              ) : (
                                <div className="space-y-2.5">
                                  <div className="relative">
                                    <label className="block text-xs text-[var(--coffee-muted)] mb-1">设备文件路径 (Media 下)</label>
                                    <input type="text" value={pullDownloadRemotePath} onChange={e => setPullDownloadRemotePath(e.target.value)} placeholder="/DCIM/100APPLE/IMG_001.JPG" className="font-mono text-sm" />
                                  </div>
                                  {pullDownloadResult?.pulling && (
                                    <div className="flex items-center gap-2 text-sm text-[var(--coffee-muted)]">
                                      <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> 拉取中...
                                    </div>
                                  )}
                                  <button className="btn-primary flex items-center gap-2" onClick={handlePullDownload} disabled={!pullDownloadRemotePath.trim() || operating}>
                                    <Download size={14} />{operating && pullDownloadResult?.pulling ? '拉取中...' : '拉取并下载'}
                                  </button>
                                  {pullDownloadResult?.ready && (
                                    <div className="p-3 bg-[var(--cream-warm)] rounded-lg">
                                      <div className="text-sm text-[var(--coffee-deep)]">已拉取: {pullDownloadResult.filename}</div>
                                      <button className="btn-primary mt-2 text-sm" onClick={() => {
                                        const a = document.createElement('a'); a.href = pullDownloadResult.downloadUrl; a.download = pullDownloadResult.filename; a.click()
                                      }}><Download size={14} className="inline mr-1" /> 下载</button>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </>
                        ) : (
                          /* App Sandbox Mode */
                          <div className="space-y-3">
                            <div>
                              <label className="block text-xs text-[var(--coffee-muted)] mb-1">选择应用</label>
                              <select className="w-full text-sm font-mono" value={selectedBundleId} onChange={e => setSelectedBundleId(e.target.value)}>
                                <option value="">-- 选择 App --</option>
                                {apps.filter(a => !a.error && !a.is_system).map(a => (
                                  <option key={a.bundle_id} value={a.bundle_id}>{a.name} ({a.bundle_id})</option>
                                ))}
                              </select>
                              <p className="text-xs text-[var(--coffee-muted)] mt-1">仅开启了文件共享的 App 可被访问</p>
                            </div>
                            {selectedBundleId && (
                              <>
                                <div className="border-t border-[var(--glass-border)]" />
                                <div>
                                  <div className="flex items-center gap-2 mb-2">
                                    <Upload size={14} className="text-[var(--caramel)]" />
                                    <span className="text-sm font-medium">推送到 App 沙盒</span>
                                  </div>
                                  <div className="space-y-2">
                                    <input type="text" value={appPushLocalPath} onChange={e => setAppPushLocalPath(e.target.value)} placeholder="本地路径" className="font-mono text-sm" />
                                    <input type="text" value={appPushRemotePath} onChange={e => setAppPushRemotePath(e.target.value)} placeholder="/Documents/" className="font-mono text-sm" />
                                    <button className="btn-primary flex items-center gap-2 text-sm" onClick={handleAppPush} disabled={!appPushLocalPath.trim() || operating}><Upload size={14} />推送</button>
                                  </div>
                                </div>
                                <div className="border-t border-[var(--glass-border)]" />
                                <div>
                                  <div className="flex items-center gap-2 mb-2">
                                    <Download size={14} className="text-[var(--sky)]" />
                                    <span className="text-sm font-medium">从 App 沙盒拉取</span>
                                  </div>
                                  <div className="space-y-2">
                                    <input type="text" value={appPullRemotePath} onChange={e => setAppPullRemotePath(e.target.value)} placeholder="/Documents/log" className="font-mono text-sm" />
                                    <input type="text" value={appPullLocalPath} onChange={e => setAppPullLocalPath(e.target.value)} placeholder="本地保存路径 (留空默认)" className="font-mono text-sm" />
                                    <button className="btn-primary flex items-center gap-2 text-sm" onClick={handleAppPull} disabled={!appPullRemotePath.trim() || operating}><Download size={14} />拉取</button>
                                  </div>
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* ── Apps Panel ── */}
                    <button className="w-full flex items-center justify-between p-3 rounded-lg bg-[var(--cream-warm)]/50 hover:bg-[var(--cream-warm)] transition-colors" onClick={() => { setExpandApps(!expandApps); if (!expandApps && apps.length === 0) fetchApps() }}>
                      <div className="flex items-center gap-2">
                        {expandApps ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                        <Package size={18} className="text-[var(--sky)]" />
                        <span className="font-medium">应用管理</span>
                        {apps.length > 0 && <span className="ml-2 text-xs text-[var(--coffee-muted)]">{apps.filter(a => !a.error).length} 个应用</span>}
                      </div>
                    </button>
                    {expandApps && (
                      <div className="p-4 bg-[var(--cream-warm)]/30 rounded-xl space-y-3">
                        <div className="flex gap-2 items-center">
                          <div className="relative flex-1">
                            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--coffee-muted)]" />
                            <input type="text" value={appSearch} onChange={e => setAppSearch(e.target.value)} placeholder="搜索 App..." className="pl-9 text-sm" />
                          </div>
                          <label className="flex items-center gap-1.5 text-xs text-[var(--coffee-muted)] cursor-pointer">
                            <input type="checkbox" checked={showSystemApps} onChange={e => { setShowSystemApps(e.target.checked); setTimeout(fetchApps, 0) }} />
                            系统应用
                          </label>
                          <button className="btn-secondary p-2" onClick={fetchApps} disabled={appsLoading}><RefreshCw size={14} /></button>
                        </div>
                        {appsLoading ? (
                          <div className="flex justify-center py-8"><div className="spinner" /></div>
                        ) : (
                          <div className="max-h-96 overflow-auto space-y-1">
                            {filteredApps.map(app => (
                              <div key={app.bundle_id} className="flex items-center justify-between p-3 rounded-lg hover:bg-[var(--cream-warm)] transition-colors">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium text-[var(--coffee-deep)]">{app.name}</span>
                                    {app.is_system && <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">系统</span>}
                                  </div>
                                  <div className="text-xs text-[var(--coffee-muted)] font-mono">{app.bundle_id}</div>
                                  <div className="text-xs text-[var(--coffee-muted)]">v{app.version} · {formatBytes(app.size)}</div>
                                </div>
                                {!app.is_system && (
                                  <button className="btn-secondary p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50" onClick={() => handleUninstall(app.bundle_id)} title="卸载">
                                    <Trash2 size={14} />
                                  </button>
                                )}
                              </div>
                            ))}
                            {filteredApps.length === 0 && <div className="text-center text-sm text-[var(--coffee-muted)] py-8">无匹配应用</div>}
                          </div>
                        )}
                      </div>
                    )}

                    {/* ── Screenshot Panel ── */}
                    <button className="w-full flex items-center justify-between p-3 rounded-lg bg-[var(--cream-warm)]/50 hover:bg-[var(--cream-warm)] transition-colors" onClick={() => setExpandScreenshot(!expandScreenshot)}>
                      <div className="flex items-center gap-2">
                        {expandScreenshot ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                        <Camera size={18} className="text-[var(--sage)]" />
                        <span className="font-medium">截图</span>
                      </div>
                    </button>
                    {expandScreenshot && (
                      <div className="p-4 bg-[var(--cream-warm)]/30 rounded-xl space-y-3">
                        <button className="btn-primary flex items-center gap-2" onClick={handleScreenshot} disabled={screenshotLoading}>
                          <Camera size={14} />{screenshotLoading ? '截图中...' : '截取当前屏幕'}
                        </button>
                        {screenshotUrl && (
                          <div className="flex gap-4">
                            <img src={screenshotUrl} alt="screenshot" className="max-h-80 rounded-xl border border-[var(--glass-border)] shadow-sm" />
                            <div className="space-y-2">
                              <button className="btn-secondary flex items-center gap-2 text-sm" onClick={() => {
                                const a = document.createElement('a'); a.href = screenshotUrl; a.download = `ios_screenshot_${Date.now()}.png`; a.click()
                              }}><Download size={14} /> 保存到本地</button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                  </div>
                </div>
              ) : (
                <div className="glass-card p-12 text-center animate-fade-in">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-[var(--cream-warm)] flex items-center justify-center">
                    <Smartphone size={32} className="text-[var(--coffee-muted)]" />
                  </div>
                  <h3 className="font-display text-lg text-[var(--coffee-deep)] mb-1">选择一个设备</h3>
                  <p className="text-sm text-[var(--coffee-muted)]">从左侧列表中选择设备进行操作</p>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* IPA Install Modal */}
      {showInstallModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setShowInstallModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-96 max-w-[90vw]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-lg font-semibold text-[var(--coffee-deep)]">安装 IPA</h3>
              <button className="p-1 rounded-lg hover:bg-[var(--cream-warm)]" onClick={() => setShowInstallModal(false)}><X size={18} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <input type="file" accept=".ipa" className="hidden" id="ipa-input" onChange={e => setInstallFile(e.target.files?.[0] || null)} />
                <button className="btn-secondary w-full flex items-center justify-center gap-2 py-3" onClick={() => document.getElementById('ipa-input').click()}>
                  <Package size={16} />{installFile ? installFile.name : '选择 IPA 文件'}
                </button>
                {installFile && (
                  <div className="mt-2 text-xs text-[var(--coffee-muted)]">{formatBytes(installFile.size)}</div>
                )}
              </div>
              {installProgress && (
                <div className="flex items-center gap-2 text-sm text-[var(--coffee-muted)]">
                  <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> 安装中...
                </div>
              )}
              <button className="btn-primary w-full flex items-center justify-center gap-2" onClick={handleInstallIpa} disabled={!installFile || !!installProgress}>
                <Package size={14} />{installProgress ? '安装中...' : '安装'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default IosMaster
