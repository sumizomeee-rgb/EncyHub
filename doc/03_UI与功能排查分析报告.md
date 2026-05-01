# EncyHub UI 与功能排查分析报告

> 日期：2026-02-14
> 状态：待审批

---

## 一、全局问题

### 1.1 WebSocket 代理缺失（严重）

`hub_core/api.py` 中的 `proxy_router` 仅支持 HTTP 方法代理（GET/POST/PUT/DELETE/PATCH），**不支持 WebSocket 连接转发**。使用 `httpx.AsyncClient` 无法处理 WebSocket 升级请求。

影响范围：
- AdbMaster Logcat 实时日志流（`ws://host/api/adb_master/devices/{hw_id}/logcat`）→ 点击按钮无反应
- GmConsole 如果未来改用 WebSocket 事件推送也会受阻
- 施工方案书 §12.2 设计的是"前端直连工具子进程 WebSocket"，但实际前端代码走的是 `/api/` 代理路径

修复方案：在 `proxy_router` 中新增 WebSocket 代理路由，使用 `websockets` 或 FastAPI 原生 WebSocket 做双向转发。

### 1.2 UI 整体排版过于紧凑

所有页面存在间距不足、字号偏小的问题，视觉上非常拥挤。具体表现：

| 问题 | 当前值 | 建议值 |
|------|--------|--------|
| 页面主内容 padding | `p-4` ~ `p-6` | `p-6` ~ `p-8` |
| 卡片间距 gap | `gap-4` | `gap-6` |
| 面板内 padding | `p-4` ~ `p-5` | `p-5` ~ `p-6` |
| 正文字号 | `text-xs` ~ `text-sm` 为主 | 适当提升至 `text-sm` ~ `text-base` |
| 标题字号 | `text-sm` ~ `text-lg` | 适当提升 |
| 列表项间距 | `space-y-1.5` ~ `space-y-2` | `space-y-2` ~ `space-y-3` |

---

## 二、Dashboard 页面

### 2.1 UI 问题

- 工具卡片区域 `gap-6` 尚可，但卡片内部 `mb-4`、`mb-5` 可以更宽松
- 工具描述文字 `text-sm` 偏小，建议 `text-base`
- Footer 区域过于简陋

### 2.2 功能缺漏

| 缺失功能 | 原项目参考 | 优先级 |
|----------|-----------|--------|
| 工具运行时长显示 | — | 低 |
| 工具端口一键复制 | — | 低 |

Dashboard 功能基本完整，问题不大。

---

## 三、AdbMaster 页面

### 3.1 UI 问题

- **设备列表面板**（`xl:col-span-1`）：设备卡片 `p-4` + `space-y-2` 间距紧凑，hardware_id 显示被截断（`slice(0, 16)`），信息密度过高
- **控制中心**（`xl:col-span-2`）：
  - 顶部操作按钮（安装APK、重启应用、WiFi连接、断开）全部挤在一行 `flex gap-2`，设备同时有 USB+WiFi 时按钮会溢出
  - Logcat 日志区域高度仅 `h-48`（192px），对于实时日志查看来说太小
  - 文件传输面板内 `grid-cols-2 gap-3` 间距偏紧
  - 文件选择使用原生 `<input type="file">`，没有自定义样式，与整体设计不协调
- **整体**：`max-w-7xl` 限制了宽度，对于设备管理这种信息密集型页面偏窄

### 3.2 功能缺漏

| 缺失功能 | 原项目参考 | 说明 | 优先级 |
|----------|-----------|------|--------|
| **Logcat 不工作** | WebSocket `/devices/{hw_id}/logcat` | proxy_router 不支持 WS 转发，点击开始按钮无反应 | **严重** |
| 设备昵称编辑 | 原 AdbMaster 支持双击编辑昵称 | 后端有 `/devices/{hw_id}/nickname` PUT 接口，前端未实现 | 中 |
| 路径历史记录 | 原项目文件传输有路径历史下拉 | 推送/拉取路径无历史记录功能 | 中 |
| 清除离线设备 | 原项目有"清除离线"按钮 | 前端未实现 | 低 |
| Logcat 过滤/搜索 | 原项目支持关键字过滤 | 当前无过滤功能 | 低 |
| Logcat 导出/保存 | 原项目支持保存日志到文件 | 当前无导出功能 | 低 |
| 拉取文件保存路径 | 原项目可指定本地保存路径 | 当前直接触发浏览器下载，无法指定路径 | 低 |

---

## 四、FlowSvn 页面

### 4.1 UI 问题

- **任务表格**：`data-table` 单元格 padding 偏小，SVN 路径列 `text-xs` 字号过小，长路径难以阅读
- **模板卡片网格**：`grid-cols-5` 在大屏上卡片过小，`p-4` 内容拥挤
- **模板编辑弹窗**：动作列表 `space-y-3` 间距尚可，但动作内部 `grid-cols-2 gap-3` 字段区域紧凑
- **空状态**：任务空状态设计不错，但模板空状态过于简陋（纯文字）

