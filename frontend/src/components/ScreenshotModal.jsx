import { useState } from 'react'
import { Camera, Clipboard, Download, RefreshCw, X } from 'lucide-react'
import { useToast } from './Toast'

async function imageDataUrlToPngBlob(dataUrl) {
  const image = new Image()
  const loaded = new Promise((resolve, reject) => {
    image.onload = resolve
    image.onerror = () => reject(new Error('截图图片加载失败'))
  })
  image.src = dataUrl
  await loaded
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth || image.width
  canvas.height = image.naturalHeight || image.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前浏览器无法处理图片复制')
  context.drawImage(image, 0, 0)
  return await new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('截图图片转换失败')), 'image/png')
  })
}

export default function ScreenshotModal({ dataUrl, label, filename, width, onClose }) {
  const toast = useToast()
  const [copying, setCopying] = useState(false)

  const handleCopy = async () => {
    if (copying) return
    setCopying(true)
    try {
      if (!navigator.clipboard?.write || !window.ClipboardItem) {
        throw new Error('当前浏览器不支持直接复制图片，请使用下载或右键保存')
      }
      await navigator.clipboard.write([
        new window.ClipboardItem({ 'image/png': imageDataUrlToPngBlob(dataUrl) }),
      ])
      toast.success('截图已复制到剪贴板')
    } catch (error) {
      toast.error(error?.message || '复制截图失败')
    } finally {
      setCopying(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div className="glass-card p-4 max-w-[90vw] max-h-[90vh]"
        onMouseDown={event => event.stopPropagation()}
        onContextMenu={event => event.stopPropagation()}
        style={{ animation: 'slideUp 0.3s ease' }}>
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[var(--caramel)] to-[var(--caramel-light)] flex items-center justify-center">
              <Camera size={14} className="text-white" />
            </div>
            <h3 className="font-display text-sm font-semibold text-[var(--coffee-deep)] truncate">截图 · {label}</h3>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={handleCopy} disabled={copying}
              title={copying ? '正在复制图片' : '复制图片'} aria-label={copying ? '正在复制图片' : '复制图片'}
              className="p-2 rounded-lg hover:bg-[var(--cream-warm)] disabled:opacity-50 disabled:cursor-wait transition-colors text-[var(--coffee-muted)]">
              {copying ? <RefreshCw size={16} className="animate-spin" /> : <Clipboard size={16} />}
            </button>
            <a href={dataUrl} download={filename} title="下载截图" aria-label="下载截图"
              className="p-2 rounded-lg hover:bg-[var(--cream-warm)] transition-colors text-[var(--coffee-muted)]">
              <Download size={16} />
            </a>
            <button type="button" onClick={onClose} aria-label="关闭截图" title="关闭"
              className="p-2 rounded-lg hover:bg-[var(--cream-warm)] transition-colors text-[var(--coffee-muted)]">
              <X size={18} />
            </button>
          </div>
        </div>
        <img src={dataUrl} alt="客户端截图" className="rounded-lg max-h-[70vh] object-contain select-auto"
          style={{ width, maxWidth: '100%', height: 'auto' }} />
      </div>
    </div>
  )
}
