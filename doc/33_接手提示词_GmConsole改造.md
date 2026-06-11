# GmConsole 单端口多路复用改造 — 接手提示词

## 项目概要

**EncyHub** 是一个开发工具聚合平台（Python FastAPI + React 前端），运行在 Windows 开发机上。其中 **GM Console** 模块用于远程调试 Unity 游戏——游戏内 Lua 代码通过 TCP 连接到开发机，Web 前端通过 EncyHub 中转与游戏通信。

## 本次改造做了什么

**核心理念**：过去每个分支/设备要指定不同 TCP 端口（默认 12581 起递增），改成了**所有设备统一连 12581 一个口**，靠 `IP-pid` 会话标识区分多设备。

**关键文件与职责**：

| 文件 | 角色 |
|---|---|
| `tools/gm_console/server_mgr.py` | TCP 服务器核心：Client 模型、两段式 ID(临时→`IP-pid`)、rekey、数据包分发 |
| `tools/gm_console/main.py` | FastAPI 入口：HTTP API、WebSocket 广播、截图端点 |
| `tools/gm_console/README_RuntimeGM_Client.md` | **Lua 源码**：游戏端 RuntimeGMClient 全部逻辑（~5000行） |
| `tools/gm_console/inject_runtime_gm.py` | 一键注入脚本：从 README 提取 Lua → 替换 IP → 追加到游戏入口 Lua 文件 |
| `frontend/src/pages/GmConsole.jsx` | 前端主页面：握手端口卡片、客户端列表、截图、平台 SVG 图标 |

## 架构关键点

### 两段式 ID 与会话标识
- accept 连接时分配**临时 ID** `temp:{ip}:{srcport}:{seq}`
- 收到 HELLO 包后 rekey 到**确定 ID** `{ip}-{pid}`（用 `-` 而非 `#`，因为 `#` 是 URL fragment 分隔符，会破坏代理路径）
- rekey 时严格按顺序：踢旧→删临时键→更新对象 id→写确定键→迁移附属状态(`_animator_list_cache`/`_pending_execs`)
- `_process_packet` 改为接收 `client_obj` 而非局部 `cid`，确保 rekey 后键不失效
- pid=0 时退化为 `{ip}-dev:{device}`

### SVN 用户名检测
- **原理**：读取 `%APPDATA%/Subversion/auth/svn.simple/` 下的认证缓存文件（明文用户名）
- **时机**：`Update()` 首帧（HELLO 已先发送完毕），通过追加 HELLO 包补送
- **选名策略**：最多出现次数优先，同点取较长用户名（排除 bot 短名如 `kuro`）
- **不依赖** `io.popen`/`Process.Start`——这些在 Unity Editor 的 XLua 环境下会阻塞/崩溃
- **仅在 SVN 工作副本**（上层目录有 `.svn`）+ Windows 环境有效；Android/iOS 无声跳过

### 截图功能
- 前端卡片 hover 显示相机按钮 → POST `/clients/{id}/screenshot` → Lua 侧 `ScreenCapture.CaptureScreenshotAsTexture()` → JPEG(品质60) → base64 → WebSocket 回传 → 前端 modal 展示
- 图像仅存在内存，断开即释放，不写入文件

### 平台图标
- `WindowsEditor`/`OSXEditor` → Unity 立方体图标（区分 Player）
- `WindowsPlayer` → Windows ⊞ 图标
- `OSXPlayer` → iMac 🖥 图标
- `Android` → 机器人图标
- `IPhonePlayer` → Apple 图标

### 前端 UI 设计
- 侧栏顶部「握手端口」卡片：只读、单行、绿色渐变 Radio 图标圈 + 脉动绿点 + `:12581`
- 客户端卡片：`IP(mono完整) · #pid · 作者(truncate)` — 一列不换行
- SVG 图标 hover 显示完整设备信息（device / ip / pid / platform / author）
- 多端口管理 UI 全部删除（`/listeners` API 已废弃）

## 启动与工作流

```bash
# EncyHub 本体（如果未运行）
python main.py

# 如果已运行，只重启 GM Console（热重载代码变更）
curl -X POST http://localhost:9524/api/hub/tools/gm_console/restart

# 注入最新 Lua 到游戏分支
python tools/gm_console/inject_runtime_gm.py

# 前端构建（dev 模式）
cd frontend && npx vite build --mode development

# 在线诊断（向已连接客户端发送 Lua）
curl -X POST "http://localhost:9524/api/gm_console/clients/{client_id}/exec-wait" \
  -H "Content-Type: application/json" \
  -d '{"cmd":"print('hello')", "timeout":10}'
```

## 已知注意事项

1. **Unity Editor 连接**：Editor 必须在 **Play Mode** 下 `Update()` 才会每帧执行，Edit Mode 下不会连接。
2. **SVN 用户名**：仅 Windows 有效；Android/iOS 无声跳过。多人共用机器时可能取到错误用户名（bot 短名优先问题已用「同点取长名」策略缓解）。
3. **`init_runtime_gm.py` 中的 `TARGET_LUA_FILES`**：维护分支列表的地方，增删分支改这里。
4. **端口 12581**：固定握手端口，服务器启动时自动监听。不要改。
5. **旧 `temp:` 残留**：客户端异常断开后可能残留临时 ID 条目，GM Console 重启即清除。
6. **`data/registry.json` 等 data 文件**：运行时的 pid/port 记录，**不要提交到 git**。
7. **XLua 环境差异**：C# `Process.Start` static 方法在 XLua 下报 `Non-static method requires a target`，用 Lua 原生 `io.popen` 替代（但截图/UI 功能不需要它）。

## Lua 代码结构速览（README_RuntimeGM_Client.md）

```
StartRuntimeGM()                    -- 主入口，创建 RuntimeGMClient 表
├── getDeviceInfo()                -- 平台/设备/pid 信息
├── tryGetSvnAuthor()              -- SVN 用户名检测（延迟到 Update 执行）
├── HookPrint / jsonEncode / jsonDecode
├── RuntimeGMClient.Connect()      -- TCP 连接 + HELLO 握手
├── RuntimeGMClient.Update()       -- 每帧：重连/心跳/接收/超时检测/SVN延迟
├── RuntimeGMClient.ProcessPacket()-- 服务端命令分发(EXEC/EXEC_GM/SCREENSHOT…)
├── LuaAnimatorMonitor             -- Animator 数据采集
├── LuaTimelineMonitor             -- Timeline 数据采集
├── LuaHierarchy / LuaHierarchyCore-- Hierarchy 反射
├── LuaUiInspector                 -- UI Inspector
├── SubPkgMonitor / PlayerPrefsMonitor / LuaAvMonitor / LuaTableMonitor
└── RuntimeGMClient.Start(host, port) -- 启动入口（创建 GameObject + XLuaBehaviour）
```

```
-- 末尾执行：
local ok, gmClient = pcall(StartRuntimeGM)
if ok and gmClient then
    gmClient.Start("10.101.0.8", 12581)
end
```

## 历史提交参考

- `474b959` — 设计方案书初版 + 音频 GM 命令
- `5e909ee` — 单端口多路复用核心实现
- `b02b36e` — 修复 Unity Editor 连接、SVN 延迟、平台图标、截图

`doc/32_设计方案书_GmConsole_单端口多路复用_会话标识改造.md` 有完整设计文档。
