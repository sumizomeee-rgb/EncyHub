# 设计方案书：GM Console 游戏端日志实时查看

> 状态：技术方案已验证（WindowsPlayer / Android 通过，iOS 待真机验证）
> 关联模块：`tools/gm_console/`、`frontend/src/pages/GmConsole.jsx`、`tools/gm_console/runtime_gm_client.lua`
> 作者：调查 + 设计协作产出

---

## 1. 背景与目标

GM Console 右侧已有“日志”区域，但当前展示的是 Web 端 / GM 通道日志，无法直接查看游戏真实输出到磁盘的日志文件。

Haru 游戏在启动时会创建日志文件，并持续写入。用户希望在 GM Console 中按当前选中的客户端查看对应平台的游戏端实时日志，并提供接近 Unity Console 的搜索、过滤、展开查看能力。

本方案的核心结论：

> 游戏端日志面板读取的源头必须是游戏正在写入的真实物理日志文件。RuntimeGMClient 只负责定位、tail、分片回传，不替代日志文件本身。

## 2. 已完成验证

### 2.1 WindowsPlayer 验证

当前在线客户端：

```text
client_id: 10.101.0.8-38544
platform: WindowsPlayer
pid: 38544
device: System Product Name (ASUS)
process: F:\HaruTrunk\Product\Bin\Client\Win\Debug\Application.exe
```

验证到的真实日志文件：

```text
F:\HaruTrunk\Product\Bin\Client\Win\Debug\Log\2026_06_15_22_54_53.log
```

验证动作：

1. GM Console 通过 `exec-wait` 执行 `print("ENCY_TAIL_MARK_225935304", "physical-log-check")`。
2. 物理日志文件大小增加 `331` 字节。
3. 日志文件中出现：

```text
<Log> LUA: ENCY_TAIL_MARK_225935304    physical-log-check
```

结论：WindowsPlayer 可以通过真实日志文件 tail 捕获 GM 执行产生的游戏日志。

### 2.2 Android 验证

当前在线客户端：

```text
client_id: 10.101.0.8-2687
platform: Android
pid: 2687
device: samsung SM-N9760
packageName: com.kurogame.haru
persistentDataPath: /storage/emulated/0/Android/data/com.kurogame.haru/files
```

游戏进程内验证：

```text
logDir: /storage/emulated/0/Android/data/com.kurogame.haru/files/log
latest: /storage/emulated/0/Android/data/com.kurogame.haru/files/log/2026_06_15_22_59_38.log
files: 22
```

ADB 外部验证：

```text
adb -s emulator-5554 shell pidof com.kurogame.haru
2687
```

验证动作：

1. GM Console 通过 `exec-wait` 执行 `print("ENCY_ANDROID_TAIL_MARK_230306965", "physical-log-check")`。
2. ADB 从真实物理路径读取同一个日志文件。
3. 文件尾部出现：

```text
<Log> LUA: ENCY_ANDROID_TAIL_MARK_230306965    physical-log-check
```

结论：Android 可以通过 `persistentDataPath/log` 定位真实日志文件，且 GM client 的 `pid` 与 ADB 进程一致。

### 2.3 日志条目边界验证

Haru 日志文件中，每条 Unity 日志以一整行等号分隔：

```text
=======================================================================================
```

一条完整日志的结构通常为：

```text
<Error> [2026/06/15 22:54:53.4640] 资源加载失败, Res-LaunchLogo/Prefab/LaunchLogo

  at XLog.DoLog (...)
  at XDriver.PlayLaunchLogo (...)

UnityEngine.Debug:LogError (object)
XLog:DoLog (...)
=======================================================================================
```

结论：

- “1 条日志”应按分隔线切分，而不是按单行切分。
- 条目内部可能包含空行、Lua 输出、C# 堆栈、Unity 堆栈，必须作为同一条日志保留。
- 条目级别从首个非空行的 `<Log>` / `<Warning>` / `<Error>` 提取。

