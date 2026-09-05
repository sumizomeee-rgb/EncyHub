# 设计方案书：GM Console 单端口多路复用 + 会话标识改造

> 状态：设计闭环（待评审实施）
> 关联模块：`tools/gm_console/`、`frontend/src/pages/GmConsole.jsx`、`tools/gm_console/README_RuntimeGM_Client.md`
> 作者：调查 + 设计协作产出

---

## 1. 背景与痛点

### 1.1 现状
- Lua 侧 `RuntimeGMClient` 硬编码 `Host` + `Port`（默认 `12581`），主动 `connect` 到开发机 `IP:12581`，连上后发 `HELLO`（携带 pid / device / platform / packageName / persistentDataPath）。
- Python 侧 `main.py` 启动时自动监听 `DEFAULT_TCP_PORT = 12581`（`main.py:206`），同时 Web 还能通过 `/listeners` API + UI 手动**添加额外监听端口**。
- 客户端身份 `client_id` 被定义为 **`IP:监听端口`**（`server_mgr.py:195`）。

### 1.2 真正的痛点根源
痛点**不是**"要写一个端口"——握手端口无论如何都得有一个，跑不掉。真正的根源是设计：

> `client_id = IP:监听端口`，且 `_handle_client` 中"断开同端口的旧连接"（`server_mgr.py:198`）导致**一个监听端口同一时刻只能挂一个客户端**。

因此当用户需要**同时**连接多个分支 / 多台设备时，被迫给每个分支改成不同端口，再去逐个修改 Lua 内嵌代码里的 `Port`，非常繁琐。

### 1.3 改造目标（一句话）
**所有分支 / 所有设备统一连固定握手端口 `12581`，不再手动管理端口；多设备靠"会话标识"区分，可同时挂载。** Lua 侧从此一处都不用改端口。

---

## 2. 目标与非目标

### 2.1 目标
1. 单一固定监听端口 `12581`，支持**多个客户端同时连接**。
2. 客户端身份从"监听端口"切换为 **`IP + pid` 会话标识**。
3. 保持"网络波动断线重连（客户端进程未重启）"时身份不变 → Web 选中态不丢、实时订阅可续。
4. 废弃 Web 端"添加 / 移除监听端口"能力（`/listeners` API + UI）。
5. 前端 `client.id` 作为不透明 token 处理，改造对前端逻辑侵入最小。

### 2.2 非目标
- **不做**动态端口分配（FTP 被动模式式的"控制口 + 数据口"）。已评估为劣势方案：多一次往返、多一个失败环节，相比单端口复用无任何收益。
- **不改**通信协议帧格式（仍是 `\n` 分隔的 JSON 行）。
- **不改**各功能子模块（Animator / Inspector / Hierarchy / Timeline / Proto / Table 等）的业务协议，仅改它们依赖的 `client_id` 寻址底座。
- 客户端**进程重启**（pid 变化）被明确接受为"新设备"，无需做跨重启的身份延续。

---

## 3. 关键设计决策与依据

### 3.1 性能：单端口不增加任何开销
`add_listener` 使用 `asyncio.start_server`，每条 **连接** accept 后跑独立协程 `_handle_client`（`server_mgr.py:191`），内部 `while True: await reader.readline()`。

- N 个设备 = N 个协程，**与它们连在 1 个口还是 N 个口无关**。监听端口只是 accept socket，连接进来后每条连接平等。
- 十几个设备 = 十几个协程，asyncio 单事件循环轻松承载。
- 真正的负载来源是**数据量**（如 Animator/Timeline 实时推送 10Hz），但该负载在单端口 / 多端口下完全一致，与本次改造无关。

**结论：单端口多路复用本身零额外性能成本。**

### 3.2 身份标识：`IP + pid`
- pid 在游戏进程存活期间稳定，网络波动重连（源端口变化）不影响 → 满足"重连身份不变"。
- pid 在 `HELLO` 包才上报（`server_mgr.py:260-265`），accept 那一刻还没有 → 必须采用**两段式 ID**（见 3.3）。
- 进程重启 → 新 pid → 视为新设备（用户已接受）。

