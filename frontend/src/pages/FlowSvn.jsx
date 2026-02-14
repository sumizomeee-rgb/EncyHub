import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Plus, Play, Trash2, Edit, Clock, FolderGit2, X, Loader2,
  GitBranch, Calendar, CheckCircle, XCircle, Layers, Zap, ChevronUp, ChevronDown,
  FileText, History
} from 'lucide-react'
import { useToast } from '../components/Toast'

// 触发动作类型
const ACTION_TYPES = [
  { value: 'noop', label: '无操作', desc: '占位符，不执行任何操作' },
  { value: 'kill_process', label: '结束进程', desc: '结束指定进程' },
  { value: 'start_exe', label: '启动程序', desc: '启动可执行文件' },
  { value: 'unity_project', label: 'Unity 项目', desc: '打开 Unity 项目' },
  { value: 'open_directory', label: '打开目录', desc: '在资源管理器中打开' },
  { value: 'focus_window', label: '聚焦窗口', desc: '将窗口置于前台' },
  { value: 'touch_file', label: '触摸文件', desc: '更新文件修改时间' },
  { value: 'shutdown', label: '关机', desc: '关闭计算机' },
  { value: 'restart', label: '重启', desc: '重启计算机' },
]

function FlowSvn() {
  const navigate = useNavigate()
  const toast = useToast()
  const [tasks, setTasks] = useState([])
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)

  // 任务弹窗
  const [showTaskModal, setShowTaskModal] = useState(false)
  const [editingTask, setEditingTask] = useState(null)
  const [taskForm, setTaskForm] = useState({
    name: '',
    svn_path: '',
    schedule_time: '08:00',
    template_id: '',
    enabled: true,
  })

  // 模板弹窗
  const [showTemplateModal, setShowTemplateModal] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState(null)
  const [templateForm, setTemplateForm] = useState({
    name: '',
    actions: [],
  })

  // 执行状态
  const [runningTasks, setRunningTasks] = useState({})

  // 日志/历史弹窗
  const [showLogModal, setShowLogModal] = useState(false)
  const [logModalContent, setLogModalContent] = useState('')
  const [logModalTitle, setLogModalTitle] = useState('')
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const [historyModalData, setHistoryModalData] = useState([])
  const [historyModalTitle, setHistoryModalTitle] = useState('')

  const fetchData = async () => {
    try {
      const [tasksRes, templatesRes] = await Promise.all([
        fetch('/api/flow_svn/tasks'),
        fetch('/api/flow_svn/templates'),
      ])
      if (tasksRes.ok) {
        const data = await tasksRes.json()
        setTasks(data.tasks || [])
      }
      if (templatesRes.ok) {
        const data = await templatesRes.json()
        setTemplates(data.templates || [])
      }
    } catch (err) {
      console.error('获取数据失败:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { document.title = 'FlowSVN - EncyHub' }, [])

  useEffect(() => {
    fetchData()
  }, [])

  // 创建/编辑任务
  const handleSaveTask = async () => {
    if (!taskForm.name.trim() || !taskForm.svn_path.trim()) {
      toast.warning('请填写任务名称和 SVN 路径')
      return
    }
    try {
      const url = editingTask
        ? `/api/flow_svn/tasks/${editingTask.id}`
        : '/api/flow_svn/tasks'
      const method = editingTask ? 'PUT' : 'POST'

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(taskForm),
      })
      if (res.ok) {
        setShowTaskModal(false)
        setEditingTask(null)
        setTaskForm({ name: '', svn_path: '', schedule_time: '08:00', template_id: '', enabled: true })
        fetchData()
      } else {
        const data = await res.json()
        toast.error(data.detail || '保存失败')
      }
    } catch (err) {
      toast.error('保存失败: ' + err.message)
    }
  }

  // 删除任务
  const handleDeleteTask = async (task) => {
    if (!confirm(`确定删除任务 "${task.name}"？`)) return
    try {
      const res = await fetch(`/api/flow_svn/tasks/${task.id}`, { method: 'DELETE' })
      if (res.ok) {
        fetchData()
        toast.success('任务已删除')
      } else {
        const data = await res.json()
        toast.error(data.detail || '删除失败')
      }
    } catch (err) {
      toast.error('删除失败: ' + err.message)
    }
  }

  // 立即执行任务
  const handleRunTask = async (task) => {
    setRunningTasks(prev => ({ ...prev, [task.id]: true }))
    try {
      const res = await fetch(`/api/flow_svn/tasks/${task.id}/run`, { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        toast.success(`执行成功${data.output ? ': ' + data.output.substring(0, 100) : ''}`)
      } else {
        toast.error(`执行失败: ${data.message || ''}`)
      }
      fetchData()
    } catch (err) {
      toast.error('执行失败: ' + err.message)
    } finally {
      setRunningTasks(prev => ({ ...prev, [task.id]: false }))
    }
  }

  // 编辑任务
  const handleEditTask = (task) => {
    setEditingTask(task)
    setTaskForm({
      name: task.name,
      svn_path: task.svn_path,
      schedule_time: task.schedule_time,
      template_id: task.template_id || '',
      enabled: task.enabled,
    })
    setShowTaskModal(true)
  }

  // 创建/编辑模板
  const handleSaveTemplate = async () => {
    if (!templateForm.name.trim()) {
      toast.warning('请填写模板名称')
      return
    }
    try {
      const url = editingTemplate
        ? `/api/flow_svn/templates/${editingTemplate.id}`
        : '/api/flow_svn/templates'
      const method = editingTemplate ? 'PUT' : 'POST'

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(templateForm),
      })
      if (res.ok) {
        setShowTemplateModal(false)
        setEditingTemplate(null)
        setTemplateForm({ name: '', actions: [] })
        fetchData()
      } else {
        const data = await res.json()
        toast.error(data.detail || '保存失败')
      }
    } catch (err) {
      toast.error('保存失败: ' + err.message)
    }
  }

  // 删除模板
  const handleDeleteTemplate = async (template) => {
    if (!confirm(`确定删除模板 "${template.name}"？`)) return
    try {
      const res = await fetch(`/api/flow_svn/templates/${template.id}`, { method: 'DELETE' })
      if (res.ok) {
        fetchData()
      } else {
        const data = await res.json()
        toast.error(data.detail || '删除失败')
      }
    } catch (err) {
      toast.error('删除失败: ' + err.message)
    }
  }

  // 添加动作到模板
  const addAction = () => {
    setTemplateForm(prev => ({
      ...prev,
      actions: [...prev.actions, { type: 'noop', target: '', path: '', args: '' }]
    }))
  }

  // 更新动作
  const updateAction = (index, field, value) => {
    setTemplateForm(prev => ({
      ...prev,
      actions: prev.actions.map((a, i) => i === index ? { ...a, [field]: value } : a)
    }))
  }

  // 删除动作
  const removeAction = (index) => {
    setTemplateForm(prev => ({
      ...prev,
      actions: prev.actions.filter((_, i) => i !== index)
    }))
  }

  // 动作上移
  const moveActionUp = (index) => {
    if (index <= 0) return
    setTemplateForm(prev => {
      const actions = [...prev.actions]
      ;[actions[index - 1], actions[index]] = [actions[index], actions[index - 1]]
      return { ...prev, actions }
    })
  }

  // 动作下移
  const moveActionDown = (index) => {
    setTemplateForm(prev => {
      if (index >= prev.actions.length - 1) return prev
      const actions = [...prev.actions]
      ;[actions[index], actions[index + 1]] = [actions[index + 1], actions[index]]
      return { ...prev, actions }
    })
  }

  // 任务启用/禁用快捷切换
  const handleToggleEnabled = async (task) => {
    try {
      const res = await fetch(`/api/flow_svn/tasks/${task.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !task.enabled }),
      })
      if (res.ok) {
        fetchData()
      } else {
        const data = await res.json()
        toast.error(data.detail || '切换失败')
      }
    } catch (err) {
      toast.error('切换失败: ' + err.message)
    }
  }

  // 查看任务日志
  const handleViewLog = (task) => {
    setLogModalTitle(`${task.name} - 执行日志`)
    setLogModalContent(task.last_log || '暂无日志')
    setShowLogModal(true)
  }

  // 查看执行历史
  const handleViewHistory = (task) => {
    setHistoryModalTitle(`${task.name} - 执行历史`)
    setHistoryModalData(task.execution_history || [])
    setShowHistoryModal(true)
  }

  // 获取状态样式
  const getStatusStyle = (status) => {
    switch (status) {
      case 'success': return { bg: 'bg-[var(--success-soft)]', text: 'text-[var(--sage)]', icon: CheckCircle }
      case 'failed': return { bg: 'bg-[var(--error-soft)]', text: 'text-[var(--terracotta)]', icon: XCircle }
      case 'running': return { bg: 'bg-[var(--warning-soft)]', text: 'text-[var(--amber)]', icon: Loader2 }
      default: return { bg: 'bg-[var(--cream-warm)]', text: 'text-[var(--coffee-muted)]', icon: Clock }
    }
  }

  return (
    <div className="min-h-screen">
      {/* Top Bar */}
      <header className="sticky top-0 z-50 bg-[var(--glass-bg)] backdrop-blur-xl border-b border-[var(--glass-border)] px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center gap-4">
          <button
            className="btn-secondary p-2.5"
            onClick={() => navigate('/')}
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <h1 className="font-display text-2xl font-semibold text-[var(--coffee-deep)]">
              FlowSVN
            </h1>
            <p className="text-[var(--coffee-muted)] text-sm">SVN 定时更新 + 触发器自动化</p>
          </div>
          <button
            className="btn-primary flex items-center gap-2"
            onClick={() => {
              setEditingTask(null)
              setTaskForm({ name: '', svn_path: '', schedule_time: '08:00', template_id: '', enabled: true })
              setShowTaskModal(true)
            }}
          >
            <Plus size={16} />
            新建任务
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="spinner" />
          </div>
        ) : (
          <div className="space-y-8">
            {/* Tasks Section */}
            <section className="animate-fade-in">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--caramel)] to-[var(--caramel-dark)] flex items-center justify-center">
                  <GitBranch size={16} className="text-white" />
                </div>
                <h2 className="font-display text-lg font-semibold text-[var(--coffee-deep)]">
                  任务列表
                </h2>
                <span className="text-xs text-[var(--coffee-muted)] ml-2">
                  {tasks.length} 个任务
                </span>
              </div>

              {tasks.length === 0 ? (
                <div className="glass-card p-12 text-center">
                  <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-[var(--cream-warm)] flex items-center justify-center">
                    <FolderGit2 size={40} className="text-[var(--coffee-muted)]" />
                  </div>
                  <h3 className="font-display text-xl text-[var(--coffee-deep)] mb-2">暂无任务</h3>
                  <p className="text-[var(--coffee-muted)] max-w-md mx-auto">
                    点击"新建任务"创建 SVN 定时更新任务
                  </p>
                </div>
              ) : (
                <div className="glass-card overflow-hidden">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>任务名称</th>
                        <th>SVN 路径</th>
                        <th>计划时间</th>
                        <th>触发模板</th>
                        <th>上次执行</th>
                        <th>状态</th>
                        <th className="text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tasks.map(task => {
                        const statusStyle = getStatusStyle(task.last_status)
                        const StatusIcon = statusStyle.icon
                        const template = templates.find(t => t.id === task.template_id)
                        return (
                          <tr key={task.id}>
                            <td>
                              <div className="flex items-center gap-2">
                                <button
                                  className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${task.enabled ? 'bg-[var(--sage)]' : 'bg-[var(--coffee-muted)]/40'}`}
                                  onClick={() => handleToggleEnabled(task)}
                                  title={task.enabled ? '点击禁用' : '点击启用'}
                                >
                                  <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${task.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                </button>
                                <span className="font-medium text-[var(--coffee-deep)]">{task.name}</span>
                              </div>
                            </td>
                            <td>
                              <code className="text-xs bg-[var(--cream-warm)] px-2 py-1 rounded font-mono text-[var(--coffee-light)]">
                                {task.svn_path}
                              </code>
                            </td>
                            <td>
                              <div className="flex items-center gap-2 text-[var(--coffee-light)]">
                                <Calendar size={14} />
                                {task.schedule_time}
                              </div>
                            </td>
                            <td>
                              {template ? (
                                <span className="badge">{template.name}</span>
                              ) : (
                                <span className="text-[var(--coffee-muted)] text-sm">无</span>
                              )}
                            </td>
                            <td>
                              <span className="text-xs text-[var(--coffee-muted)] font-mono">
                                {task.last_run || '—'}
                              </span>
                            </td>
                            <td>
                              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${statusStyle.bg} ${statusStyle.text}`}>
                                <StatusIcon size={12} className={task.last_status === 'running' ? 'animate-spin' : ''} />
                                {task.last_status === 'success' ? '成功' :
                                 task.last_status === 'failed' ? '失败' :
                                 task.last_status === 'running' ? '运行中' : '待执行'}
                              </span>
                            </td>
                            <td>
                              <div className="flex items-center justify-end gap-1">
                                <button
                                  className="p-2 rounded-lg hover:bg-[var(--cream-warm)] text-[var(--sage)] transition-colors"
                                  title="立即执行"
                                  onClick={() => handleRunTask(task)}
                                  disabled={runningTasks[task.id]}
                                >
                                  {runningTasks[task.id] ? (
                                    <Loader2 size={16} className="animate-spin" />
                                  ) : (
                                    <Play size={16} />
                                  )}
                                </button>
                                <button
                                  className="p-2 rounded-lg hover:bg-[var(--cream-warm)] text-[var(--sky)] transition-colors"
                                  title="执行日志"
                                  onClick={() => handleViewLog(task)}
                                >
                                  <FileText size={16} />
                                </button>
                                <button
                                  className="p-2 rounded-lg hover:bg-[var(--cream-warm)] text-[var(--amber)] transition-colors"
                                  title="执行历史"
                                  onClick={() => handleViewHistory(task)}
                                >
                                  <History size={16} />
                                </button>
                                <button
                                  className="p-2 rounded-lg hover:bg-[var(--cream-warm)] text-[var(--coffee-light)] transition-colors"
                                  title="编辑"
                                  onClick={() => handleEditTask(task)}
                                >
                                  <Edit size={16} />
                                </button>
                                <button
                                  className="p-2 rounded-lg hover:bg-[var(--error-soft)] text-[var(--terracotta)] transition-colors"
                                  title="删除"
                                  onClick={() => handleDeleteTask(task)}
                                >
                                  <Trash2 size={16} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Templates Section */}
            <section className="animate-fade-in" style={{ animationDelay: '0.1s' }}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--sky)] to-[var(--sky-soft)] flex items-center justify-center">
                    <Layers size={16} className="text-white" />
                  </div>
                  <h2 className="font-display text-lg font-semibold text-[var(--coffee-deep)]">
                    触发模板
                  </h2>
                  <span className="text-xs text-[var(--coffee-muted)] ml-2">
                    {templates.length} 个模板
                  </span>
                </div>
                <button
                  className="btn-secondary flex items-center gap-2"
                  onClick={() => {
                    setEditingTemplate(null)
                    setTemplateForm({ name: '', actions: [] })
                    setShowTemplateModal(true)
                  }}
                >
                  <Plus size={16} />
                  新建模板
                </button>
              </div>

              {templates.length === 0 ? (
                <div className="glass-card p-8 text-center text-[var(--coffee-muted)]">
                  暂无模板，点击"新建模板"创建触发动作模板
                </div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {templates.map(template => (
                    <div
                      key={template.id}
                      className="glass-card p-4 cursor-pointer group relative hover:border-[var(--caramel-light)] transition-all"
                      onClick={() => {
                        setEditingTemplate(template)
                        setTemplateForm({
                          name: template.name,
                          actions: template.actions || [],
                        })
                        setShowTemplateModal(true)
                      }}
                    >
                      <button
                        className="absolute top-2 right-2 p-1.5 rounded-lg text-[var(--coffee-muted)] hover:text-[var(--terracotta)] hover:bg-[var(--error-soft)] opacity-0 group-hover:opacity-100 transition-all"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDeleteTemplate(template)
                        }}
                        title="删除模板"
                      >
                        <Trash2 size={14} />
                      </button>
                      <div className="w-10 h-10 rounded-lg bg-[var(--cream-warm)] flex items-center justify-center mb-3">
                        <Zap size={18} className="text-[var(--caramel)]" />
                      </div>
                      <div className="font-medium text-[var(--coffee-deep)]">{template.name}</div>
                      <div className="text-xs text-[var(--coffee-muted)] mt-1">
                        {template.actions?.length || 0} 个动作
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </main>

      {/* Task Modal */}
      {showTaskModal && (
        <div className="modal-overlay" onClick={() => setShowTaskModal(false)}>
          <div
            className="glass-card p-6 w-[500px] animate-fade-in"
            style={{ animation: 'slideUp 0.3s ease' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-[var(--caramel)] to-[var(--caramel-dark)] flex items-center justify-center">
                  <GitBranch size={20} className="text-white" />
                </div>
                <h3 className="font-display text-lg font-semibold">
                  {editingTask ? '编辑任务' : '新建任务'}
                </h3>
              </div>
              <button
                onClick={() => setShowTaskModal(false)}
                className="p-2 rounded-lg hover:bg-[var(--cream-warm)] transition-colors text-[var(--coffee-muted)]"
              >
                <X size={20} />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-[var(--coffee-light)] mb-2">任务名称</label>
                <input
                  type="text"
                  value={taskForm.name}
                  onChange={e => setTaskForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="例如：每日更新美术资源"
                />
              </div>
              <div>
                <label className="block text-sm text-[var(--coffee-light)] mb-2">SVN 路径</label>
                <input
                  type="text"
                  className="font-mono text-sm"
                  value={taskForm.svn_path}
                  onChange={e => setTaskForm(prev => ({ ...prev, svn_path: e.target.value }))}
                  placeholder="D:\Projects\MyGame\Art"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-[var(--coffee-light)] mb-2">计划时间</label>
                  <input
                    type="time"
                    value={taskForm.schedule_time}
                    onChange={e => setTaskForm(prev => ({ ...prev, schedule_time: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-sm text-[var(--coffee-light)] mb-2">触发模板</label>
                  <select
                    value={taskForm.template_id}
                    onChange={e => setTaskForm(prev => ({ ...prev, template_id: e.target.value }))}
                  >
                    <option value="">无</option>
                    {templates.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 bg-[var(--cream-warm)]/50 rounded-lg">
                <input
                  type="checkbox"
                  id="task-enabled"
                  checked={taskForm.enabled}
                  onChange={e => setTaskForm(prev => ({ ...prev, enabled: e.target.checked }))}
                />
                <label htmlFor="task-enabled" className="text-sm text-[var(--coffee-deep)]">
                  启用任务（按计划时间自动执行）
                </label>
              </div>
              <div className="flex gap-3 pt-2">
                <button className="btn-secondary flex-1" onClick={() => setShowTaskModal(false)}>
                  取消
                </button>
                <button className="btn-primary flex-1" onClick={handleSaveTask}>
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Log Modal */}
      {showLogModal && (
        <div className="modal-overlay" onClick={() => setShowLogModal(false)}>
          <div
            className="glass-card p-6 w-[600px] max-h-[70vh] animate-fade-in"
            style={{ animation: 'slideUp 0.3s ease' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-[var(--sky)] to-[var(--sky-soft)] flex items-center justify-center">
                  <FileText size={20} className="text-white" />
                </div>
                <h3 className="font-display text-lg font-semibold">{logModalTitle}</h3>
              </div>
              <button
                onClick={() => setShowLogModal(false)}
                className="p-2 rounded-lg hover:bg-[var(--cream-warm)] transition-colors text-[var(--coffee-muted)]"
              >
                <X size={20} />
              </button>
            </div>
            <pre className="bg-[var(--coffee-deep)] text-[var(--sage)] rounded-xl p-4 text-xs font-mono leading-relaxed overflow-auto max-h-[50vh] whitespace-pre-wrap">
              {logModalContent}
            </pre>
          </div>
        </div>
      )}

      {/* History Modal */}
      {showHistoryModal && (
        <div className="modal-overlay" onClick={() => setShowHistoryModal(false)}>
          <div
            className="glass-card p-6 w-[650px] max-h-[70vh] animate-fade-in"
            style={{ animation: 'slideUp 0.3s ease' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-[var(--amber)] to-[var(--honey)] flex items-center justify-center">
                  <History size={20} className="text-white" />
                </div>
                <h3 className="font-display text-lg font-semibold">{historyModalTitle}</h3>
              </div>
              <button
                onClick={() => setShowHistoryModal(false)}
                className="p-2 rounded-lg hover:bg-[var(--cream-warm)] transition-colors text-[var(--coffee-muted)]"
              >
                <X size={20} />
              </button>
            </div>
            {historyModalData.length === 0 ? (
              <div className="text-center text-[var(--coffee-muted)] py-8">暂无执行历史</div>
            ) : (
              <div className="space-y-2 max-h-[50vh] overflow-auto">
                {historyModalData.map((entry, i) => (
                  <div key={i} className={`p-3 rounded-lg text-sm ${
                    entry.status === 'success'
                      ? 'bg-[var(--success-soft)] border-l-3 border-[var(--sage)]'
                      : 'bg-[var(--error-soft)] border-l-3 border-[var(--terracotta)]'
                  }`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className={`font-medium ${
                        entry.status === 'success' ? 'text-[var(--sage)]' : 'text-[var(--terracotta)]'
                      }`}>
                        {entry.status === 'success' ? '成功' : '失败'}
                      </span>
                      <span className="text-xs text-[var(--coffee-muted)]">{entry.time}</span>
                    </div>
                    {entry.message && (
                      <div className="text-xs text-[var(--coffee-light)] mt-1 font-mono truncate">
                        {entry.message}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Template Modal */}
      {showTemplateModal && (
        <div className="modal-overlay" onClick={() => setShowTemplateModal(false)}>
          <div
            className="glass-card p-6 w-[600px] max-h-[80vh] overflow-auto animate-fade-in"
            style={{ animation: 'slideUp 0.3s ease' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-[var(--sky)] to-[var(--sky-soft)] flex items-center justify-center">
                  <Layers size={20} className="text-white" />
                </div>
                <h3 className="font-display text-lg font-semibold">
                  {editingTemplate ? '编辑模板' : '新建模板'}
                </h3>
              </div>
              <button
                onClick={() => setShowTemplateModal(false)}
                className="p-2 rounded-lg hover:bg-[var(--cream-warm)] transition-colors text-[var(--coffee-muted)]"
              >
                <X size={20} />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-[var(--coffee-light)] mb-2">模板名称</label>
                <input
                  type="text"
                  value={templateForm.name}
                  onChange={e => setTemplateForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="例如：构建并部署"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-3">
                  <label className="text-sm text-[var(--coffee-light)]">触发动作</label>
                  <button
                    className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1"
                    onClick={addAction}
                  >
                    <Plus size={14} />
                    添加动作
                  </button>
                </div>

                {templateForm.actions.length === 0 ? (
                  <div className="p-6 bg-[var(--cream-warm)]/50 rounded-lg text-center text-[var(--coffee-muted)] text-sm">
                    暂无动作，点击"添加动作"开始配置
                  </div>
                ) : (
                  <div className="space-y-3">
                    {templateForm.actions.map((action, index) => (
                      <div key={index} className="p-4 bg-[var(--cream-warm)]/50 rounded-lg">
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-xs font-medium text-[var(--coffee-muted)]">
                            动作 #{index + 1}
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              className="p-1 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] transition-colors disabled:opacity-30"
                              onClick={() => moveActionUp(index)}
                              disabled={index === 0}
                              title="上移"
                            >
                              <ChevronUp size={14} />
                            </button>
                            <button
                              className="p-1 rounded hover:bg-[var(--cream-warm)] text-[var(--coffee-muted)] transition-colors disabled:opacity-30"
                              onClick={() => moveActionDown(index)}
                              disabled={index === templateForm.actions.length - 1}
                              title="下移"
                            >
                              <ChevronDown size={14} />
                            </button>
                            <button
                              className="p-1 rounded hover:bg-[var(--error-soft)] text-[var(--terracotta)] transition-colors"
                              onClick={() => removeAction(index)}
                              title="删除"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs text-[var(--coffee-muted)] mb-1">类型</label>
                            <select
                              value={action.type}
                              onChange={e => updateAction(index, 'type', e.target.value)}
                              className="text-sm"
                            >
                              {ACTION_TYPES.map(t => (
                                <option key={t.value} value={t.value}>{t.label}</option>
                              ))}
                            </select>
                          </div>
                          {['kill_process', 'focus_window'].includes(action.type) && (
                            <div>
                              <label className="block text-xs text-[var(--coffee-muted)] mb-1">目标进程</label>
                              <input
                                type="text"
                                value={action.target || ''}
                                onChange={e => updateAction(index, 'target', e.target.value)}
                                placeholder="进程名称"
                                className="text-sm"
                              />
                            </div>
                          )}
                          {['start_exe', 'unity_project', 'open_directory', 'touch_file'].includes(action.type) && (
                            <div>
                              <label className="block text-xs text-[var(--coffee-muted)] mb-1">路径</label>
                              <input
                                type="text"
                                value={action.path || ''}
                                onChange={e => updateAction(index, 'path', e.target.value)}
                                placeholder="文件或目录路径"
                                className="text-sm font-mono"
                              />
                            </div>
                          )}
                          {action.type === 'start_exe' && (
                            <div className="col-span-2">
                              <label className="block text-xs text-[var(--coffee-muted)] mb-1">启动参数</label>
                              <input
                                type="text"
                                value={action.args || ''}
                                onChange={e => updateAction(index, 'args', e.target.value)}
                                placeholder="可选参数"
                                className="text-sm font-mono"
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex gap-3 pt-2">
                <button className="btn-secondary flex-1" onClick={() => setShowTemplateModal(false)}>
                  取消
                </button>
                <button className="btn-primary flex-1" onClick={handleSaveTemplate}>
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default FlowSvn