## 3. 目标与非目标

### 3.1 目标

1. 在 GM Console 右侧日志区域增加 `Web端日志` / `游戏端日志` 双模式切换。
2. `游戏端日志` 显示当前选中客户端对应的真实物理日志文件内容。
3. 支持初次打开时追回最近日志，避免 Web 连接晚于游戏启动导致看不到上下文。
4. 支持实时 tail 新增日志，并按完整日志条目展示。
5. 支持 Unity Console 风格搜索、过滤、自动滚动、暂停、清空。
6. 支持单条日志默认最多展示 2 行，双击打开完整详情弹窗。
7. 切换客户端后，每个客户端保留独立日志缓存和视图状态。
8. 对文件轮转、清空、连接中断、日志裁剪等情况给出明确 UI 提示。

### 3.2 非目标

1. 不替代游戏原始日志文件，Web 面板只是实时查看和缓存视图。
2. P0 不承诺无限保存所有日志；完整归档仍以原始日志文件为准。
3. P0 不做跨进程重启的日志会话合并；游戏进程重启后视为新客户端。
4. P0 不强制实现正则搜索，可预留开关。
5. P0 不依赖 ADB Master / iOS Master 做设备匹配；避免 GM Console 日志功能被外部工具状态影响。

## 4. 总体方案

### 4.1 方案一句话

前端打开 `游戏端日志` 后，GM Console 后端向当前客户端发送日志 tail 指令；RuntimeGMClient 在游戏进程内定位真实日志目录，读取最新日志文件尾部并持续读取新增内容，再通过现有 TCP 通道把日志条目推回后端；后端按客户端缓存并通过 WebSocket 推给前端。

### 4.2 为什么选择 RuntimeGMClient tail

相比由 EncyHub 主机通过 ADB / AFC / 本机路径直接读取，RuntimeGMClient tail 有这些优势：

1. 天然绑定当前 GM client，不需要额外做“Web 选中客户端 -> ADB/iOS 设备”的复杂匹配。
2. Android/iOS/Windows 都能使用同一套日志协议，只在游戏端做路径解析。
3. 只读取游戏自己可见的日志路径，避免 Windows 主机访问远端设备文件系统的权限差异。
4. 不监听游戏写日志动作，不侵入日志系统；源头仍是真实物理文件。
5. 与现有 GM TCP 长连接复用，不新增设备侧端口和外部依赖。

### 4.3 数据流

```text
前端 GameLog 面板
  └─ WebSocket: /api/gm_console/ws/game-log?client_id=...
       └─ GM Console 后端
            ├─ 复用 / 创建 client_id 对应 tail session
            ├─ 发送 GAME_LOG_START 到 RuntimeGMClient
            ├─ 接收 GAME_LOG_META / GAME_LOG_ENTRY / GAME_LOG_STATUS
            └─ 按 client_id 缓存并广播给前端
                 └─ RuntimeGMClient
                      ├─ 解析平台日志目录
                      ├─ 找最新 .log 文件
                      ├─ 初次追回尾部固定大小
                      ├─ 按分隔线切完整日志条目
                      └─ 持续 tail 新增内容
```

## 5. 路径解析规则

### 5.1 WindowsEditor

优先在 RuntimeGMClient 内使用 `Application.dataPath` 向上查找 SVN 根目录。

典型路径：

```text
{haruRoot}\Dev\Client\Log
```

如果无法从 `Application.dataPath` 找到 SVN 根：

1. 尝试从 `Application.dataPath` 判断是否位于 `Dev/Client/Assets` 下并反推出 `haruRoot`。
2. 再兜底使用后端已配置的 HaruRoot。
3. 都失败时返回 `GAME_LOG_STATUS`，提示“无法解析 WindowsEditor 日志路径”。

### 5.2 WindowsPlayer

优先由游戏进程自身路径推导。

典型路径：

```text
{haruRoot}\Product\Bin\Client\Win\Debug\Log
```

已验证当前进程：