### 3.3 两段式 ID（临时 ID → 确定 ID 的 rekey）
```
accept 连接
  └─ 生成「临时 ID」：temp:{ip}:{srcport}:{seq}   （唯一、不冲突）
  └─ 以临时 ID 注册 Client，立即可收发（此时 device/pid 未知）

收到 HELLO（携带 pid/device/...）
  └─ 计算「确定 ID」：{ip}-{pid}
  └─ rekey：把 Client 从临时 ID 迁移到确定 ID（严格顺序，见下）
     ├─ 1) 若确定 ID 已存在旧 Client（同 IP+pid 的上一条连接残留）→ 先踢除旧连接（close 其 writer + 从 clients 移除）
     ├─ 2) 从 self.clients 删除临时 ID 键
     ├─ 3) 更新 client_obj.id = 确定 ID
     ├─ 4) self.clients[确定 ID] = client_obj
     ├─ 5) 迁移所有以 client_id 为键的附属状态（见 4.3）
     └─ 6) 触发 on_update / on_client_data_update
```

**ID 格式**：`{ip}-{pid}`（用 `-` 分隔。当初考虑过 `#` 更易读，但 `#` 是 URL 的 fragment 分隔符——即使用 `encodeURIComponent` 编码为 `%23`，httpx 等 HTTP 客户端在转发时仍可能将 `%23` 解码为 `#` 并截断其后的路径，导致 `/api/{tool_id}/inspector/{client_id}/command` 等路由 404。`-` 方案无此歧义，前端依旧把 id 当不透明 token 处理，无需改动）。

**关键实现约束（避免自踢/误删）**：
- 步骤 1 踢旧连接时，旧连接的读循环会进入 finally；其 finally 必须用 `self.clients.get(旧obj.id) is 旧obj` 校验后才删除——因为此刻确定 ID 键可能已被本次新连接占用，校验能防止误删新对象（沿用现有 `:238` 模式）。asyncio 单事件循环下 rekey 是原子的（不会被打断），步骤顺序保证安全。
- `_handle_client` 的读循环**不得**再用局部变量 `cid` 去 `self.clients.get(cid)`——rekey 后该键已失效。**改为把 `client_obj` 自身传入 `_process_packet`**，内部一律用 `client_obj`（其 `.id` 永远指向当前生效 ID），彻底规避"rekey 后按旧键查不到"的问题。

### 3.4 pid 缺失的兜底
`HELLO` 中 pid 可能为 `0`（`server_mgr.py:263` 已有 `or 0`）——例如部分平台 `Process.GetCurrentProcess().Id` 取不到。

兜底策略（spec 决策）：
- pid 有效（> 0）→ 确定 ID = `{ip}-{pid}`。
- pid == 0 → 确定 ID 退化为 `{ip}-dev:{device}`（device 也空则保留临时 ID 不 rekey）。
- 该退化路径下"重连身份不变"可能无法保证（device 字符串若不稳定），属可接受降级，仅影响个别异常平台。

### 3.5 旧"同端口踢除"逻辑的置换
现状 `_handle_client:198` 在 accept 时遍历"同 port 的旧客户端"并踢除，目的是清理同一设备重连后的上一条死连接。

单端口下不能再按 port 踢（否则会把**同端口的所有其他设备**全部误踢）。置换为：

> 踢除动作**移到 HELLO/rekey 阶段**，按"相同确定 ID（同 IP+pid）"踢除上一条残留连接。accept 阶段不再做任何踢除。

---

## 4. 影响范围（精确清单）

### 4.1 `tools/gm_console/server_mgr.py`