### 4.2 功能缺漏

| 缺失功能 | 原项目参考 | 说明 | 优先级 |
|----------|-----------|------|--------|
| 执行历史/日志查看 | 原 AutoSvn 有执行日志面板 | 任务执行后无法查看详细日志 | 高 |
| 动作排序（上移/下移） | 原项目支持拖拽或按钮排序 | 模板动作无法调整顺序 | 中 |
| SVN 路径验证 | 原项目会验证路径是否为有效 SVN 工作副本 | 当前无验证，用户可能输入无效路径 | 中 |
| 任务启用/禁用快捷切换 | 原项目在列表中可直接切换 | 当前需要进入编辑弹窗才能切换 | 中 |
| 动作复制/粘贴 | 原项目支持复制动作到剪贴板 | 当前无此功能 | 低 |
| 任务最后执行时间显示 | 原项目显示上次执行时间 | 表格中未显示 | 低 |

---

## 五、GmConsole 页面

### 5.1 UI 问题

- **左侧面板**（`lg:col-span-2`）：仅占 2/12 = 16.7% 宽度，**严重过窄**。监听端口和客户端列表的文字被大量截断，客户端设备名几乎看不全。建议至少 `lg:col-span-3`
- **中间面板**（`lg:col-span-6`）：GM 命令网格区域 `gap-8px` 偏紧，按钮 `p-3 text-sm` 在高列数时文字被截断
- **右侧面板**（`lg:col-span-4`）：
  - Lua 输入框 `h-24`（96px）偏小，对于多行 Lua 代码不够用
  - 日志区域 `h-64`（256px）固定高度，无法自适应
- **整体**：`p-4` 主内容 padding 过小，三栏布局 `gap-4` 间距不足
- **标题字号**：所有面板标题 `text-sm` 过小，与面板重要性不匹配

### 5.2 功能缺漏

| 缺失功能 | 原项目参考 | 说明 | 优先级 |
|----------|-----------|------|--------|
| Toggle 类型 GM 元素 | 原项目 GM 树支持 SubBox/Btn/Toggle/Input 四种类型 | 当前仅处理 SubBox 和 Btn（默认），Toggle 和 Input 类型被当作普通按钮 | 高 |
| Input 类型 GM 元素 | 同上 | Input 类型应显示输入框+确认按钮，当前缺失 | 高 |
| WebSocket 实时事件 | 原项目通过 WebSocket 推送连接/断开/日志事件 | 当前使用 2 秒轮询 `setInterval(fetchData, 2000)`，延迟高且浪费资源 | 中 |
| 广播模式选择 | 原项目支持"全部客户端"或"指定端口"广播 | 当前广播固定发送给所有客户端，无法选择范围 | 中 |
| GM 命令广播 | 原项目 GM 按钮支持广播模式执行 | 当前 GM 按钮只能对选中客户端执行，无法广播 | 低 |
| 客户端详细信息 | 原项目显示客户端 IP、连接时间等 | 当前仅显示 device 和 platform | 低 |

---

## 六、Toast 组件小问题

`frontend/src/components/Toast.jsx` 第 95-100 行：

```jsx
const contextValue = useCallback({
  success: (msg) => addToast(msg, 'success'),
  error: (msg) => addToast(msg, 'error'),
  warning: (msg) => addToast(msg, 'warning'),
  info: (msg) => addToast(msg, 'info'),
}, [addToast])
```

`useCallback` 应包裹函数而非对象字面量。应改用 `useMemo`。当前能运行但属于误用。

---

## 七、修复优先级建议

### P0 - 必须修复（功能不可用）
1. WebSocket 代理支持（影响 AdbMaster Logcat）

### P1 - 高优先级（核心体验）
2. 全局 UI 间距/字号调整（所有页面）
3. GmConsole 左侧面板宽度调整
4. GmConsole Toggle/Input 类型 GM 元素支持
5. FlowSvn 执行历史/日志查看

### P2 - 中优先级（功能完善）
6. AdbMaster 设备昵称编辑
7. AdbMaster 路径历史记录
8. FlowSvn 动作排序
9. FlowSvn SVN 路径验证
10. FlowSvn 任务启用/禁用快捷切换
11. GmConsole WebSocket 实时事件（替代轮询）
12. GmConsole 广播模式选择
13. AdbMaster Logcat 区域高度增大
14. Toast 组件 useCallback → useMemo 修正

### P3 - 低优先级（锦上添花）
15. AdbMaster 清除离线设备
16. AdbMaster Logcat 过滤/导出
17. FlowSvn 动作复制/粘贴
18. FlowSvn 任务最后执行时间
19. GmConsole 客户端详细信息
20. GmConsole GM 命令广播模式

---

*报告完毕，等待审批。*
