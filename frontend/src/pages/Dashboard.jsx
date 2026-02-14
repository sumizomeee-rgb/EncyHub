import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Play, Square, RotateCcw, ExternalLink, Sparkles, Smartphone, GitBranch, Terminal, Hammer, RefreshCw, Power } from 'lucide-react'
import { useToast } from '../components/Toast'

const API_BASE = '/api/hub'

const toolIcons = {
  adb_master: Smartphone,
  flow_svn: GitBranch,
  gm_console: Terminal,
}

function Dashboard() {
  const [tools, setTools] = useState([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState({})
  const [buildLoading, setBuildLoading] = useState(false)
  const [restartLoading, setRestartLoading] = useState(false)
  const [shutdownLoading, setShutdownLoading] = useState(false)
  const navigate = useNavigate()
  const toast = useToast()

  const handleRestartHub = async () => {
    if (!confirm('确定要重启整个平台吗？这会中断当前的连接。')) return
    setRestartLoading(true)
    try {
      const res = await fetch(`${API_BASE}/restart-hub`, { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        toast.success('平台正在重启，请稍候刷新页面...')
        setTimeout(() => window.location.reload(), 3000)
      } else {
        toast.error(data.message || '重启失败')
        setRestartLoading(false)
      }
    } catch (err) {
      toast.error('请求失败: ' + err.message)
      setRestartLoading(false)
    }
  }

  const handleShutdown = async () => {
    if (!confirm('确定要停止整个平台吗？所有工具进程都会被关闭。')) return
    setShutdownLoading(true)
    try {
      await fetch(`${API_BASE}/shutdown`, { method: 'POST' })
      toast.success('平台正在安全关闭...')
    } catch (err) {
      // 连接断开说明已经在关闭了
      toast.success('平台已关闭')
    }
  }

  const handleBuildFrontend = async () => {
    setBuildLoading(true)
    try {
      const res = await fetch(`${API_BASE}/build-frontend`, { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        toast.success('前端编译成功，刷新页面即可生效')
      } else {
        toast.error(data.message || '编译失败')
      }
    } catch (err) {
      toast.error('编译请求失败: ' + err.message)
    } finally {
      setBuildLoading(false)
    }
  }

  const fetchTools = async () => {
    try {
      const res = await fetch(`${API_BASE}/tools`)
      const data = await res.json()
      setTools(data.tools || [])
    } catch (err) {
      console.error('获取工具列表失败:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { document.title = 'EncyHub' }, [])

  useEffect(() => {
    fetchTools()
    const interval = setInterval(fetchTools, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleAction = async (toolId, action) => {
    setActionLoading(prev => ({ ...prev, [toolId]: action }))
    try {
      const res = await fetch(`${API_BASE}/tools/${toolId}/${action}`, {
        method: 'POST',
      })
      if (!res.ok) {
        const err = await res.json()
        toast.error(err.detail || '操作失败')
      }
      await fetchTools()
    } catch (err) {
      toast.error('操作失败: ' + err.message)
    } finally {
      setActionLoading(prev => ({ ...prev, [toolId]: null }))
    }
  }

  const openTool = (toolId) => {
    window.open(`/${toolId}`, '_blank')
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="spinner" />
      </div>
    )
  }

  return (
    <div className="min-h-screen">
      {/* Hero Header */}
      <header className="relative overflow-hidden py-16 px-8">
        <div className="absolute inset-0 bg-gradient-to-br from-[var(--caramel-light)] via-transparent to-[var(--amber-soft)] opacity-20" />
        <div className="relative max-w-6xl mx-auto">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[var(--caramel)] to-[var(--caramel-dark)] flex items-center justify-center shadow-lg">
              <Sparkles className="text-white" size={24} />
            </div>
            <div>
              <h1 className="font-display text-4xl font-semibold text-[var(--coffee-deep)]">EncyHub</h1>
              <p className="text-[var(--coffee-light)]">开发工具聚合平台</p>
            </div>
          </div>
          <p className="text-[var(--coffee-muted)] max-w-xl mt-4">
            集成 ADB 设备管理、SVN 自动化、GM 控制台等开发工具，提供统一的管理界面和 API 接口。
          </p>

          <div className="mt-5 flex gap-3">
            <button
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium
                         bg-[var(--cream-soft)] border border-[var(--glass-border)] text-[var(--coffee-medium)]
                         hover:border-[var(--caramel-light)] hover:text-[var(--coffee-deep)] hover:shadow-md hover:shadow-[var(--caramel)]/10
                         active:scale-[0.97] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleBuildFrontend}
              disabled={buildLoading || restartLoading || shutdownLoading}
            >
              {buildLoading
                ? <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                : <Hammer size={14} />
              }
              {buildLoading ? '编译中...' : '编译前端'}
            </button>

            <button
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium
                         bg-[var(--cream-soft)] border border-[var(--glass-border)] text-[var(--coffee-medium)]
                         hover:border-[var(--terracotta)] hover:text-[var(--terracotta)] hover:bg-[var(--error-soft)]/30 hover:shadow-md hover:shadow-[var(--terracotta)]/10
                         active:scale-[0.97] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleRestartHub}
              disabled={buildLoading || restartLoading || shutdownLoading}
            >
              <RefreshCw size={14} className={restartLoading ? 'animate-spin' : ''} />
              {restartLoading ? '重启中...' : '重启平台'}
            </button>

            <button
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium
                         bg-[var(--cream-soft)] border border-[var(--glass-border)] text-[var(--coffee-medium)]
                         hover:border-red-500 hover:text-red-600 hover:bg-red-50 hover:shadow-md hover:shadow-red-500/10
                         active:scale-[0.97] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleShutdown}
              disabled={buildLoading || restartLoading || shutdownLoading}
            >
              <Power size={14} />
              {shutdownLoading ? '关闭中...' : '停止平台'}
            </button>
          </div>
        </div>
      </header>

      {/* Tool Cards */}
      <main className="px-8 pb-16 -mt-4">
        <div className="max-w-6xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {tools.map((tool, index) => {
              const Icon = toolIcons[tool.tool_id] || Sparkles
              return (
                <div
                  key={tool.tool_id}
                  className="glass-card p-6 animate-fade-in group"
                  style={{ animationDelay: `${index * 0.1}s` }}
                >
                  {/* Tool Header */}
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
                        tool.running
                          ? 'bg-gradient-to-br from-[var(--caramel)] to-[var(--caramel-dark)] shadow-md'
                          : 'bg-[var(--cream-warm)]'
                      }`}>
                        <Icon size={20} className={tool.running ? 'text-white' : 'text-[var(--coffee-muted)]'} />
                      </div>
                      <div>
                        <h2 className="font-display text-xl font-semibold text-[var(--coffee-deep)]">
                          {tool.display_name}
                        </h2>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className={`status-dot ${tool.running ? 'running' : 'stopped'}`} />
                          <span className="text-xs text-[var(--coffee-muted)]">
                            {tool.running ? `端口 ${tool.port}` : '已停止'}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Description */}
                  <p className="text-[var(--coffee-light)] text-base mb-5 leading-relaxed">
                    {tool.description}
                  </p>

                  {/* Actions */}
                  <div className="flex gap-2 flex-wrap">
                    {tool.running ? (
                      <>
                        <button
                          className="btn-primary flex items-center gap-2 flex-1"
                          onClick={() => openTool(tool.tool_id)}
                        >
                          <ExternalLink size={16} />
                          打开
                        </button>
                        <button
                          className="btn-secondary p-2.5"
                          onClick={() => handleAction(tool.tool_id, 'restart')}
                          disabled={actionLoading[tool.tool_id]}
                          title="重启"
                        >
                          <RotateCcw size={16} className={actionLoading[tool.tool_id] === 'restart' ? 'animate-spin' : ''} />
                        </button>
                        <button
                          className="btn-danger p-2.5"
                          onClick={() => handleAction(tool.tool_id, 'stop')}
                          disabled={actionLoading[tool.tool_id]}
                          title="停止"
                        >
                          <Square size={16} />
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn-primary flex items-center gap-2 w-full justify-center"
                        onClick={() => handleAction(tool.tool_id, 'start')}
                        disabled={actionLoading[tool.tool_id]}
                      >
                        {actionLoading[tool.tool_id] === 'start' ? (
                          <div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                        ) : (
                          <Play size={16} />
                        )}
                        {actionLoading[tool.tool_id] === 'start' ? '启动中...' : '启动工具'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="py-8 text-center border-t border-[var(--glass-border)]">
        <p className="text-[var(--coffee-muted)] text-sm">
          EncyHub v1.0.0 · {tools.filter(t => t.running).length}/{tools.length} 工具运行中 ·
          <a href="/docs" className="text-[var(--caramel)] hover:text-[var(--caramel-dark)] ml-1 transition-colors">
            API 文档
          </a>
        </p>
      </footer>
    </div>
  )
}

export default Dashboard