| 位置 | 现状 | 改造 |
|---|---|---|
| `_handle_client:195` | `cid = f"{addr[0]}:{port}"` | 改为生成临时 ID 注册 |
| `_handle_client:198-205` | accept 时按 port 踢旧连接 | **删除**，踢除逻辑移至 rekey |
| `_handle_client:207` | `Client(id=cid, port=port, ...)` | 记录 `ip`、临时 id；`port` 字段语义弱化（恒为 12581） |
| `_handle_client:236-239` | finally 按 `cid` 删除 | 改为按 `client_obj.id` 删除 + `self.clients.get(client_obj.id) is client_obj` 校验 |
| 读循环 `_process_packet(cid, pkt)` (`:223`) | 按局部 `cid` 传入，内部 `self.clients.get(cid)` | **改签名为 `_process_packet(client_obj, pkt)`**，内部统一用 `client_obj`（`.id` 永远最新），规避 rekey 后旧键失效 |
| `_process_packet:260 (HELLO)` | 仅填充字段 | **新增 rekey 逻辑**：计算确定 ID、踢旧、迁移附属状态、改 `self.clients` 键、更新 `client_obj.id`（严格按 §3.3 顺序） |
| `Client` dataclass:18 | 有 `port` 无 `ip` | **新增 `ip` 字段**；`to_dict` 输出 `ip`（前端 `GmConsole.jsx:741` 已引用 `client.ip` 但当前未提供，顺带修复） |
| `send_to_port:359` / `send_gm_to_port:441` | 按 port 寻址 | **删除**（main 未引用，确认为死代码） |
| `add_listener` / `remove_listener` | 多端口管理 | 保留 `add_listener` 供启动时拉起 12581；`remove_listener` 仅 shutdown 用。移除"重启同端口"等多端口语义可简化 |
| `get_listeners_info:543` | 返回端口列表 | 可保留返回单条 `[{port:12581, client_count}]` 以最小化前端改动，或一并删除（见 4.2 取舍） |

### 4.2 `frontend/src/pages/GmConsole.jsx`

前端**好消息**：`client.id` 全程当作不透明 token——只有 `c.id === prev.id` 相等比较（`:211, :281`）和 `encodeURIComponent(selectedClient.id)` 拼 URL（`:476, :536, :579, :951`），**没有任何 `.split()` / 结构解析**。ID 格式改变前端逻辑零感知。

需删除的多端口 UI / 逻辑：
- state：`showAddListener`、`newPort`（`:187-188`）、`listeners`（`:59`，按 4.1 取舍决定是否保留只读展示）
- 函数：`handleAddListener`（`:407`）、`handleRemoveListener`（`:434`）
- fetch：`/listeners` 拉取（`:196-203`）、`event.listeners` 同步（`:275`）
- UI：添加监听按钮（`:681`）、监听端口角标与列表（`:710-714, :773-788`）
- 客户端卡片端口展示（`:741, :849`）：原 `:${client.port}` 全部恒为 `12581`，改为展示 `client.ip` 或 `#pid` 更有意义。

**取舍建议**：彻底删除 listeners 相关 UI 与 API（用户已选"废弃只留单口"）。`get_listeners_info` 可保留为内部健康信息或一并清理，二选一在实施时定，不影响设计闭环。

#### 4.2.1 UI 替换：用静态"握手端口"卡片取代原多端口 UI（用户决策，已对设计样式）

> 设计前提：现有界面是 glass-card（白半透明 + 圆角 + 柔影）+ 渐变图标圈的高级风格，**改造必须沿用同一视觉语言，不可降级为朴素文本**。已实读运行中界面确认样式基线。

