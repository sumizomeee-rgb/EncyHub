export const MIN_ZOOM = .08
export const MAX_ZOOM = 2.5
export const clampZoom = value => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value))

// 缩放前后的同一个图坐标仍落在鼠标下。
export function zoomAnchor(scroll, point, before, after) {
  return Math.max(0, (scroll + point) * after / before - point)
}

export function fitZoom(width, height, viewportWidth, viewportHeight) {
  return clampZoom(Math.min(1, viewportWidth / width, viewportHeight / height))
}
