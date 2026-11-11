// 证据日志可能有上百万字；列表和弹窗只排版预览，复制仍使用原始全文。
export function logPreview(value, limit = 2000, hint = '双击查看详情，详情中可复制全文') {
  const text = String(value || '').trimStart()
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（共 ${text.length} 字；${hint}）`
}