**(A) 握手端口 —— 置顶、全局、只显示一次**
- 复用原「监听端口」glass-card 的**原位置**（侧栏顶部），矮化为单行只读卡片。
- 保留绿色渐变 Radio 图标圈（`from-[var(--sage)] to-[var(--sage-soft)]`）+ 标题，标题文案 `监听端口` → **`握手端口`**。
- 内容：脉动绿点（`bg-[var(--sage)] animate-pulse`）+ mono 字体 `:12581`。**移除**：➕ 新增按钮、删除按钮(Trash2)、端口列表的可增删结构、`client_count` 角标（接入数已由「客户端」卡片体现）。
- **绝不留任何编辑入口**——纯展示，否则退回多端口复杂度。
- 端口值从后端读取（`/` 健康接口或常量），前端不硬编码。
- 折叠侧栏态（`:707-718`）：原 Radio 角标的 `listeners.length` 数字角标移除，仅保留 Radio 图标 + tooltip 改为"握手端口 12581"。

```
┌─ glass-card ──────────┐
│ ◉(绿渐变) 握手端口        │
│   • :12581             │   ← 脉动绿点 + mono
└───────────────────────┘
```

**(B) 客户端卡片 —— IP 完整优先，pid 区分同机多实例，机型名可截断**
- 第一行：机型名 `client.device`，`truncate`（太长省略）。
- 第二行：`#{pid} · {mono IP} · {platform}` —— **pid 先頭に `#` 付きで表示**（同 IP 同機器で複数クライアント起動時に pid で一目区別可）、IP は mono 字体で完整（truncate しない）、platform を末尾に。pid は `text-[var(--coffee-light)]` でやや淡色にし、IP(`text-[var(--coffee-deep)]`)より目立たせすぎない。
- pid=0 の場合は pid を表示しない（退避パス。通常は > 0）。
- 原 `:${client.port}`（恒 12581，無区分度）**整体移除**。
- 折叠態卡片 tooltip：`${device}\n#${pid} · ${ip} · ${platform}`。

```
┌─────────────────────────────┐
│ 📱 Redmi K60 Ultra…         │  ← device truncate
│    #105596 · 10.101.0.8 · Android │  ← #pid · mono IP · platform
└─────────────────────────────┘
```

**需删除的多端口 UI / 逻辑（前端）**：
- state：`showAddListener`、`newPort`（`:187-188`）。`listeners`（`:59`）→ 可保留单条只读或改由后端常量，实施时择简。
- 函数：`handleAddListener`（`:407`）、`handleRemoveListener`（`:434`）。
- fetch：`/listeners` 拉取（`:196-203`）、`event.listeners` 同步（`:275`）。
- UI：➕ 新增监听按钮（`:681`）、可增删的监听端口列表（`:771-795`）。

| 元素 | 原 | 改后 |
|---|---|---|
| 监听端口卡片（`:760-798`） | 可增删端口列表 + 接入数 + 删除按钮 | 矮化为只读「握手端口 ● :12581」单行卡片，复用绿渐变圈 |
| ➕ 新增监听按钮（`:681`）+ 弹窗（`:187-188`） | 添加端口入口 | 全部删除 |
| 折叠态 Radio 角标（`:710-716`） | `listeners.length` 数字角标 | 移除角标，tooltip 改"握手端口 12581" |
| 客户端卡片第二行（`:846-850`） | `platform · ip:port` | `{mono ip} · {platform}`，IP 完整不截断 |
| 客户端卡片端口（`:849`） | `:${client.port}` | 删除 |

### 4.3 跨 rekey 必须迁移的附属状态
rekey（临时 ID → 确定 ID）时，所有**以 client_id 为键**的状态必须同步迁移，否则重连后实时流 / 等待态错乱：

| 状态 | 位置 | 处理 |
|---|---|---|
| `self.clients` 主表 | `server_mgr.py:66` | 改键（核心） |
| `self._animator_list_cache` | `:72` | 按新键迁移 |
| `self._pending_execs`（`exec_wait` 用 client_id 关联，`:415`） | `:85` | rekey 一般发生在 HELLO（连接早期），通常无 in-flight exec；但需保证迁移或在 rekey 时无悬挂项。设计上：rekey 时遍历 `_pending_execs`，把 `client_id == 临时ID` 的项改为确定 ID |
| 前端 `selectedClient` / `autoSelectedClientId` | 前端 | 依赖 `on_update` 广播新 clients 列表后，前端按 `id` 相等匹配（`:211, :281`）。注意：rekey 会使临时 ID 阶段被选中的客户端 id 改变 → 见 5.4 边界 |

