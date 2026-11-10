import { Maximize, Minus, Plus } from 'lucide-react'

export default function ViewportTools({ viewport }) {
  return <div className="bt-hud bt-hud-br" aria-label="画布缩放">
    <button className="bt-icon-btn" aria-label="缩小" onClick={() => viewport.changeZoom(viewport.zoom / 1.2)}><Minus size={13}/></button>
    <button className="bt-zoom-value" title="重置为100%（0）" onClick={() => viewport.changeZoom(1)}>{Math.round(viewport.zoom * 100)}%</button>
    <button className="bt-icon-btn" aria-label="放大" onClick={() => viewport.changeZoom(viewport.zoom * 1.2)}><Plus size={13}/></button>
    <button className="bt-icon-btn" aria-label="适应画布" title="适应画布（F）" onClick={viewport.fit}><Maximize size={13}/></button>
  </div>
}