```text
F:\HaruTrunk\Product\Bin\Client\Win\Debug\Application.exe
```

对应日志目录：

```text
F:\HaruTrunk\Product\Bin\Client\Win\Debug\Log
```

推荐 RuntimeGMClient 侧解析策略：

1. 使用 `Application.dataPath` 或 `Process.GetCurrentProcess().MainModule.FileName` 获取可执行文件目录。
2. 若当前目录下存在 `Log`，使用该目录。
3. 若路径能匹配 `Product/Bin/Client/Win/Debug`，使用该目录下 `Log`。
4. 兜底使用后端 HaruRoot 拼 `Product/Bin/Client/Win/Debug/Log`。

### 5.3 Android

使用：

```text
{Application.persistentDataPath}/log
```

典型展开：

```text
/storage/emulated/0/Android/data/{packageName}/files/log
```

已验证：

```text
/storage/emulated/0/Android/data/com.kurogame.haru/files/log
```

### 5.4 iOS

预期使用：

```text
{Application.persistentDataPath}/log
```

iOS 与 Android 同样应优先从 Unity `persistentDataPath` 推导，而不是由 Web 端手写沙盒路径。由于本轮未接入 iOS 真机，iOS 标记为待验证项。

## 6. 日志读取与切分策略

### 6.1 初次追回策略

写死参数：

```text
TAIL_BOOTSTRAP_BYTES = 512 KB
TAIL_BOOTSTRAP_MAX_ENTRIES = 2000
```

流程：

1. 找到最新 `.log` 文件。
2. 从文件尾部向前读取最多 `512KB`。
3. 如果读取起点落在半条日志中，丢弃第一个分隔线之前的残片。
4. 按分隔线切条目。
5. 最多提交最后 `2000` 条完整日志。
6. 后续进入实时 tail。

这个策略避免首次打开时读取几百 MB 日志，同时给足最近上下文。

### 6.2 实时 tail 策略

写死参数：

```text
TAIL_POLL_INTERVAL_MS = 300
TAIL_READ_CHUNK_BYTES = 64 KB
TAIL_PENDING_MAX_BYTES = 1 MB
```

流程：

1. 记录当前文件路径和 offset。
2. 定期检查文件大小和最新文件。
3. 文件增长时从 offset 读取新增字节，单次最多 `64KB`。
4. 新增文本追加到 pending buffer。
5. pending buffer 中出现分隔线时，提交完整条目。
6. 分隔线后的残余文本继续留在 pending buffer。

### 6.3 条目切分规则

主规则：

```regex
^=+$
```

即整行由等号组成时作为条目结束。

级别提取：

```regex
^<(Log|Warning|Error|Exception)>
```

时间提取：

```regex
\[(\d{4}/\d{2}/\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\]
```

兜底：

- 若条目没有 `<Log>` 头，level 记为 `info`。
- 若没有时间，使用后端接收时间或条目提交时间。
- 若长时间没有分隔线且 pending 超过 `1MB`，提交一个 `partial=true` 条目，并插入系统提示，避免内存无限增长。

### 6.4 文件轮转与清空

以下情况视为日志源变化：

1. 最新 `.log` 文件路径变化。
2. 当前文件 size 小于已记录 offset。
3. 当前文件消失。

处理：

1. 发送 `GAME_LOG_STATUS`：`rotated` / `truncated` / `missing`。
2. UI 插入系统提示行。
3. 重新选择最新日志文件。
4. 按初次追回策略读取新文件尾部。

## 7. 后端缓存策略

### 7.1 per-client 缓存

后端按 `client_id` 保留独立缓存：

```text
GAME_LOG_CACHE_MAX_ENTRIES = 5000
GAME_LOG_CACHE_MAX_BYTES = 5 MB
```

缓存内容：

```ts
type GameLogEntry = {
  seq: number
  clientId: string
  source: "game"
  level: "log" | "warning" | "error" | "exception" | "info"
  time?: string
  filePath: string
  offsetStart?: number
  offsetEnd?: number
  text: string
  previewText: string
  partial?: boolean
}
```

