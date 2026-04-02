/**
 * 复制文本到剪贴板，兼容非安全上下文（HTTP）
 * navigator.clipboard 仅在 HTTPS / localhost 下可用，
 * 其他环境回退到 execCommand('copy')
 */
export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text)
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.left = '-9999px'
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  document.body.removeChild(ta)
  return Promise.resolve()
}
