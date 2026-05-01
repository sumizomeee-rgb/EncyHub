# Spec: haru-lua-ency-control Skill

> 日期：2026-04-22
> 状态：设计中

## 概要

创建一个新的 Claude Code skill `haru-lua-ency-control`，通过 EncyHub GM Console 的 HTTP API 直接控制 Haru 游戏客户端。取代现有 `haru-lua-control` 的独立 TCP Bridge 模式，使 agent 能一步直连游戏（无需启动 bridge 进程、无需手动执行 GM 开启 lua-control），同时获得 EncyHub 提供的全功能能力（Proto 调用、UI Inspector、GM 树动态发现等）。

## 动机

现有 `haru-lua-control` 的痛点：
1. 需要手动在 GM Console 里执行"开启/关闭 lua-control"GM 来启动一个额外的 socket 客户端
2. 需要独立运行 bridge.py serve 进程
3. bridge.py 是独立的 TCP 服务器，与 EncyHub GM Console 能力完全隔离
4. 无法使用 GM Console 的高级功能（Proto、Inspector、Animator、广播等）

EncyHub GM Console **已经有完整的 HTTP API**，游戏客户端已通过 RuntimeGMClient 连接到 GM Console。agent 只需 curl 即可控制游戏。

## 技术验证结果

已通过实际测试验证：

| 测试项 | 结果 |
|--------|------|
| 列出客户端 `GET /clients` | ✅ 返回完整客户端信息 + GM 树（128个节点）|
| 执行 Lua `POST /clients/{id}/exec` | ✅ 发送到客户端，日志确认执行 |
| 执行 GM `POST /clients/{id}/exec-gm` | ✅ GM 命令发送成功 |
| 获取日志 `GET /logs` | ✅ 获取到 print 输出和错误信息 |
| Hub 代理 vs 直连 | 直连 0.35s，代理 1.04s，选择直连 |

## 架构设计

### 连接方式

```
Agent (curl)
    │
    ├── GET localhost:9524/api/hub/tools → 发现 GM Console 端口（如 1882）
    │
    └── 后续所有操作直连 localhost:{port}/...
        ├── GET  /clients         — 列出客户端 + GM 树
        ├── POST /clients/{id}/exec    — 执行 Lua（cmd 字段）
        ├── POST /clients/{id}/exec-gm — 执行 GM（gm_id + value）
        ├── GET  /logs?limit=N    — 获取日志（含 exec 的输出）
        ├── GET  /custom-gm       — 自定义 GM 列表
        ├── POST /broadcast       — 广播到所有客户端
        └── ... Proto / Inspector / Animator 等高级 API
```

### exec-and-check 模式

核心操作模式（替代 bridge.py exec 的同步返回）：

```bash
# Step 1: 发送 Lua 代码
curl -s -X POST http://localhost:{port}/clients/{id}/exec \
  -H "Content-Type: application/json" \
  -d '{"cmd": "print(\"result: \" .. tostring(value))"}'

# Step 2: 等待 0.5-1 秒
sleep 0.5

# Step 3: 获取日志查看结果
curl -s "http://localhost:{port}/logs?limit=5"
```

## Skill 文件结构

```
haru-lua-ency-control/
├── skill.md              (~350-400 行)
│   ├── Frontmatter (name + description)
│   ├── §0 EncyHub API 连接与执行
│   ├── §1 GM 系统（增强：动态 GM 树 + Custom GM）
│   ├── §2 状态感知与导航（精简版，引用 references）
│   ├── §3 闭环自测工作流
│   ├── §4 故障排除
│   └── §5 潜规则速查表
└── references/
    ├── ui-interaction.md   (~250 行)
    │   ├── UI 交互方法论（从原 skill §3 迁移）
    │   ├── 过场/引导处理（从原 skill §9 迁移）
    │   └── 弹窗处理
    ├── bigworld.md         (~400 行)
    │   └── 大世界控制（从原 skill bigworld.md 迁移，改 3 处文字引用）
    └── flow-scripts.md     (~200 行)
        ├── 常见流程剧本（从原 skill §10 迁移）
        ├── 已知陷阱
        └── 流程决策树
```

## 知识迁移策略