### 4.4 Lua 客户端侧（README + inject 工具）

> ⚠️ 修正：原以为"Lua 端无需改动"，实读 `inject_runtime_gm.py` 后发现**注入工具的多分支递增端口机制必须删除**——它正是为绕开旧"一端口一客户端"限制而存在的，与本痛点是同一问题的两半。

#### 4.4.1 `tools/gm_console/inject_runtime_gm.py`（**必须改**）
现状（`:145-154`）：多分支按列表序号 `port = GM_PORT + i` **递增分配端口**，`patch_host_port` 把每个分支 patch 成不同端口（12581 / 12582 / 12583…）。

**问题**：单端口多路复用后服务器只监听 12581。若仍递增，第 2 个及之后的分支会被 patch 成 12582+ → **连不上服务**。这套递增逻辑必须**整体删除**。

改造：
- 删除 `port = GM_PORT + i` 递增逻辑（`:154`），所有分支统一 patch 成 `GM_PORT`（12581）。
- 简化 `inject_one` 调用：不再传递增 `port`，恒用 `GM_PORT`。
- 简化日志/汇总文案中的"端口分配 N~M / 按列表顺序递增"（`:145-149, :168`）→ 统一为固定 12581。
- `TARGET_LUA_FILES` 多分支能力**保留**（仍需对多个分支文件批量注入），但它们现在**都连同一个 12581**——这正是改造的价值兑现点。
- `patch_host_port`（`:66-84`）正则**保留**（已验证与 README 末尾 `gmClient.Start("ip", 12581)` 格式匹配），仅端口入参恒为 12581。

#### 4.4.2 README 里的 Lua 代码本身（**基本不用改**）
- `RuntimeGMClient.Start(host, port)`（README `:4947`）、`.Host` / `.Port`（`:51-52`）、`Connect()`（`:204` 连 `Host:Port`）机制**全部保留**，固定连 12581 即可正常工作。
- 可选优化：把 `.Port = 12581` 旁注释为"固定握手端口，所有分支统一，勿改"。
- 末尾 `gmClient.Start("10.101.0.8", 12581)`（`:4980`）端口部分保持 12581（IP 仍由 inject 工具按 `GM_HOST` patch）。

#### 4.4.3 README 文案
- 端口 `12581` 说明改为"固定握手端口，所有分支 / 所有设备统一连接，无需区分、无需修改"。
- 删除"给不同分支配不同端口"的旧用法引导（注意事项第 38 行附近）。

---

## 5. 边界与异常处理

### 5.1 同 IP+pid 重连（网络波动，进程未重启）— 核心目标场景
- 旧连接可能尚未被 OS/服务器感知断开，新连接已到。
- rekey 时检测到确定 ID 已存在 → 踢除旧连接 writer，新连接接管同一 ID。
- 前端 `id` 不变 → 选中态、实时订阅可无缝续（订阅需前端在 `on_update` 后按需重发，沿用现有行为）。

### 5.2 进程重启（pid 变化）
- 新 pid → 新确定 ID → Web 出现一个"新设备"，旧设备项在旧连接断开（`_handle_client` finally）后消失。
- 用户已明确接受此交互。

### 5.3 pid == 0
- 按 3.4 兜底。该设备的"重连身份延续"可能降级，但不影响基本可用。

### 5.4 临时 ID 阶段被操作的竞态
- 极少数情况：客户端连上（临时 ID）但 HELLO 未到时，用户已在 Web 点选该设备。
- 设计取舍：临时 ID 阶段的客户端在 UI 上可标注"识别中"或暂不可选，待 HELLO 后变正式项。最简实现：前端对 `device == "Unknown"` 的项弱化展示。rekey 后该项 id 变化属正常（用户尚未对其下发关键指令）。
- 此为低频边界，不阻塞主设计。

