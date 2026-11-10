import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clampZoom, fitZoom, zoomAnchor } from './treeViewport'

export default function useTreeViewport(ref, width, height, enabled = true) {
  const [zoom, setZoom] = useState(1)
  const current = useRef(zoom), anchor = useRef(null), pan = useRef(null)
  current.current = zoom
  function changeZoom(value, point) {
    const box = ref.current, next = clampZoom(value)
    if (!box || next === current.current) return
    const at = point || { x: box.clientWidth / 2, y: box.clientHeight / 2 }
    anchor.current = { x: zoomAnchor(box.scrollLeft, at.x, current.current, next), y: zoomAnchor(box.scrollTop, at.y, current.current, next) }
    current.current = next
    setZoom(next)
  }
  useLayoutEffect(() => {
    if (anchor.current && ref.current) {
      ref.current.scrollTo(anchor.current.x, anchor.current.y)
      anchor.current = null
    }
  }, [zoom])
  useEffect(() => {
    const box = ref.current
    if (!enabled || !box) return
    const wheel = event => {
      if (event.shiftKey) return // 保留 Shift+滚轮横向滚动。
      event.preventDefault()
      const rect = box.getBoundingClientRect()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.clientHeight : 1)
      changeZoom(current.current * Math.exp(-Math.max(-400, Math.min(400, delta)) * .002), { x: event.clientX - rect.left, y: event.clientY - rect.top })
    }
    box.addEventListener('wheel', wheel, { passive: false })
    return () => box.removeEventListener('wheel', wheel)
  }, [enabled, ref])
  function fit() {
    const box = ref.current
    if (!box) return
    anchor.current = { x: 0, y: 0 }
    const next = fitZoom(width, height, box.clientWidth - 24, box.clientHeight - 24)
    current.current = next; setZoom(next); box.scrollTo(0, 0)
  }
  const handlers = {
    onPointerDown(event) {
      if (event.button !== 0 || event.target.closest('.bt-node,.bt-edge-hit,button,input')) return
      const box = ref.current
      box.setPointerCapture(event.pointerId)
      pan.current = { x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop }
      box.dataset.panning = 'true'
    },
    onPointerMove(event) {
      if (!pan.current) return
      ref.current.scrollTo(pan.current.left - event.clientX + pan.current.x, pan.current.top - event.clientY + pan.current.y)
    },
    onPointerUp() { pan.current = null; if (ref.current) delete ref.current.dataset.panning },
    onPointerCancel() { pan.current = null; if (ref.current) delete ref.current.dataset.panning },
    onKeyDown(event) {
      if (event.target !== ref.current) return
      if (event.key === '+' || event.key === '=') changeZoom(current.current * 1.2)
      else if (event.key === '-') changeZoom(current.current / 1.2)
      else if (event.key === '0') changeZoom(1)
      else if (event.key.toLowerCase() === 'f') fit()
      else return
      event.preventDefault()
    }
  }
  return { zoom, changeZoom, fit, handlers }
}