### 原样迁移（纯 Lua 知识，零改动）

- UI 交互方法论（FindTopUi 链、按钮发现、子组件、DynamicTable、Tab、弹窗） → `references/ui-interaction.md`
- 大世界控制（移动、摄像机、传送、NavMesh、NPC 交互） → `references/bigworld.md`（改 3 处 "bridge" 文字）
- 常见流程剧本、已知陷阱 → `references/flow-scripts.md`

### 重写/增强

- §0 速查表 → 全部换成 curl API 命令
- §1 连接管理 → EncyHub API 连接检测（Hub → 端口发现 → 直连）
- §4 GM 系统 → 增强：动态 GM 树发现 + Custom GM 库 + EncyHub 独有能力
- §6 故障排除 → API 模式排障

### 新增内容

- EncyHub 独有能力章节：Proto 调用、UI Inspector、Animator、PlayerPrefs、广播
- GM 树动态发现：教 agent 从 `/clients` 返回的 gm_tree 搜索 GM 命令
- Custom GM 库：教 agent 浏览和执行现成的自定义 Lua 脚本

### 不迁移

- bridge.py 相关的所有内容（serve、stop、端口 9530/9531）
- bridge 特有的高级命令（`--wait-ui`、`exec-batch`）
- bridge 的连接管理逻辑

### 示例格式决策

- skill.md 中的示例统一使用 curl 格式
- references 中的 Lua 代码示例保持原样（纯 Lua，不带任何执行命令前缀）
- bigworld.md 中 3 处 "bridge" 文字引用改为 "通过 API exec"

## 不做的事

- 不改 bridge.py 或原 haru-lua-control skill
- 不改 EncyHub 后端代码（后续可考虑 exec-wait 端点，但当前 exec+logs 够用）
- 不创建任何脚本文件（agent 直接用 curl，无需中间层）
- 不创建 assets 目录

## 边界情况与防御策略

### 1. 多客户端连歪

GM Console 可同时连多个客户端（不同 listener 端口），`/clients` 返回列表。

**策略**：skill 定义"客户端选择协议"：
- 1 个客户端 → 自动选中
- 多个客户端 → 列出设备信息（device + platform），询问用户要控制哪个
- 选定后用 device+platform 组合作为稳定标识（不依赖 client_id 字符串）

### 2. Compact 后丢失 client_id

对话被压缩后 agent 可能忘记之前选的 client_id。

**策略**：每次操作前**重新验证**：
- 发命令前先 `GET /clients` 确认目标 client 还在
- 1 个 → 直接用
- 多个 → 用 device+platform 匹配之前选的

### 3. 客户端断连/重连

游戏重启或网络断开后 client_id 可能变化。

**策略**：
- `exec` 返回 HTTP 400 + "客户端不存在" → 重新 `GET /clients`
- 用 device+platform 匹配识别重连后的同一设备

### 4. GM Console 重启（端口变化）

GM Console 子进程重启后动态端口可能变。

**策略**：连接失败时重新走端口发现流程（`GET localhost:9524/api/hub/tools`）。

### 5. exec 无日志返回

Lua 代码死循环、游戏卡死、或代码未产生输出。

**策略**：
- exec 后 0.5s 查 logs，无新日志 → 等 2s 再查
- 5s 仍无 → 报告"可能的问题：游戏卡死/代码未产生输出/客户端已断开"
- 教 agent 始终在 Lua 代码末尾加 `print("OK")` 作为执行完成标记

### 6. logs 污染（多命令输出混合）

快速连续发多个 exec 时，日志按时序混合。

**策略**：教 agent 在 Lua 代码中加唯一前缀标记：
```lua
print("[Q1] " .. result)
```
logs 查询后用前缀过滤对应结果。

### 7. Hub 未运行

EncyHub 整体未启动，9524 无响应。

**策略**：连接检测流程第一步检查 Hub，失败直接报告"EncyHub 未运行，请先启动 EncyHub"。

### 8. GM Console 未启用

Hub 在运行但 GM Console 工具未启用/未启动。

**策略**：`GET /api/hub/tools` 返回 `running: false` → 报告"GM Console 未运行"并提示用户在 EncyHub 界面启动。