裁剪规则：

1. 优先按条数裁剪最旧 entries。
2. 如果总字节数仍超过 `5MB`，继续裁剪。
3. 裁剪后记录 `droppedCount`，前端显示“已省略 N 条较早日志”。

### 7.2 切客户端体验

前端切到某客户端时：

1. 立即展示该客户端后端缓存。
2. 若该客户端 tail session 未启动，启动 tail。
3. 若客户端已断开，展示最后缓存并标注“客户端已断开”。
4. 搜索词、过滤状态、滚动位置按客户端保留。

### 7.3 多前端连接

同一 `client_id` 只允许一个后端 tail session。

多个浏览器或多个页面查看同一客户端时：

1. 共享后端缓存。
2. 共享 RuntimeGMClient tail session。
3. 所有 WebSocket 订阅同一后端广播。
4. 最后一个前端订阅断开后，后端延迟 30 秒停止 tail，避免用户刷新页面导致频繁启停。

## 8. 前端交互规格

### 8.1 右侧日志卡片结构

原右侧“日志”卡片改为双模式：

```text
日志                          当前：samsung SM-N9760 · Android
[Web端日志] [游戏端日志]       搜索框...  Follow  Wrap  Pause  Clear
```

模式说明：

- `Web端日志`：保持当前 GM Console 内存日志行为。
- `游戏端日志`：展示当前选中客户端的真实游戏日志文件。

无选中客户端时：

```text
请选择一个客户端查看游戏端日志
```

广播模式下：

```text
游戏端日志不支持广播模式，请选择单个客户端
```

### 8.2 工具栏

P0 工具栏：

1. 搜索框：关键词过滤，默认大小写不敏感。
2. `Info` / `Warn` / `Error` 级别过滤。
3. `Follow`：自动滚动到底部，默认开启。
4. `Wrap`：自动换行，默认开启。
5. `Pause`：暂停前端追加显示，但后端继续缓存。
6. `Clear`：清空当前前端视图，不清后端缓存、不清原始文件。

P1 可选：

1. `Case`：大小写敏感。
2. `Regex`：正则搜索。
3. 上一个 / 下一个匹配跳转。
4. 导出当前筛选结果。

### 8.3 搜索行为

搜索只影响展示，不影响后端 tail。

规则：

1. 输入关键词后立即过滤当前客户端缓存。
2. 命中关键词高亮。
3. 显示命中计数：`23 / 1842`。
4. 搜索为空时显示全部可见日志。

### 8.4 日志行展示

每条日志默认最多展示 2 行。

样式：

1. 左侧用颜色表达 level。
2. 首行突出显示 `<Log>` / `<Warning>` / `<Error>` 和时间。
3. 超过 2 行时底部做轻微渐隐，提示这条还有更多内容。
4. 不在行尾放浮动按钮，避免遮挡和可发现性差。

交互：

1. 单击：选中该条日志，高亮背景。
2. 双击：打开完整日志详情弹窗。
3. 右键菜单可作为增强，但不作为主入口。

### 8.5 完整日志详情弹窗

触发方式：

```text
双击日志行
```

弹窗内容：

1. 标题：`日志详情`。
2. 副信息：level、时间、客户端、文件名、offset。
3. 正文：完整日志文本，保留换行和堆栈格式。
4. 搜索词高亮：沿用列表搜索词。
5. 操作：`复制全文`、`关闭`。

视觉风格：

1. 弹窗整体保持 GM Console 现有玻璃质感。
2. 正文区域使用深色 monospaced 代码面板。
3. 不做卡片套卡片。
4. 内容区支持纵向滚动和横向滚动，避免堆栈被压坏。

## 9. 协议设计

### 9.1 后端发往 RuntimeGMClient

