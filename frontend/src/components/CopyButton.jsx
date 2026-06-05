import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Clipboard } from 'lucide-react'
import { copyText } from '../utils/clipboard'

export default function CopyButton({
    value,
    title = '复制',
    size = 11,
    className = '',
    stopPropagation = true,
}) {
    const [status, setStatus] = useState('idle')
    const timerRef = useRef(null)

    useEffect(() => () => {
        if (timerRef.current) clearTimeout(timerRef.current)
    }, [])

    const handleCopy = async (e) => {
        if (stopPropagation) e.stopPropagation()
        e.preventDefault()
        if (timerRef.current) clearTimeout(timerRef.current)

        try {
            await copyText(value ?? '')
            setStatus('copied')
        } catch (err) {
            console.error('[CopyButton] copy failed:', err)
            setStatus('error')
        }

        timerRef.current = setTimeout(() => setStatus('idle'), 900)
    }

    const Icon = status === 'copied' ? Check : (status === 'error' ? AlertCircle : Clipboard)
    const statusClass = status === 'copied'
        ? 'text-[var(--sage)] bg-[var(--sage)]/10'
        : status === 'error'
            ? 'text-[var(--terracotta)] bg-[var(--terracotta)]/10'
            : 'text-[var(--coffee-muted)] hover:text-[var(--coffee-deep)] hover:bg-black/10'

    return (
        <button
            type="button"
            onClick={handleCopy}
            className={`relative p-0.5 rounded flex-shrink-0 transition-colors ${statusClass} ${className}`}
            title={status === 'copied' ? '已复制' : status === 'error' ? '复制失败' : title}
            aria-label={status === 'copied' ? '已复制' : status === 'error' ? '复制失败' : title}
        >
            <Icon size={size} />
        </button>
    )
}
