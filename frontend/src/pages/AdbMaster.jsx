import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, RefreshCw, Smartphone, Wifi, Usb, FileText, Upload, Download,
  X, Package, RotateCcw, WifiOff, ChevronDown, ChevronRight, FolderOpen,
  Play, Square, Zap, Edit, Check, Monitor, Archive, Search
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
  const logcatContainerRef = useRef(null)

  // 展开面板状态
  const [expandLogcat, setExpandLogcat] = useState(false)
  const [expandTransfer, setExpandTransfer] = useState(false)
  const [expandScrcpy, setExpandScrcpy] = useState(false)
  const [expandExtract, setExpandExtract] = useState(false)

  // 应用提取 State
  const [packages, setPackages] = useState([])
  const [selectedPkgs, setSelectedPkgs] = useState(new Set())
  const [pkgFilter, setPkgFilter] = useState('third_party')
  const [pkgSearch, setPkgSearch] = useState('')
  const [extractDir, setExtractDir] = useState(() => localStorage.getItem('adb_extractDir') || 'D:\\apk_backup')
  const [extracting, setExtracting] = useState(false)
  const [extractProgress, setExtractProgress] = useState(null)
  const [packagesLoading, setPackagesLoading] = useState(false)

  // 投屏控制 State (Phase 2 - Web 嵌入)
  const [scrcpyStatus, setScrcpyStatus] = useState({ running: false })
  const [scrcpyConfig, setScrcpyConfig] = useState({
    max_size: 1280,
    max_fps: 30,
    video_bit_rate: 4000000,
    stay_awake: true,
    show_touches: true,
    turn_screen_off: false,
  })
  const [scrcpyLoading, setScrcpyLoading] = useState(false)
  const [scrcpyStreaming, setScrcpyStreaming] = useState(false)
  const [scrcpyStreamingDeviceId, setScrcpyStreamingDeviceId] = useState(null) // 记录正在投屏的设备ID
  const [scrcpyMeta, setScrcpyMeta] = useState(null) // {width, height, codec}
  const scrcpyMetaRef = useRef({ width: 800, height: 448 }) // 实际分辨率 ref
  const scrcpyCanvasRef = useRef(null)
  const scrcpyWsRef = useRef(null)
  const scrcpyDecoderRef = useRef(null)

  // 弹窗状态
  const [showInstallModal, setShowInstallModal] = useState(false)

  // 表单状态 (从 localStorage 恢复)
  const [pushLocalPath, setPushLocalPath] = useState(() => localStorage.getItem('adb_pushLocalPath') || '')
  const [pushRemotePath, setPushRemotePath] = useState(() => localStorage.getItem('adb_pushRemotePath') || '/sdcard/')
  const [pullRemotePath, setPullRemotePath] = useState(() => localStorage.getItem('adb_pullRemotePath') || '')
  const [pullLocalPath, setPullLocalPath] = useState(() => localStorage.getItem('adb_pullLocalPath') || '')
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
          else setSelectedDevice(null)  // 设备彻底消失时清除选中
        }
      }
    } catch (err) {
      console.error('获取设备列表失败:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { document.title = 'ADB Master - EncyHub' }, [])

  useEffect(() => {
    fetchDevices()
    fetchPathHistory()
    const interval = setInterval(fetchDevices, 3000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const container = logcatContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }, [logcat])

  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [])

  // 投屏: 设备切换时清理 WebSocket 和解码器
  useEffect(() => {
    return () => {
      if (scrcpyWsRef.current) {
        scrcpyWsRef.current.close()
        scrcpyWsRef.current = null
      }
      if (scrcpyDecoderRef.current && scrcpyDecoderRef.current.state !== 'closed') {
        scrcpyDecoderRef.current.close()
        scrcpyDecoderRef.current = null
      }
      setScrcpyStreaming(false)
      setScrcpyStreamingDeviceId(null)
      setScrcpyMeta(null)
    }
  }, [selectedDevice])

  // ======== Scrcpy WebCodecs 解码逻辑 ========
  // 收集 SPS/PPS 用于构建 AVCC description
  const spsRef = useRef(null)
  const ppsRef = useRef(null)

  const initScrcpyDecoder = (width, height, profile, profileCompat, level, description = null) => {
    const canvas = scrcpyCanvasRef.current
    if (!canvas) {
      console.error('[ScrcpyPlayer] Canvas not found')
      return
    }

    const maxW = 640  // 增加最大宽度以获得更好的显示效果
    const scale = Math.min(1, maxW / width)
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const ctx = canvas.getContext('2d')
    // 绘制黑色背景
    ctx.fillStyle = 'black'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    console.log('[ScrcpyPlayer] 初始化解码器:', width, 'x', height, 'scale:', scale, 'canvas:', canvas.width, 'x', canvas.height)
    console.log('[ScrcpyPlayer] profile/level:', profile, profileCompat, level, 'description:', description ? '已提供' : '未提供')

    // 构建 codec 字符串: avc1.profile(2 hex).profile_compat(2 hex).level(2 hex)
    const profileHex = profile.toString(16).padStart(2, '0').toUpperCase()
    const profileCompatHex = profileCompat.toString(16).padStart(2, '0').toUpperCase()
    const levelHex = level.toString(16).padStart(2, '0').toUpperCase()
    const codec = `avc1.${profileHex}${profileCompatHex}${levelHex}`

    console.log('[ScrcpyPlayer] codec 字符串:', codec)

    const config = {
      codec: codec,
      codedWidth: width,
      codedHeight: height,
      optimizeForLatency: true,
    }
    // 如果有 AVCC description，添加到配置中
    if (description) {
      config.description = description
    }

    const decoder = new VideoDecoder({
      output: (frame) => {
        // 根据实际输出帧的分辨率调整 Canvas
        const actualWidth = frame.codedWidth
        const actualHeight = frame.codedHeight

        console.log('[ScrcpyPlayer] 解码成功输出帧:', {
          codedWidth: actualWidth,
          codedHeight: actualHeight,
          timestamp: frame.timestamp,
          duration: frame.duration,
          displayWidth: frame.displayWidth,
          displayHeight: frame.displayHeight,
          alpha: frame.alpha
        })

        // 更新 Canvas 尺寸（如果需要）
        const maxW = 640
        const scale = Math.min(1, maxW / actualWidth)
        const newCanvasW = Math.round(actualWidth * scale)
        const newCanvasH = Math.round(actualHeight * scale)

        if (canvas.width !== newCanvasW || canvas.height !== newCanvasH) {
          canvas.width = newCanvasW
          canvas.height = newCanvasH
          // 更新 meta ref 供触摸控制使用
          scrcpyMetaRef.current = { width: actualWidth, height: actualHeight, codec: 'h264' }
          setScrcpyMeta({ width: actualWidth, height: actualHeight, codec: 'h264' })
        }

        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height)
        frame.close()
      },
      error: (e) => console.error('[ScrcpyPlayer] decode error:', e),
    })
    decoder.configure(config)
    scrcpyDecoderRef.current = decoder
    console.log('[ScrcpyPlayer] 解码器配置完成, state:', decoder.state)
  }

  const handleScrcpyFrame = (data) => {
    const decoder = scrcpyDecoderRef.current
    if (!decoder) {
      console.error('[ScrcpyPlayer] 解码器未初始化')
      return
    }
    if (decoder.state === 'closed') {
      console.error('[ScrcpyPlayer] 解码器已关闭')
      return
    }

    const view = new DataView(data)
    const flags = view.getUint8(0)
    const ptsHigh = view.getUint32(1)
    const ptsLow = view.getUint32(5)
    const pts = ptsHigh * 4294967296 + ptsLow
    const isConfig = !!(flags & 0x01)
    const isKeyFrame = !!(flags & 0x02)

    // 消息格式: [Flags(1)][PTS(8)][Length(4)][NALU...]
    const naluLen = view.getUint32(9, false) // big-endian
    const naluData = new Uint8Array(data, 13, naluLen)

    console.log('[ScrcpyPlayer] 收到帧:', {
      size: naluLen,
      isConfig,
      isKeyFrame,
      pts,
      decoderState: decoder.state,
      naluType: naluData[0] & 0x1F,
    })

    try {
      const naluType = naluData[0] & 0x1F

      // 收集 SPS 和 PPS
      if (isConfig) {
        if (naluType === 7) { // SPS
          spsRef.current = naluData
          console.log('[ScrcpyPlayer] 收到 SPS, 内容:', Array.from(naluData).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '))
          console.log('[ScrcpyPlayer] SPS profile/compat/level:', naluData[0] & 0x1F, naluData[1], naluData[2], naluData[3])
          return // SPS 不需要解码
        } else if (naluType === 8) { // PPS
          ppsRef.current = naluData
          console.log('[ScrcpyPlayer] 收到 PPS, 内容:', Array.from(naluData).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '))

          // 如果 SPS 和 PPS 都有了，重新配置解码器
          if (spsRef.current) {
            const sps = spsRef.current
            const pps = ppsRef.current

            const profile = sps[1]
            const profileCompat = sps[2]
            const level = sps[3]

            // 创建 AVCC description
            const avccDesc = createAVCCDescription(sps, pps)
            console.log('[ScrcpyPlayer] AVCC description 内容:', Array.from(avccDesc).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '))
            console.log('[ScrcpyPlayer] 重新配置解码器，包含 AVCC description, codec:', `avc1.${profile.toString(16).padStart(2, '0').toUpperCase()}${profileCompat.toString(16).padStart(2, '0').toUpperCase()}${level.toString(16).padStart(2, '0').toUpperCase()}`)

            // 重新配置解码器
            decoder.configure({
              codec: `avc1.${profile.toString(16).padStart(2, '0').toUpperCase()}${profileCompat.toString(16).padStart(2, '0').toUpperCase()}${level.toString(16).padStart(2, '0').toUpperCase()}`,
              codedWidth: scrcpyMetaRef.current.width,
              codedHeight: scrcpyMetaRef.current.height,
              optimizeForLatency: true,
              description: avccDesc,
            })
            console.log('[ScrcpyPlayer] 解码器重新配置完成, state:', decoder.state)
          }
          return // PPS 不需要解码
        }
      }

      // VideoDecoder 需要 AVCC 格式（NALU 带 4 字节长度前缀）
      // 当前 naluData 是 Annex-B 格式（无起始码），需要添加长度前缀
      const avccData = new Uint8Array(naluLen + 4)
      new DataView(avccData.buffer).setUint32(0, naluLen, false) // big-endian length prefix
      avccData.set(naluData, 4)

      // 解码视频帧（AVCC 格式，已有长度前缀）
      const chunk = new EncodedVideoChunk({
        type: isKeyFrame ? 'key' : 'delta',
        timestamp: pts,
        data: avccData,
      })
      console.log('[ScrcpyPlayer] 解码:', {
        type: chunk.type,
        timestamp: chunk.timestamp,
        dataLen: chunk.byteLength,
        naluType: naluData[0] & 0x1F,
        firstBytes: Array.from(avccData.slice(0, 16)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')
      })
      decoder.decode(chunk)
    } catch (e) {
      console.error('[ScrcpyPlayer] 解码失败:', e)
    }
  }

  // 创建 AVCC description（不含 AVCC box header）
  const createAVCCDescription = (sps, pps) => {
    const spsLen = sps.length
    const ppsLen = pps.length
    const data = new Uint8Array(6 + 2 + spsLen + 3 + ppsLen)
    let offset = 0

    // AVCC header
    data[offset++] = 1 // version
    data[offset++] = sps[1] // profile
    data[offset++] = sps[2] // profile compatibility
    data[offset++] = sps[3] // level
    data[offset++] = 0xFF // 6 bits reserved + 2 bits length size (minus 1, so length = 4)
    data[offset++] = 0xE1 // 3 bits reserved + 5 bits num SPS (1 SPS)

    // SPS (length + data)
    data[offset++] = (spsLen >> 8) & 0xFF
    data[offset++] = spsLen & 0xFF
    data.set(sps, offset)
    offset += spsLen

    // PPS (num PPS + length + data)
    data[offset++] = 1 // num PPS = 1
    data[offset++] = (ppsLen >> 8) & 0xFF
    data[offset++] = ppsLen & 0xFF
    data.set(pps, offset)
    offset += ppsLen

    return data.slice(0, offset)
  }

  const sendScrcpyTouch = (action, e) => {
    const ws = scrcpyWsRef.current
    const meta = scrcpyMetaRef.current
    const canvas = scrcpyCanvasRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !canvas) {
      console.log('[ScrcpyPlayer] 发送触摸失败:', {
        wsReady: ws?.readyState,
        meta: !!meta,
        canvas: !!canvas
      })
      return
    }
    const rect = canvas.getBoundingClientRect()
    const scaleX = meta.width / canvas.width
    const scaleY = meta.height / canvas.height
    const x = Math.round((e.clientX - rect.left) * scaleX)
    const y = Math.round((e.clientY - rect.top) * scaleY)
    console.log('[ScrcpyPlayer] 发送触摸:', {
      action,
      x,
      y,
      meta,
      canvasSize: `${canvas.width}x${canvas.height}`,
      rect: `${rect.width}x${rect.height}`
    })
    ws.send(JSON.stringify({ type: 'touch', action, x, y }))
  }

  const sendScrcpyKey = (keycode) => {
    const ws = scrcpyWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log('[ScrcpyPlayer] 发送按键失败:', {
        wsReady: ws?.readyState,
        keycode
      })
      return
    }
    console.log('[ScrcpyPlayer] 发送按键:', keycode)
    ws.send(JSON.stringify({ type: 'keycode', action: 0, keycode }))
    setTimeout(() => ws.send(JSON.stringify({ type: 'keycode', action: 1, keycode })), 50)
  }

  // 获取连接状态徽章
  const getConnectionBadge = (device) => {
    if (device.usb_connected && device.wifi_connected) {
      return { icon: '◈', label: 'WiFi & USB', className: 'badge-dual' }
    } else if (device.wifi_connected) {
      return { icon: '◉', label: 'WiFi', className: 'badge-wifi' }
    } else if (device.usb_connected) {
      return { icon: '⚡', label: 'USB', className: 'badge-usb' }
    } else if (device.has_known_wifi) {
      return { icon: '◌', label: '离线 · 可重连', className: 'badge-reconnect' }
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
          localStorage.setItem('adb_pushLocalPath', pushLocalPath)
          localStorage.setItem('adb_pushRemotePath', pushRemotePath)
          fetchPathHistory()
        } else {
          toast.error(data.detail || '推送失败')
        }
      } catch {
        if (res.ok) {
          toast.success('推送成功')
          localStorage.setItem('adb_pushLocalPath', pushLocalPath)
          localStorage.setItem('adb_pushRemotePath', pushRemotePath)
        }
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
        localStorage.setItem('adb_pullRemotePath', pullRemotePath)
        if (pullLocalPath) localStorage.setItem('adb_pullLocalPath', pullLocalPath)
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

  // WiFi 快速重连（无需 USB）
  const handleReconnectWifi = async () => {
    if (!selectedDevice) return
    try {
      const res = await fetch(`/api/adb_master/devices/${selectedDevice.hardware_id}/reconnect-wifi`, {
        method: 'POST',
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(data.message || '重连成功')
        fetchDevices()
      } else {
        toast.error(data.detail || '重连失败')
      }
    } catch (err) {
      toast.error('重连失败: ' + err.message)
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

  // ======== 应用提取 ========
  const formatSize = (bytes) => {
    if (!bytes || bytes === 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return (bytes / Math.pow(1024, Math.min(i, 3))).toFixed(i > 0 ? 1 : 0) + ' ' + units[Math.min(i, 3)]
  }

  const fetchPackages = async () => {
    if (!selectedDevice) return
    setPackagesLoading(true)
    setPackages([])
    setSelectedPkgs(new Set())
    try {
      const thirdParty = pkgFilter === 'third_party'
      const res = await fetch(`/api/adb_master/devices/${selectedDevice.hardware_id}/packages?third_party_only=${thirdParty}`)
      if (res.ok) {
        const data = await res.json()
        setPackages(data.packages || [])
      } else {
        const data = await res.json()
        toast.error(data.detail || '获取应用列表失败')
      }
    } catch (err) {
      toast.error('获取应用列表失败: ' + err.message)
    } finally {
      setPackagesLoading(false)
    }
  }

  const filteredPackages = packages.filter(p =>
    !pkgSearch || p.package.toLowerCase().includes(pkgSearch.toLowerCase())
  )

  const selectedTotalSize = [...selectedPkgs].reduce((sum, pkg) => {
    const p = packages.find(x => x.package === pkg)
    return sum + (p?.size_bytes || 0)
  }, 0)

  const togglePkg = (pkg) => {
    setSelectedPkgs(prev => {
      const next = new Set(prev)
      if (next.has(pkg)) next.delete(pkg)
      else next.add(pkg)
      return next
    })
  }

  const toggleAllPkgs = () => {
    if (selectedPkgs.size === filteredPackages.length) {
      setSelectedPkgs(new Set())
    } else {
      setSelectedPkgs(new Set(filteredPackages.map(p => p.package)))
    }
  }

  const handleExtract = async () => {
    if (!selectedDevice || selectedPkgs.size === 0) return
    setExtracting(true)
    setExtractProgress({ current: 0, total: selectedPkgs.size, currentPkg: '', percent: 0 })
    localStorage.setItem('adb_extractDir', extractDir)

    try {
      const res = await fetch(`/api/adb_master/devices/${selectedDevice.hardware_id}/extract-apks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packages: [...selectedPkgs], local_dir: extractDir }),
      })

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const evt = JSON.parse(line.slice(6))
            if (evt.type === 'start') {
              setExtractProgress(prev => ({
                ...prev,
                current: evt.current,
                total: evt.total,
                currentPkg: evt.package,
                percent: Math.round(((evt.current - 1) / evt.total) * 100),
              }))
            } else if (evt.type === 'item') {
              setExtractProgress(prev => ({
                ...prev,
                current: evt.current,
                total: evt.total,
                currentPkg: evt.package,
                percent: Math.round((evt.current / evt.total) * 100),
                lastStatus: evt.status,
                lastSpeed: evt.speed_bps ? formatSize(evt.speed_bps) + '/s' : null,
              }))
            } else if (evt.type === 'done') {
              setExtractProgress({
                done: true,
                success_count: evt.success_count,
                fail_count: evt.fail_count,
                total: evt.total,
                local_dir: evt.local_dir,
                percent: 100,
              })
            } else if (evt.type === 'cancelled') {
              toast.warning('提取已取消')
              setExtractProgress(null)
              setExtracting(false)
            }
          } catch {}
        }
      }
    } catch (err) {
      toast.error('提取失败: ' + err.message)
      setExtractProgress(null)
    } finally {
      setExtracting(false)
    }
  }

  const handleCancelExtract = async () => {
    if (!selectedDevice) return
    try {
      await fetch(`/api/adb_master/devices/${selectedDevice.hardware_id}/extract-apks`, { method: 'DELETE' })
    } catch {}
  }

  const handleOpenExtractDir = async () => {
    const dir = extractProgress?.local_dir || extractDir
    try {
      await fetch('/api/adb_master/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir }),
      })
    } catch {}
  }

  // ======== 设备切换处理 ========
  const handleSelectDevice = async (device) => {
    // 如果点击的是当前已选中的设备，不做任何处理
    if (selectedDevice?.hardware_id === device.hardware_id) {
      return
    }

    // 如果正在投屏，先停止当前投屏
    if (scrcpyStreaming && selectedDevice) {
      const prevDeviceName = selectedDevice.nickname || selectedDevice.model || selectedDevice.hardware_id
      await handleStopScrcpy(true) // silent = true, 不显示默认 toast
      toast.info(`已停止 ${prevDeviceName} 的投屏`)
    }

    setSelectedDevice(device)
  }

  // ======== 启动 Web 嵌入投屏 ========
  const handleStartScrcpy = async () => {
    if (!selectedDevice) return
    setScrcpyLoading(true)
    try {
      // Step 1: REST 启动 scrcpy-server + TCP 连接
      const res = await fetch(
        `/api/adb_master/devices/${selectedDevice.hardware_id}/scrcpy/start`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(scrcpyConfig),
        }
      )
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.detail || '启动失败')
        return
      }

      setScrcpyMeta({ width: data.width, height: data.height, codec: data.codec })
      scrcpyMetaRef.current = { width: data.width, height: data.height, codec: data.codec }
      setScrcpyStatus({ running: true })

      // Step 2: 先显示 Canvas 区域，然后初始化解码器
      setScrcpyStreaming(true)
      setScrcpyStreamingDeviceId(selectedDevice.hardware_id)

      // 等待 Canvas 渲染
      await new Promise(r => setTimeout(r, 200))

      // Step 3: 打开 WebSocket 接收视频流
      const wsUrl = `ws://${window.location.host}/api/adb_master/devices/${selectedDevice.hardware_id}/scrcpy/stream`
      const ws = new WebSocket(wsUrl)
      ws.binaryType = 'arraybuffer'

      ws.onopen = () => {
        console.log('[ScrcpyPlayer] WebSocket 已连接')
        // 在这里初始化解码器，确保 Canvas 已渲染
        // 使用默认值，会在收到 SPS 后重新配置
        initScrcpyDecoder(data.width, data.height, 0x42, 0xC0, 0x29)
        toast.success('投屏已连接')
      }
      ws.onmessage = (evt) => {
        console.log('[ScrcpyPlayer] 收到 WebSocket 消息, 类型:', typeof evt.data, 'ArrayBuffer:', evt.data instanceof ArrayBuffer, 'byteLength:', evt.data?.byteLength || 'N/A')
        if (evt.data instanceof ArrayBuffer) {
          handleScrcpyFrame(evt.data)
        } else {
          console.error('[ScrcpyPlayer] 意外的数据类型:', typeof evt.data, evt.data)
        }
      }
      ws.onclose = () => {
        console.log('[ScrcpyPlayer] WebSocket 已关闭')
        setScrcpyStreaming(false)
        setScrcpyStatus({ running: false })
        setScrcpyMeta(null)
        if (scrcpyDecoderRef.current && scrcpyDecoderRef.current.state !== 'closed') {
          scrcpyDecoderRef.current.close()
        }
        scrcpyDecoderRef.current = null
      }
      ws.onerror = (e) => {
        console.error('[ScrcpyPlayer] WebSocket 错误:', e)
        toast.error('投屏连接异常')
      }
      scrcpyWsRef.current = ws

    } catch (err) {
      toast.error('启动失败: ' + err.message)
    } finally {
      setScrcpyLoading(false)
    }
  }

  // ======== 停止投屏 ========
  const handleStopScrcpy = async (silent = false) => {
    if (!selectedDevice) return
    // 关闭 WS
    if (scrcpyWsRef.current) {
      scrcpyWsRef.current.close()
      scrcpyWsRef.current = null
    }
    // 关闭解码器
    if (scrcpyDecoderRef.current && scrcpyDecoderRef.current.state !== 'closed') {
      scrcpyDecoderRef.current.close()
    }
    scrcpyDecoderRef.current = null
    setScrcpyStreaming(false)
    setScrcpyStreamingDeviceId(null) // 清除投屏设备ID
    setScrcpyMeta(null)
    try {
      const res = await fetch(
        `/api/adb_master/devices/${selectedDevice.hardware_id}/scrcpy/stop`,
        { method: 'POST' }
      )
      const data = await res.json()
      if (!silent) {
        toast.success(data.message || '投屏已停止')
      }
    } catch (err) {
      if (!silent) {
        toast.error('停止失败: ' + err.message)
      }
    }
    setScrcpyStatus({ running: false })
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
                        onClick={() => handleSelectDevice(device)}
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
                                badge.className === 'badge-reconnect' ? 'bg-[var(--amber-soft)]/20 text-[var(--coffee-muted)] border border-dashed border-[var(--caramel-light)]' :
                                'bg-[var(--cream-warm)] text-[var(--coffee-muted)]'
                              }`}>
                                {badge.icon} {badge.label}
                              </span>
                              {/* 投屏中指示 */}
                              {scrcpyStreaming && scrcpyStreamingDeviceId === device.hardware_id && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--sage)]/15 text-[var(--sage)]">
                                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--sage)] animate-pulse" />
                                  投屏中
                                </span>
                              )}
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
                      {!selectedDevice.usb_connected && !selectedDevice.wifi_connected && selectedDevice.has_known_wifi && (
                        <button
                          className="btn-primary flex items-center gap-2"
                          onClick={handleReconnectWifi}
                        >
                          <Wifi size={16} />
                          重连 WiFi
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
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer ${
                          logcatRunning
                            ? 'bg-[var(--terracotta)] text-white hover:brightness-110 hover:-translate-y-0.5 hover:shadow-md'
                            : 'bg-[var(--sage)] text-white hover:brightness-110 hover:-translate-y-0.5 hover:shadow-md'
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
                      <div ref={logcatContainerRef} className="mt-2 bg-[var(--coffee-deep)] rounded-xl p-4 h-72 max-h-[50vh] overflow-auto font-mono text-xs text-[var(--sage)] leading-relaxed">
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
                          <div className="space-y-2.5">
                            <div className="relative">
                              <label className="block text-xs text-[var(--coffee-muted)] mb-1">本地路径 (文件或文件夹)</label>
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  value={pushLocalPath}
                                  onChange={e => setPushLocalPath(e.target.value)}
                                  placeholder="例: D:\project\assets"
                                  className="font-mono text-sm flex-1"
                                />
                                <button
                                  className="btn-secondary p-2 shrink-0"
                                  onClick={async () => {
                                    if (!pushLocalPath.trim()) return
                                    try {
                                      const res = await fetch(`/api/adb_master/open-folder`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ path: pushLocalPath }),
                                      })
                                      if (!res.ok) {
                                        const data = await res.json()
                                        toast.error(data.detail || '打开失败')
                                      }
                                    } catch (err) {
                                      toast.error('打开失败: ' + err.message)
                                    }
                                  }}
                                  title="在文件管理器中打开"
                                >
                                  <FolderOpen size={16} />
                                </button>
                              </div>
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
                          <div className="space-y-2.5">
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
                            <div className="relative">
                              <label className="block text-xs text-[var(--coffee-muted)] mb-1">本地保存路径 (留空则浏览器下载)</label>
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  value={pullLocalPath}
                                  onChange={e => setPullLocalPath(e.target.value)}
                                  placeholder="例: D:\Downloads\file.txt"
                                  className="font-mono text-sm flex-1"
                                />
                                <button
                                  className="btn-secondary p-2 shrink-0"
                                  onClick={async () => {
                                    if (!pullLocalPath.trim()) return
                                    try {
                                      const res = await fetch(`/api/adb_master/open-folder`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ path: pullLocalPath }),
                                      })
                                      if (!res.ok) {
                                        const data = await res.json()
                                        toast.error(data.detail || '打开失败')
                                      }
                                    } catch (err) {
                                      toast.error('打开失败: ' + err.message)
                                    }
                                  }}
                                  title="在文件管理器中打开"
                                >
                                  <FolderOpen size={16} />
                                </button>
                              </div>
                            </div>
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

                  {/* Scrcpy Web 投屏面板 */}
                  <div className="mt-4">
                    <button
                      className="w-full flex items-center justify-between p-3 rounded-lg bg-[var(--cream-warm)]/50 hover:bg-[var(--cream-warm)] transition-colors"
                      onClick={() => setExpandScrcpy(!expandScrcpy)}
                    >
                      <div className="flex items-center gap-2">
                        {expandScrcpy ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                        <Monitor size={18} className="text-[var(--caramel)]" />
                        <span className="font-medium">投屏控制</span>
                        {scrcpyStreaming && (
                          <span className="ml-2 flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-[var(--sage)]/15 text-[var(--sage)] font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--sage)] animate-pulse" />
                            投屏中
                          </span>
                        )}
                      </div>
                      {/* 显示正在投屏的设备名称 */}
                      {scrcpyStreaming && (
                        <span className="text-xs text-[var(--coffee-muted)]">
                          {selectedDevice?.nickname || selectedDevice?.model || '设备'}
                        </span>
                      )}
                    </button>
                    {expandScrcpy && (
                      <div className="mt-2 p-4 bg-[var(--cream-warm)]/30 rounded-xl space-y-4">
                        {/* 参数配置区 (未投屏时可修改) */}
                        {!scrcpyStreaming && (
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs text-[var(--coffee-muted)] mb-1">分辨率上限</label>
                              <select
                                value={scrcpyConfig.max_size}
                                onChange={e => setScrcpyConfig(c => ({...c, max_size: Number(e.target.value)}))}
                                className="w-full text-sm rounded-lg border border-[var(--glass-border)] px-3 py-1.5 bg-white"
                              >
                                <option value={480}>480p (流畅)</option>
                                <option value={720}>720p (标准)</option>
                                <option value={800}>800p (推荐)</option>
                                <option value={1024}>1024p (高清)</option>
                                <option value={0}>原始分辨率</option>
                              </select>
                            </div>
                            <div>
                              <label className="block text-xs text-[var(--coffee-muted)] mb-1">视频码率</label>
                              <select
                                value={scrcpyConfig.video_bit_rate}
                                onChange={e => setScrcpyConfig(c => ({...c, video_bit_rate: Number(e.target.value)}))}
                                className="w-full text-sm rounded-lg border border-[var(--glass-border)] px-3 py-1.5 bg-white"
                              >
                                <option value={2000000}>2 Mbps (省带宽)</option>
                                <option value={4000000}>4 Mbps (推荐)</option>
                                <option value={8000000}>8 Mbps (高画质)</option>
                                <option value={16000000}>16 Mbps (极限)</option>
                              </select>
                            </div>
                            <div>
                              <label className="block text-xs text-[var(--coffee-muted)] mb-1">最大帧率</label>
                              <select
                                value={scrcpyConfig.max_fps}
                                onChange={e => setScrcpyConfig(c => ({...c, max_fps: Number(e.target.value)}))}
                                className="w-full text-sm rounded-lg border border-[var(--glass-border)] px-3 py-1.5 bg-white"
                              >
                                <option value={15}>15 FPS</option>
                                <option value={24}>24 FPS</option>
                                <option value={30}>30 FPS (推荐)</option>
                                <option value={60}>60 FPS</option>
                              </select>
                            </div>
                            <div className="flex flex-col justify-end gap-1.5">
                              <label className="flex items-center gap-2 text-sm text-[var(--coffee-deep)] cursor-pointer">
                                <input type="checkbox" checked={scrcpyConfig.show_touches}
                                  onChange={e => setScrcpyConfig(c => ({...c, show_touches: e.target.checked}))}
                                  className="rounded" />
                                显示触摸点
                              </label>
                              <label className="flex items-center gap-2 text-sm text-[var(--coffee-deep)] cursor-pointer">
                                <input type="checkbox" checked={scrcpyConfig.turn_screen_off}
                                  onChange={e => setScrcpyConfig(c => ({...c, turn_screen_off: e.target.checked}))}
                                  className="rounded" />
                                关闭设备屏幕
                              </label>
                            </div>
                          </div>
                        )}

                        {/* 操作按钮 */}
                        <div className="flex items-center gap-3 pt-2 border-t border-[var(--glass-border)]">
                          {!scrcpyStreaming ? (
                            <button
                              className="btn-primary flex items-center gap-2"
                              onClick={handleStartScrcpy}
                              disabled={scrcpyLoading}
                            >
                              <Play size={14} />
                              {scrcpyLoading ? '启动中...' : '启动投屏'}
                            </button>
                          ) : (
                            <button
                              className="px-4 py-2 rounded-xl text-sm font-medium bg-[var(--terracotta)] text-white hover:brightness-110 transition-all flex items-center gap-2"
                              onClick={handleStopScrcpy}
                            >
                              <Square size={14} />
                              停止投屏
                            </button>
                          )}
                        </div>

                        {/* Web 嵌入 Canvas 播放器 + 虚拟按键 */}
                        {scrcpyStreaming && (
                          <div className="mt-2 flex flex-col items-center gap-2">
                            <canvas
                              ref={scrcpyCanvasRef}
                              className="rounded-lg border-2 border-[var(--glass-border)] shadow-md cursor-crosshair bg-black"
                              style={{ maxWidth: '100%', touchAction: 'none' }}
                              onMouseDown={e => { e.preventDefault(); sendScrcpyTouch(0, e) }}
                              onMouseMove={e => { if (e.buttons) sendScrcpyTouch(2, e) }}
                              onMouseUp={e => sendScrcpyTouch(1, e)}
                              onContextMenu={e => e.preventDefault()}
                            />
                            {/* 虚拟按键栏 */}
                            <div className="flex items-center gap-1.5">
                              <button onClick={() => sendScrcpyKey(4)} title="返回"
                                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--cream-warm)] hover:bg-[var(--glass-border)] transition-colors">
                                ← Back
                              </button>
                              <button onClick={() => sendScrcpyKey(3)} title="Home"
                                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--cream-warm)] hover:bg-[var(--glass-border)] transition-colors">
                                ○ Home
                              </button>
                              <button onClick={() => sendScrcpyKey(187)} title="多任务"
                                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--cream-warm)] hover:bg-[var(--glass-border)] transition-colors">
                                □ Recent
                              </button>
                              <span className="w-px h-5 bg-[var(--glass-border)]" />
                              <button onClick={() => sendScrcpyKey(25)} title="音量-"
                                className="px-2 py-1.5 rounded-lg text-xs bg-[var(--cream-warm)] hover:bg-[var(--glass-border)] transition-colors">
                                🔉
                              </button>
                              <button onClick={() => sendScrcpyKey(24)} title="音量+"
                                className="px-2 py-1.5 rounded-lg text-xs bg-[var(--cream-warm)] hover:bg-[var(--glass-border)] transition-colors">
                                🔊
                              </button>
                              <button onClick={() => sendScrcpyKey(26)} title="电源"
                                className="px-2 py-1.5 rounded-lg text-xs bg-[var(--cream-warm)] hover:bg-[var(--glass-border)] transition-colors">
                                ⏻
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* 应用提取面板 */}
                  <div className="mt-4">
                    <button
                      className="w-full flex items-center justify-between p-3 rounded-lg bg-[var(--cream-warm)]/50 hover:bg-[var(--cream-warm)] transition-colors"
                      onClick={() => setExpandExtract(!expandExtract)}
                    >
                      <div className="flex items-center gap-2">
                        {expandExtract ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                        <Archive size={18} className="text-[var(--caramel)]" />
                        <span className="font-medium">应用提取</span>
                        {extracting && (
                          <span className="ml-2 flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-[var(--sky)]/15 text-[var(--sky)] font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--sky)] animate-pulse" />
                            提取中
                          </span>
                        )}
                      </div>
                      {packages.length > 0 && !extracting && (
                        <span className="text-xs text-[var(--coffee-muted)]">
                          {packages.length} 个应用
                        </span>
                      )}
                    </button>
                    {expandExtract && (
                      <div className="mt-2 p-4 bg-[var(--cream-warm)]/30 rounded-xl space-y-3">
                        {/* 工具栏 */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                            className="btn-secondary flex items-center gap-1.5 text-sm py-1.5 px-3"
                            onClick={fetchPackages}
                            disabled={packagesLoading}
                          >
                            <RefreshCw size={14} className={packagesLoading ? 'animate-spin' : ''} />
                            {packagesLoading ? '扫描中...' : '刷新应用列表'}
                          </button>
                          <div className="flex items-center rounded-lg border border-[var(--glass-border)] overflow-hidden text-sm">
                            <button
                              className={`px-3 py-1.5 transition-colors ${pkgFilter === 'third_party' ? 'bg-[var(--caramel)] text-white' : 'bg-white hover:bg-[var(--cream-warm)]'}`}
                              onClick={() => { setPkgFilter('third_party'); if (packages.length > 0) setTimeout(fetchPackages, 0) }}
                            >
                              第三方
                            </button>
                            <button
                              className={`px-3 py-1.5 transition-colors ${pkgFilter === 'all' ? 'bg-[var(--caramel)] text-white' : 'bg-white hover:bg-[var(--cream-warm)]'}`}
                              onClick={() => { setPkgFilter('all'); if (packages.length > 0) setTimeout(fetchPackages, 0) }}
                            >
                              全部
                            </button>
                          </div>
                          {packages.length > 0 && (
                            <div className="flex-1 min-w-[160px] relative">
                              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--coffee-muted)]" />
                              <input
                                type="text"
                                value={pkgSearch}
                                onChange={e => setPkgSearch(e.target.value)}
                                placeholder="搜索包名..."
                                className="w-full text-sm pl-8 pr-3 py-1.5 rounded-lg border border-[var(--glass-border)]"
                              />
                            </div>
                          )}
                        </div>

                        {/* 应用列表 */}
                        {packages.length > 0 && !extracting && (
                          <>
                            <div className="flex items-center justify-between px-1">
                              <label className="flex items-center gap-2 text-sm cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={selectedPkgs.size === filteredPackages.length && filteredPackages.length > 0}
                                  onChange={toggleAllPkgs}
                                  className="rounded"
                                />
                                全选
                              </label>
                              <span className="text-xs text-[var(--coffee-muted)]">
                                已选 {selectedPkgs.size}/{filteredPackages.length}
                                {selectedPkgs.size > 0 && ` (${formatSize(selectedTotalSize)})`}
                              </span>
                            </div>
                            <div className="max-h-[280px] overflow-y-auto rounded-lg border border-[var(--glass-border)] bg-white/50">
                              {filteredPackages.map(pkg => (
                                <label
                                  key={pkg.package}
                                  className="flex items-center gap-3 px-3 py-2 hover:bg-[var(--cream-warm)]/50 cursor-pointer border-b border-[var(--glass-border)] last:border-b-0 transition-colors"
                                >
                                  <input
                                    type="checkbox"
                                    checked={selectedPkgs.has(pkg.package)}
                                    onChange={() => togglePkg(pkg.package)}
                                    className="rounded shrink-0"
                                  />
                                  <span className="font-mono text-sm text-[var(--coffee-deep)] truncate flex-1" title={pkg.package}>
                                    {pkg.package}
                                  </span>
                                  <span className="text-xs text-[var(--coffee-muted)] shrink-0 tabular-nums">
                                    {formatSize(pkg.size_bytes)}
                                  </span>
                                </label>
                              ))}
                            </div>
                          </>
                        )}

                        {packages.length === 0 && !packagesLoading && !extracting && (
                          <div className="text-center py-6 text-sm text-[var(--coffee-muted)]">
                            点击「刷新应用列表」扫描设备上的应用
                          </div>
                        )}

                        {/* 提取配置 + 操作按钮 */}
                        {packages.length > 0 && !extracting && !extractProgress?.done && (
                          <div className="pt-2 border-t border-[var(--glass-border)] space-y-2">
                            <div>
                              <label className="block text-xs text-[var(--coffee-muted)] mb-1">保存到本地目录</label>
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  value={extractDir}
                                  onChange={e => setExtractDir(e.target.value)}
                                  placeholder="D:\apk_backup"
                                  className="font-mono text-sm flex-1"
                                />
                                <button
                                  className="btn-secondary p-2 shrink-0"
                                  onClick={handleOpenExtractDir}
                                  title="打开目录"
                                >
                                  <FolderOpen size={16} />
                                </button>
                              </div>
                            </div>
                            <button
                              className="btn-primary flex items-center gap-2"
                              onClick={handleExtract}
                              disabled={selectedPkgs.size === 0}
                            >
                              <Archive size={14} />
                              开始提取 ({selectedPkgs.size} 个, ~{formatSize(selectedTotalSize)})
                            </button>
                          </div>
                        )}

                        {/* 提取进度 */}
                        {extracting && extractProgress && !extractProgress.done && (
                          <div className="pt-2 border-t border-[var(--glass-border)] space-y-2">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-[var(--coffee-deep)]">
                                提取进度: {extractProgress.current}/{extractProgress.total}
                              </span>
                              {extractProgress.lastSpeed && (
                                <span className="text-xs text-[var(--coffee-muted)]">{extractProgress.lastSpeed}</span>
                              )}
                            </div>
                            <div className="w-full h-2 bg-[var(--cream-warm)] rounded-full overflow-hidden">
                              <div
                                className="h-full bg-[var(--caramel)] rounded-full transition-all duration-300"
                                style={{ width: `${extractProgress.percent || 0}%` }}
                              />
                            </div>
                            {extractProgress.currentPkg && (
                              <div className="text-xs text-[var(--coffee-muted)] font-mono truncate">
                                {extractProgress.currentPkg}
                              </div>
                            )}
                            <button
                              className="px-4 py-1.5 rounded-xl text-sm font-medium bg-[var(--terracotta)] text-white hover:brightness-110 transition-all flex items-center gap-2"
                              onClick={handleCancelExtract}
                            >
                              <X size={14} />
                              取消提取
                            </button>
                          </div>
                        )}

                        {/* 提取完成 */}
                        {extractProgress?.done && (
                          <div className="pt-2 border-t border-[var(--glass-border)] space-y-2">
                            <div className="flex items-center gap-2 text-sm">
                              <span className="w-2 h-2 rounded-full bg-[var(--sage)]" />
                              <span className="text-[var(--coffee-deep)]">
                                提取完成: {extractProgress.success_count}/{extractProgress.total} 成功
                                {extractProgress.fail_count > 0 && (
                                  <span className="text-[var(--terracotta)]">，{extractProgress.fail_count} 失败</span>
                                )}
                              </span>
                            </div>
                            <div className="flex gap-2">
                              <button
                                className="btn-primary flex items-center gap-2"
                                onClick={handleOpenExtractDir}
                              >
                                <FolderOpen size={14} />
                                打开输出目录
                              </button>
                              <button
                                className="btn-secondary flex items-center gap-2"
                                onClick={() => setExtractProgress(null)}
                              >
                                继续提取
                              </button>
                            </div>
                          </div>
                        )}
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