```json
{
  "type": "GAME_LOG",
  "id": 1234,
  "action": "start",
  "bootstrapBytes": 524288,
  "maxEntries": 2000,
  "pollIntervalMs": 300,
  "readChunkBytes": 65536
}
```

停止：

```json
{
  "type": "GAME_LOG",
  "action": "stop"
}
```

### 9.2 RuntimeGMClient 发往后端

元信息：

```json
{
  "type": "GAME_LOG_META",
  "clientLogSessionId": "...",
  "platform": "Android",
  "logDir": "/storage/emulated/0/Android/data/com.kurogame.haru/files/log",
  "filePath": "/storage/emulated/0/Android/data/com.kurogame.haru/files/log/2026_06_15_22_59_38.log",
  "fileSize": 72361
}
```

日志条目：

```json
{
  "type": "GAME_LOG_ENTRY",
  "seq": 18,
  "level": "log",
  "time": "2026/06/15 23:03:06.9650",
  "filePath": "/storage/emulated/0/Android/data/com.kurogame.haru/files/log/2026_06_15_22_59_38.log",
  "offsetStart": 72880,
  "offsetEnd": 73286,
  "text": "<Log> LUA: ENCY_ANDROID_TAIL_MARK_230306965\tphysical-log-check\n\nXLua.StaticLuaCallbacks:Print(IntPtr)"
}
```

状态：

```json
{
  "type": "GAME_LOG_STATUS",
  "status": "rotated",
  "message": "日志文件已切换，正在读取新文件尾部",
  "filePath": "..."
}
```

### 9.3 前端 WebSocket

新增：

```text
WS /api/gm_console/ws/game-log?client_id={clientId}
```

初始化返回：

```json
{
  "type": "init",
  "clientId": "...",
  "entries": [],
  "droppedCount": 0,
  "meta": {
    "status": "starting"
  }
}
```

增量：

```json
{
  "type": "entries",
  "clientId": "...",
  "entries": []
}
```

状态：

```json
{
  "type": "status",
  "clientId": "...",
  "status": "missing",
  "message": "未找到日志文件"
}
```

## 10. 实施范围

### 10.1 `runtime_gm_client.lua`

新增 `LuaGameLogTail` 模块：

1. 平台路径解析。
2. 最新日志文件选择。
3. 初次追回。
4. 增量 tail。
5. 分隔线切分。
6. 文件轮转检测。
7. `RuntimeGMClient.ProcessPacket` 增加 `GAME_LOG` 分支。
8. `RuntimeGMClient.Update()` 中驱动 tail tick。

### 10.2 `server_mgr.py`

新增能力：

1. `send_game_log_command(client_id, action, options)`。
2. 游戏日志缓存结构。
3. `GAME_LOG_META` / `GAME_LOG_ENTRY` / `GAME_LOG_STATUS` packet 分发。
4. 按 `client_id` 管理 tail session。

### 10.3 `main.py`

新增：

1. `WS /ws/game-log`。
2. WebSocket 订阅池。
3. tail session 引用计数。
4. 断开延迟停止。

### 10.4 `GmConsole.jsx`

改造右侧日志区域：

1. `Web端日志` / `游戏端日志` segmented control。
2. 新增 game log 状态。
3. per-client UI 状态缓存。
4. 搜索 / 过滤 / Follow / Wrap / Pause / Clear。
5. 2 行折叠样式。
6. 双击详情弹窗。

## 11. 性能与完整性策略

### 11.1 性能边界

1. 初次只读尾部 `512KB`。
2. 单次增量最多 `64KB`。
3. 前端每个客户端最多显示后端缓存的 `5000` 条 / `5MB`。
4. 后端同一客户端只保留一个 tail session。
5. 前端暂停时不停止后端缓存，避免恢复后丢上下文。

### 11.2 完整性边界

Web 面板不是完整归档系统。

完整性承诺：

1. 已提交到原始日志文件的内容不会因为 Web 面板清空而丢失。
2. Web 面板会尽量保持实时连续性。
3. 若发生缓存裁剪、连接中断、文件轮转、pending 溢出，UI 必须明确提示。
4. P0 不保证 Web 面板保存从游戏启动以来的全部日志。

