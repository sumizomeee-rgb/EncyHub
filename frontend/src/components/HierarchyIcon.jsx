// Unity Editor 风格的 Hierarchy 图标：
// 三层缩进的小条 + 第一层带折叠箭头，呼应"嵌套场景对象树"概念。
// 与 lucide-react 同款 stroke API：尺寸/颜色由父级 size + currentColor 控制，可直接当组件用。
export default function HierarchyIcon({ size = 14, className = '', ...props }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            {...props}
        >
            {/* Layer 1：根节点（带折叠箭头） */}
            <path d="M2 3.5l1.4 1l-1.4 1" />
            <line x1="5" y1="4.5" x2="13.5" y2="4.5" />

            {/* Layer 2：子节点 */}
            <path d="M5 8l1.4 1l-1.4 1" />
            <line x1="8" y1="9" x2="13.5" y2="9" />

            {/* Layer 3：孙节点（更深） */}
            <line x1="11" y1="13" x2="13.5" y2="13" />
            <line x1="9" y1="13" x2="9.6" y2="13" />
        </svg>
    )
}