### 5.5 finally 删除用错键
- rekey 后 `self.clients` 的键已是确定 ID，而 `_handle_client` 局部变量 `cid` 仍是临时 ID。
- **修复**：`Client` 对象自身持有"当前生效 id"（rekey 时更新 `client_obj.id`），finally 用 `client_obj.id` 删除，并保留 `self.clients.get(id) is client_obj` 的身份校验（沿用 `:238` 的防误删模式）。

---

## 6. 实施步骤（建议顺序）

1. **后端 - Client 模型**：`Client` 增加 `ip` 字段，`to_dict` 输出 `ip`；`id` 改为可变（rekey 时更新）。
2. **后端 - 两段式 ID**：`_handle_client` accept 生成临时 ID 注册；删除原 :198 同端口踢除。
3. **后端 - rekey**：`_process_packet` 的 HELLO 分支实现确定 ID 计算、同 ID 踢旧、附属状态迁移、键迁移、`client_obj.id` 更新、回调触发。
4. **后端 - finally 修正**：按 `client_obj.id` 删除（5.5）。
5. **后端 - 清理**：删除 `send_to_port` / `send_gm_to_port` 死代码；简化 `add_listener`/多端口语义；按取舍处理 `get_listeners_info`。
6. **前端 - 删除多端口 UI/逻辑**（4.2 清单）。
7. **前端 - 客户端展示**：端口展示改为 `ip` / `#pid`；原多端口角标位置替换为只读"握手端口 12581" chip。
8. **Lua 注入工具**：`inject_runtime_gm.py` 删除递增端口逻辑，所有分支统一 patch 成 12581（§4.4.1）。
9. **文档**：更新 `README_RuntimeGM_Client.md` 文案（§4.4.3）。
10. **验证**：见第 7 节。

---

## 7. 验证计划（手动）

| 用例 | 步骤 | 期望 |
|---|---|---|
| 单设备连接 | 1 台客户端连 12581 | Web 出现该设备，device 正确，可执行 Lua / GM |
| 多设备同口 | 2~3 台不同设备/分支同时连 12581 | 全部并存显示，互不踢除，各自可独立下发指令 |
| 网络波动重连 | 选中设备 → 断网 45s+ 触发 Lua 重连（进程不重启） | 重连后同一设备项（id 不变），选中态保持，Animator/Timeline 可续 |
| 进程重启 | 重启游戏（新 pid） | 旧项消失、新项出现（接受） |
| pid=0 兜底 | 模拟 HELLO pid=0 | 不崩溃，按 device 退化标识，基本功能可用 |
| 实时流隔离 | 设备 A 订阅 Animator，设备 B 同时订阅 | 各自数据互不串台（验证 `_animator_list_cache` 等按新键隔离） |
| 压力 | 十几台设备同时连 + 部分订阅实时流 | 无明显卡顿，事件循环正常（验证 3.1 结论） |

---

## 8. 风险与回滚
- **风险**：`client_id` 是贯穿前后端所有 API 的寻址底座，rekey + 附属状态迁移若遗漏某处缓存会导致"重连后某功能失联"。缓解：4.3 清单逐项核对 + 第 7 节实时流隔离用例。
- **回滚**：改造集中在 `server_mgr.py` 身份层 + 前端 listeners UI。保留改造前分支即可快速回退；协议帧未变，新旧 Lua 客户端均兼容（Lua 端本就只连 12581）。

---

## 9. 结论
方向成立、价值集中在"多分支 / 多设备同时调试"场景（中高价值）；单分支日常调试本就够用（低价值）。技术方案以**单端口多路复用 + `IP+pid` 两段式会话标识**闭环，零额外性能成本，前端因 id 不透明而侵入极小。核心工作量在后端身份层的 rekey 与附属状态迁移。
