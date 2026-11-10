import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import RuntimeTree from './BehaviorTreeRuntime'

export default function RuntimeViewer({ snapshot, definition, labels, onClose }) {
  const dialogRef = useRef(null), titleId = useId()
  useEffect(() => {
    const previousFocus = document.activeElement, overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current.querySelector('button').focus()
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab') return
      const items = [...dialogRef.current.querySelectorAll('button,[tabindex="0"]')].filter(item => item.getClientRects().length && !item.disabled)
      const first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); previousFocus?.focus() }
  }, [])
  return createPortal(<div className="bt-workbench bt-viewer-overlay" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialogRef} className="bt-viewer-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header><div><h3 id={titleId}>{snapshot.tree.name || snapshot.treeId}</h3><small>{labels[snapshot.state] || snapshot.state} · 客户端实际运行树 · 只读实时查看</small></div><button aria-label="关闭放大查看" onClick={onClose}><X size={16}/>关闭</button></header>
      <RuntimeTree tree={snapshot.tree} definition={definition} snapshot={snapshot} labels={labels} enlarged/>
      <footer>滚轮缩放 · Shift+滚轮横移 · 拖动空白平移 · F 适应画布 · 0 还原 · Esc 关闭（不会停止运行）</footer>
    </section>
  </div>, document.body)
}