### 11.3 后续完整导出

P1 可以新增完整导出：

1. Windows：后端直接读取本机文件并下载。
2. Android：可通过 RuntimeGMClient 分片读取，或复用 ADB Master。
3. iOS：可通过 RuntimeGMClient 分片读取，或复用 iOS Master App Sandbox AFC。

P0 先实现“复制当前条目 / 复制当前筛选结果 / 查看缓存日志”，不把完整导出放入首版闭环。

## 12. 风险与处理

| 风险 | 影响 | 处理 |
|---|---|---|
| iOS 未验证 | iOS 路径可能与预期不同 | 首版标记待验证；接入真机后按 `persistentDataPath/log` 验证 |
| 某些日志没有分隔线 | 条目切分可能不完整 | 主规则用分隔线，pending 溢出时提交 partial |
| 日志刷屏过快 | GM TCP / 前端渲染压力增加 | 64KB 分片、后端裁剪、前端虚拟列表可作为 P1 |
| RuntimeGMClient 版本过旧 | 无法响应 `GAME_LOG` | 前端显示“客户端 RuntimeGM 版本不支持游戏端日志” |
| 文件轮转 | offset 失效 | 检测路径变化 / size 变小后重新 bootstrap |
| 超长单条堆栈 | UI 撑开 | 列表 2 行折叠，详情弹窗完整展示 |

## 13. 验收标准

### 13.1 WindowsPlayer

1. 选择 WindowsPlayer 客户端，切到 `游戏端日志`。
2. UI 显示当前日志文件路径。
3. 初次出现最近日志。
4. 执行 `print("marker")` 后，Web 日志面板出现同一 marker。
5. 双击该条日志可打开完整详情。

### 13.2 Android

1. 选择 Android 客户端，切到 `游戏端日志`。
2. UI 显示 `/storage/emulated/0/Android/data/{package}/files/log/...`。
3. 初次出现最近日志。
4. 执行 `print("marker")` 后，Web 日志面板出现同一 marker。
5. ADB 读取同一物理文件也能看到 marker。

### 13.3 客户端切换

1. Windows 和 Android 同时在线。
2. 切 Windows -> Android -> Windows，两个客户端各自日志不混。
3. 搜索词和滚动状态按客户端保留。
4. 已断开的客户端仍可看到最后缓存并显示断开状态。

### 13.4 搜索与详情

1. 搜索关键词后只显示匹配日志。
2. 命中关键词高亮。
3. 每条日志默认最多显示 2 行。
4. 双击任意日志打开详情弹窗。
5. 详情弹窗显示完整堆栈并支持复制全文。

## 14. 实施顺序

1. 新增后端缓存和 `/ws/game-log` 骨架，先返回空 init。
2. 在 RuntimeGMClient 增加日志路径解析和 `GAME_LOG_META`。
3. 实现 WindowsPlayer / Android 最新日志文件探测。
4. 实现初次追回和分隔线切分。
5. 实现实时 tail、轮转检测、状态事件。
6. 前端完成双模式日志面板和基础展示。
7. 前端完成搜索、过滤、Follow、Pause、Clear。
8. 前端完成 2 行折叠和双击详情弹窗。
9. 用 WindowsPlayer / Android 复测 marker。
10. 接入 iOS 真机后补验证与路径修正。

## 15. 当前决策记录

1. 游戏端日志读取真实物理日志文件，不监听日志写入动作。
2. 首次追回固定为 `512KB`，最多 `2000` 条。
3. 后端每客户端缓存固定为 `5000` 条或 `5MB`。
4. 单条日志列表默认最多显示 2 行。
5. 查看完整日志的主交互为双击日志行。
6. P0 不做完整日志导出，避免首版范围过大。
7. Android / WindowsPlayer 已完成真实路径与 marker 验证。
