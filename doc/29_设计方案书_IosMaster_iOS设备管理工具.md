# iOS Master 设计方案书

> EncyHub 新工具模块：iOS 设备管理工具
> 对标 ADB Master，基于 pymobiledevice3 实现

---

## 一、项目背景与目标

### 1.1 背景

EncyHub 已有 ADB Master 提供完整的 Android 设备管理能力。团队同时存在 iOS 设备调试需求，目前依赖爱思助手等第三方工具。经技术调研：

- **pymobiledevice3**（纯 Python，v9.12.0+）实现了 iOS 设备通信的完整协议栈
- 其技术原理与爱思助手底层使用的 libimobiledevice 同源，但以纯 Python 封装
- EncyHub 的 hub_core 架构（子进程 + HTTP/WS 代理）天然支持新增工具模块

### 1.2 目标

复刻 ADB Master 的交互体验，提供以下 iOS 设备管理能力：

| 能力 | 优先级 |
|------|--------|
| 设备发现与识别 | P0 |
| 设备信息查看 | P0 |
| 应用列表查看 | P0 |
| 文件传输（Media + App 沙盒） | P0 |
| 系统日志流（Syslog） | P0 |
| 截图 | P1 |
| 应用安装（IPA） | P1 |
| WiFi 连接 | P2 |

**明确不做**：屏幕投射/镜像（iOS 无开放协议，非越狱不可行）

### 1.3 技术选型

| 组件 | 选型 | 说明 |
|------|------|------|
| iOS 通信库 | pymobiledevice3 | `pip install pymobiledevice3`，纯 Python |
| 后端框架 | FastAPI + Uvicorn | 与 ADB Master 一致 |
| 前端 | React + Tailwind CSS | 复用 EncyHub 现有前端体系 |
| 进程管理 | hub_core 子进程模式 | 与现有工具一致 |

---

## 二、与 ADB Master 的功能对照

### 2.1 可直接对标的功能

| ADB Master 功能 | iOS Master 对应方案 | 差异说明 |
|-----------------|---------------------|----------|
| `adb devices` 设备列表 | `usbmux list` + Bonjour 发现 | 几乎一致 |
| `getprop` 设备信息 | `lockdown` 服务查询 | iOS 返回更丰富的信息（UDID/ECID/WiFi MAC 等） |
| `pm list packages` 应用列表 | `InstallationProxy` 服务 | iOS 返回 bundle ID + 版本 + 大小 + 签名信息 |
| `adb logcat` 日志流 | `syslog live` 流式输出 | 格式不同但概念一致 |
| `adb push/pull` 文件传输 | AFC 协议 + HouseArrest | **路径受限**，详见 2.2 |
| `adb install` 安装 APK | `apps install` 安装 IPA | 基本一致 |
| 前台应用查询 | `dvt running-processes` | 需 Developer Disk Image |
| WiFi 连接 | RemoteXPC 隧道 | iOS 17+ 需管理员权限 + PIN 配对 |

### 2.2 文件传输 — 关键差异详解

这是与 ADB Master 差异最大的部分：

**Android（ADB Master 做法）：**
- 用户输入任意设备路径（如 `/sdcard/Download/`）
- `adb push/pull` 直接操作

**iOS（AFC 受限模型）：**

```
访问模式一：Media 目录（通用）
  根路径：/var/mobile/Media/（AFC 服务看到的 "/"）
  可见目录：
    /DCIM/          — 相册
    /Downloads/     — 下载
    /Books/         — 图书
    /iTunes_Control/ — iTunes 媒体
    /Recordings/    — 录音
    /PhotoData/     — 照片元数据
  
访问模式二：App 沙盒（按 bundle ID）
  通过 HouseArrest 服务，指定 bundle ID 后进入该 App 的容器：
    /Documents/     — 文档目录（UIFileSharingEnabled 开启时）
    /Library/       — 库目录
    /tmp/           — 临时目录
  注意：并非所有 App 都开放沙盒访问
```

**设计决策**：不能照搬"输入任意路径"的交互，需要提供 **模式切换 + 目录选择器**。

### 2.3 明确砍掉的功能

| ADB Master 功能 | 砍掉原因 |
|-----------------|----------|
| Scrcpy 投屏控制 | iOS 无开放屏幕流协议，非越狱不可行 |
| APK 提取 | iOS 沙盒保护，非越狱无法读取 app bundle |
| `am force-stop` + monkey 重启应用 | iOS 无等效的命令行接口 |
| USB/WiFi 双连接统一 | iOS 设备 UDID 唯一，不存在 Android 的双 serial 问题 |

---

## 三、交互设计（复刻 ADB Master 布局）

### 3.1 整体布局 — 与 ADB Master 完全一致

```
┌──────────────────────────────────────────────────────────┐
│  ← iOS Master                                [刷新]     │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─ 设备列表 ────────────────────────────────────────┐   │
│  │ ┌─────────────────────┐ ┌─────────────────────┐   │   │
│  │ │ 📱 iPhone 15 Pro     │ │ 📱 iPad Air          │   │   │
│  │ │ UDID: 00008...       │ │ UDID: 00009...       │   │   │
│  │ │ iOS 18.1 · USB       │ │ iOS 17.5 · USB       │   │   │
│  │ │ [✓ 已选中]           │ │                       │   │   │
│  │ └─────────────────────┘ └─────────────────────┘   │   │
│  └───────────────────────────────────────────────────┘   │
│                                                          │
│  ── 设备详情（选中设备后展示）────────────────────────     │
│                                                          │
│  ▸ 设备信息         ← 可展开面板（默认展开）              │
│  ▸ Syslog 日志      ← 可展开面板（对标 Logcat）          │
│  ▸ 文件传输          ← 可展开面板（对标文件传输）          │
│  ▸ 应用管理          ← 可展开面板（对标应用提取）          │
│  ▸ 截图              ← 可展开面板（新增）                 │
│                                                          │
│  ── IPA 安装 ───────────────────────────────────────     │
│  [ 选择 IPA 文件 ]  [ 安装 ]                              │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 3.2 设备卡片

与 ADB Master 保持一致的卡片布局，信息映射：

```
┌─────────────────────────────────┐
│ 📱  [昵称] 或 iPhone 15 Pro      │   ← 支持编辑昵称（同 ADB Master）
│     UDID: 00008110-...           │   ← 对应 ADB 的 hardware_id
│     iOS 18.1.1                   │   ← 对应 Android 版本
│     ┌───────┐                    │
│     │  USB  │                    │   ← 连接类型标签
│     └───────┘                    │
└─────────────────────────────────┘
```

### 3.3 设备信息面板（新增，ADB Master 无此面板）

由于 iOS 通过 lockdown 服务可获取非常丰富的设备信息，新增专门的信息展示面板：

```
▼ 设备信息
┌──────────────────────────────────────────────┐
│  设备名称    iPhone 15 Pro                     │
│  型号       iPhone16,1                         │
│  iOS 版本   18.1.1 (Build 22B83)              │
│  UDID       00008110-001A3...                 │
│  序列号     DNPXXXXXXXX                       │
│  WiFi MAC   AA:BB:CC:DD:EE:FF                │
│  存储空间   128 GB（可用 52.3 GB）             │
│  电池电量   87% · 充电中                       │
│  芯片       A17 Pro                            │
└──────────────────────────────────────────────┘
```

### 3.4 Syslog 日志面板（对标 Logcat）

交互完全复刻 ADB Master 的 Logcat 面板：

```
▼ Syslog 日志                           [ ● 运行中 ] [ 停止 ]
┌──────────────────────────────────────────────────────────┐
│  [滚动日志区域，WebSocket 实时推送]                        │
│                                                          │
│  May  9 14:23:01 iPhone kernel[0]: ...                  │
│  May  9 14:23:02 iPhone SpringBoard[64]: ...            │
│  May  9 14:23:02 iPhone WeChat[1234]: ...               │
│                                                          │
│  ─────────────────── 自动滚动到底部 ──────────────────── │
└──────────────────────────────────────────────────────────┘
```

**技术实现**：pymobiledevice3 的 `SyslogService` 提供 `watch()` 流式接口，通过 WebSocket 转发到前端，与 ADB Master 的 logcat WebSocket 架构一致。

### 3.5 文件传输面板（适配 iOS 的核心改造）

这是与 ADB Master 差异最大的面板。ADB Master 用"输入任意路径"，iOS 需要改为 **模式切换**：

```
▼ 文件传输
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  访问模式：  [● Media 目录]  [○ App 沙盒]                │
│                                                          │
│  ═══ Media 目录模式 ═══                                  │
│                                                          │
│  ┄ 推送文件 (本地 → 设备) ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄     │
│                                                          │
│  [本机模式]                                               │
│  部署机路径    [D:\project\assets          ] [📂]        │
│  设备目标目录  [ /Downloads/               ] ▼           │
│                ┌────────────────────────┐                │
│                │ /Downloads/            │  ← 预设可选     │
│                │ /DCIM/                 │     目录列表    │
│                │ /Books/               │                │
│                │ /Recordings/          │                │
│                │ (手动输入其他路径)      │                │
│                └────────────────────────┘                │
│  [ 推送 ]                                                │
│                                                          │
│  [远程模式]                                               │
│  [ 点击选择文件（文件夹请压缩为 zip）]                    │
│  设备目标目录  [ /Downloads/               ]              │
│  [ 推送 ]                                                │
│                                                          │
│  ┄ 拉取文件 (设备 → 本地) ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄     │
│                                                          │
│  设备文件路径  [ /DCIM/100APPLE/IMG_001.JPG ] [浏览..] │
│  本地保存路径  [ D:\Downloads                ]           │
│  [ 拉取 ]                                                │
│                                                          │
│  ═══ App 沙盒模式 ═══（切换后）                          │
│                                                          │
│  选择应用    [ com.tencent.xin (微信)      ] ▼           │
│              ┌────────────────────────────────┐          │
│              │ com.tencent.xin    微信         │          │
│              │ com.ss.iphone     抖音          │          │
│              │ com.netease.game  某游戏        │          │
│              └────────────────────────────────┘          │
│  ⚠ 注意：仅开启了 UIFileSharingEnabled 的 App 可访问     │
│                                                          │
│  沙盒路径    [ /Documents/                 ]              │
│  ┄ (推送/拉取交互同上) ┄                                  │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**与 ADB Master 的对比：**

| 方面 | ADB Master | iOS Master |
|------|-----------|------------|
| 路径输入 | 自由文本输入 `/sdcard/xxx` | 模式切换 + 下拉选择预设目录 |
| 路径历史 | 有，下拉展示 | 有，同样保留历史记录 |
| 浏览设备文件系统 | 无（直接输入路径） | **新增**：AFC 支持 `ls`，可提供简易文件浏览器 |
| 本机/远程模式 | 有（isLocalhost 判断） | 完全复用同样的逻辑 |
| zip 自动解压 | 有 | 有，复用同样的逻辑 |

### 3.6 应用管理面板（对标"应用提取"改为"应用管理"）

ADB Master 的应用面板叫"应用提取"，支持列出 App + 提取 APK。iOS 不能提取 IPA，所以改为"应用管理"：

```
▼ 应用管理                                      [🔄 刷新列表]
┌──────────────────────────────────────────────────────────┐
│  [🔍 搜索 App...                                ]       │
│                                                          │
│  ┌────────────────────────────────────────────────┐      │
│  │ 📦 com.tencent.xin                             │      │
│  │    微信 · 8.0.43 · 452.3 MB                    │      │
│  │    [ 卸载 ]                                     │      │
│  ├────────────────────────────────────────────────┤      │
│  │ 📦 com.ss.iphone.ugc.Aweme                     │      │
│  │    抖音 · 29.5.0 · 621.1 MB                    │      │
│  │    [ 卸载 ]                                     │      │
│  ├────────────────────────────────────────────────┤      │
│  │ 📦 com.apple.mobilesafari                      │      │
│  │    Safari · 18.1 · (系统应用)                   │      │
│  │                                                 │      │
│  └────────────────────────────────────────────────┘      │
│                                                          │
│  显示: [● 第三方应用] [○ 全部应用]  共 127 个应用        │
└──────────────────────────────────────────────────────────┘
```

**与 ADB Master 的对比：**

| 方面 | ADB Master | iOS Master |
|------|-----------|------------|
| 列出 App | `pm list packages` + `stat` | `InstallationProxy`（信息更丰富） |
| 搜索过滤 | 有 | 有，完全复刻 |
| 提取 APK/IPA | 有（核心功能） | **不做**（iOS 沙盒限制） |
| 卸载 App | 无 | **新增**（pymobiledevice3 支持） |
| App 详情 | 包名 + 路径 + 大小 | Bundle ID + 显示名 + 版本 + 大小 + 签名类型 |

### 3.7 截图面板（新增）

ADB Master 没有截图功能，iOS Master 新增此面板作为"投屏"的轻量替代：

```
▼ 截图
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  [ 📸 截取当前屏幕 ]                                     │
│                                                          │
│  ┌───────────────────┐                                   │
│  │                   │                                   │
│  │   (截图预览区)     │   最近截图时间: 14:23:01          │
│  │                   │   分辨率: 2556 × 1179             │
│  │                   │                                   │
│  │                   │   [ 💾 保存到本地 ]                │
│  │                   │   [ 📋 复制到剪贴板 ]              │
│  │                   │                                   │
│  └───────────────────┘                                   │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**技术实现**：pymobiledevice3 `developer dvt screenshot` 返回 PNG 字节流。需要先挂载 Developer Disk Image（`mounter auto-mount`），iOS 17+ 需要建立 tunnel。

### 3.8 IPA 安装（对标 APK 安装）

与 ADB Master 的 APK 安装交互完全一致，放在页面底部：

```
── IPA 安装 ──────────────────────────────────────────────
┌──────────────────────────────────────────────────────────┐
│  [ 点击选择 IPA 文件 ]                                   │
│  MyApp.ipa · 45.2 MB                                     │
│  ┌─────────────────────────────────────┐                 │
│  │ ████████████████████░░░░░  78%      │ 安装中...       │
│  └─────────────────────────────────────┘                 │
│  [ 安装 ]                                                │
└──────────────────────────────────────────────────────────┘
```

---

## 四、技术架构

### 4.1 模块结构

```
tools/ios_master/
├── __init__.py
├── main.py                  # FastAPI 入口，所有 REST/WS 端点
├── ios_device_manager.py    # 核心：封装 pymobiledevice3 的设备操作
├── config_manager.py        # 设备配置持久化（复用 ADB Master 模式）
└── path_utils.py            # 路径工具

frontend/src/pages/
└── IosMaster.jsx            # iOS Master 页面组件

data/ios_master/
├── config.json              # 设备昵称、连接历史等
└── Devices/{udid}/
    └── Local_Sync_Area/     # 本地同步目录
```

### 4.2 后端 API 设计

对标 ADB Master 的 API 结构：

```
GET    /devices                     # 设备列表
GET    /devices/{udid}/info         # 设备详细信息
GET    /devices/{udid}/apps         # 应用列表
POST   /devices/{udid}/apps/uninstall  # 卸载应用
POST   /devices/{udid}/push        # 推送文件（Media 模式）
POST   /devices/{udid}/pull        # 拉取文件
POST   /devices/{udid}/push-upload # 远程上传推送
GET    /devices/{udid}/pull-download # 拉取并下载
POST   /devices/{udid}/push-app    # 推送到 App 沙盒
POST   /devices/{udid}/pull-app    # 从 App 沙盒拉取
POST   /devices/{udid}/afc/ls      # 列出 AFC 目录
POST   /devices/{udid}/app-afc/ls  # 列出 App 沙盒目录
POST   /devices/{udid}/screenshot   # 截图
POST   /devices/{udid}/install-ipa  # 安装 IPA
WS     /devices/{udid}/syslog      # Syslog 实时流
GET    /path-history/push          # 推送路径历史
GET    /path-history/pull          # 拉取路径历史
PATCH  /devices/{udid}/nickname    # 修改设备昵称
```

### 4.3 ios_device_manager.py 核心类设计

```python
class iOSDeviceManager:
    """封装 pymobiledevice3，提供与 AdbManager 对称的接口。"""
    
    # ── 设备发现 ──
    async def get_devices() -> list[iOSDevice]
        # usbmux.list_devices() + lockdown 查询基础信息
    
    async def get_device_info(udid: str) -> dict
        # LockdownClient 查询完整设备信息
    
    # ── 应用管理 ──
    async def list_apps(udid: str, app_type: str = "User") -> list[AppInfo]
        # InstallationProxy.get_apps()
    
    async def install_ipa(udid: str, ipa_path: str, on_progress) -> bool
        # InstallationProxy.install()
    
    async def uninstall_app(udid: str, bundle_id: str) -> bool
        # InstallationProxy.uninstall()
    
    # ── 文件传输（Media） ──
    async def afc_ls(udid: str, path: str) -> list[FileEntry]
        # AfcService.listdir()
    
    async def afc_push(udid: str, local_path: str, remote_path: str) -> (bool, str)
        # AfcService.push() — 写入到 /var/mobile/Media 下
    
    async def afc_pull(udid: str, remote_path: str, local_path: str) -> (bool, str)
        # AfcService.pull()
    
    # ── 文件传输（App 沙盒） ──
    async def app_afc_ls(udid: str, bundle_id: str, path: str) -> list[FileEntry]
        # HouseArrestService + AfcService.listdir()
    
    async def app_afc_push(udid: str, bundle_id: str, local: str, remote: str)
        # HouseArrestService + AfcService.push()
    
    async def app_afc_pull(udid: str, bundle_id: str, remote: str, local: str)
        # HouseArrestService + AfcService.pull()
    
    # ── 日志 ──
    async def stream_syslog(udid: str, on_line: Callable)
        # SyslogService.watch() 流式回调
    
    # ── 截图 ──
    async def take_screenshot(udid: str) -> bytes
        # DvtSecureSocketProxyService.screenshot()
        # 需先 auto-mount Developer Disk Image
```

### 4.4 pymobiledevice3 调用方式

pymobiledevice3 提供两种使用方式：

1. **CLI 调用**（类似 ADB Master 调用 `adb.exe`）：
   ```bash
   pymobiledevice3 usbmux list
   pymobiledevice3 afc pull /DCIM/100APPLE/IMG_001.JPG ./
   pymobiledevice3 syslog live
   ```

2. **Python API 调用**（推荐，更灵活）：
   ```python
   from pymobiledevice3.usbmux import list_devices
   from pymobiledevice3.lockdown import create_using_usbmux
   from pymobiledevice3.services.afc import AfcService
   from pymobiledevice3.services.syslog import SyslogService
   from pymobiledevice3.services.installation_proxy import InstallationProxyService
   from pymobiledevice3.services.house_arrest import HouseArrestService
   ```

**设计决策：优先使用 Python API**，避免子进程开销，且能获得更好的错误处理和类型安全。这与 ADB Master 调用 `adb.exe` 的方式不同，但更高效。若 API 调用遇到阻塞问题（pymobiledevice3 部分接口是同步的），使用 `asyncio.to_thread()` 包装。

### 4.5 设备身份管理

| | ADB Master | iOS Master |
|-|-----------|------------|
| 物理设备唯一标识 | `ro.serialno`（需通过 getprop 查） | `UDID`（usbmux 直接返回） |
| 多连接问题 | 同一设备 USB/WiFi 两个 serial | **不存在**，UDID 始终唯一 |
| 配置 key | `hardware_id`（做 safe 化处理） | `udid`（直接使用） |

iOS 的 UDID 是设备原生唯一标识，不存在 ADB Master 的 UnifiedDevice 复杂性。

---

## 五、实施计划

### Phase 1：基础框架 + 设备发现（1 天）

- 创建 `tools/ios_master/` 模块骨架
- 注册到 `data/registry.json`
- 实现 `ios_device_manager.py` 的设备发现和信息查询
- 前端 `IosMaster.jsx` 设备列表 + 设备卡片 + 设备信息面板
- 路由注册到 `App.jsx`

### Phase 2：应用管理 + Syslog（1-2 天）

- 实现应用列表接口（InstallationProxy）
- 前端应用管理面板（列表 + 搜索 + 卸载）
- 实现 Syslog WebSocket 流
- 前端 Syslog 面板（复刻 Logcat 面板交互）

### Phase 3：文件传输（1-2 天）

- 实现 AFC push/pull（Media 目录）
- 实现 HouseArrest push/pull（App 沙盒）
- 实现 AFC ls（目录浏览）
- 前端文件传输面板（模式切换 + 预设目录 + 路径历史）
- 远程上传/下载模式

### Phase 4：截图 + IPA 安装（1 天）

- 实现截图接口（需处理 Developer Disk Image 挂载）
- 前端截图面板
- 实现 IPA 安装（上传 + 安装进度）
- 前端 IPA 安装区域

### Phase 5（可选）：WiFi 连接

- RemoteXPC 隧道建立（需管理员权限）
- 前端配对向导

---

## 六、风险与注意事项

### 6.1 pymobiledevice3 同步 API 问题

pymobiledevice3 的部分服务接口是同步阻塞的（如 `AfcService.pull()`）。在 FastAPI 的 async handler 中需要使用 `asyncio.to_thread()` 包装，避免阻塞事件循环。

### 6.2 iOS 17+ 的 tunnel 要求

iOS 17 开始，developer 服务（截图、进程列表等）需要通过 RemoteXPC tunnel 访问，这需要：
- Windows 上需要管理员权限运行 `pymobiledevice3 remote start-tunnel`
- 建议在 Phase 1 先支持 iOS 16 及以下的简单路径，Phase 4 再处理 17+ 的 tunnel

### 6.3 首次连接信任

iOS 设备首次连接电脑需要在设备上点击"信任此电脑"。这与 Android 的 USB 调试授权类似，需要在 UI 上给出明确提示。

### 6.4 依赖安装

`pymobiledevice3` 依赖较重（加密、网络等），需确认与 EncyHub 现有依赖无冲突。建议在 `pyproject.toml` 中添加为可选依赖：

```toml
[project.optional-dependencies]
ios = ["pymobiledevice3>=9.0.0"]
```

### 6.5 Windows 上的 USB 驱动

iOS 设备在 Windows 上需要 iTunes 或 Apple Mobile Device Support 驱动。爱思助手已安装，其安装的驱动应该可以复用。若用户未安装任何 iTunes 相关组件，需提示安装 Apple Mobile Device Support。

---

## 七、苏格拉底检查

以下是对本设计方案的自我质疑与回答：

### Q1: 为什么选 pymobiledevice3 而不是直接调用 libimobiledevice 的 CLI 工具？

**质疑**：ADB Master 直接调用 `adb.exe`，为什么 iOS Master 不也直接调用 `ideviceinfo`、`idevicepair` 等 libimobiledevice CLI？

**回答**：三个原因：
1. **libimobiledevice 在 Windows 上编译困难**——需要自行编译 C 项目及其依赖链（libplist、libusbmuxd、libimobiledevice），而 pymobiledevice3 是 `pip install` 即用
2. **pymobiledevice3 是纯 Python**——可以直接 import 使用 Python API，避免子进程开销和输出解析
3. **pymobiledevice3 更活跃**——支持 iOS 17+的 RemoteXPC/tunneld，libimobiledevice CLI 对此支持不完整

**反驳自己**：但 pymobiledevice3 是 GPL-3.0 协议，如果 EncyHub 要商业分发需注意许可证兼容性。当前作为内部工具使用没有问题。

### Q2: 文件传输的"模式切换"设计会不会让用户困惑？

**质疑**：ADB Master 只有一个路径输入框，简单直接。iOS Master 引入"Media 目录"和"App 沙盒"两个模式，是否过度设计？

**回答**：这不是设计选择，而是 iOS 的技术现实。AFC 和 HouseArrest 是两个不同的服务，访问的根目录不同，鉴权方式不同。如果用一个输入框：
- 用户输入 `/DCIM/photo.jpg` → 应该走 AFC
- 用户输入 `com.tencent.xin:/Documents/file.txt` → 应该走 HouseArrest

这种"路径里编码 bundle ID"的方式更令人困惑。显式的模式切换更清晰。

**改进方向**：默认选中"Media 目录"模式（最常用），App 沙盒模式用标签页切换而非显眼的 radio button，降低认知负担。

### Q3: 不做投屏和 APK 提取，iOS Master 的价值够大吗？

**质疑**：砍掉投屏和 App 提取后，剩下的功能（设备信息、文件传输、日志、截图）是否值得做一个完整的工具？

**回答**：
1. **设备信息 + 日志流**在调试时非常高频——这正是团队现在用爱思助手做的事
2. **文件传输**解决了"从 iOS 设备拉取日志/配置/截图"的实际需求
3. **应用管理**提供快速查看设备上装了什么、版本是多少的能力
4. **截图**作为投屏的轻量替代，满足"看一眼当前画面"的需求

这些功能组合在一起，覆盖了日常 iOS 设备调试 80% 的场景。爱思助手虽然功能更多，但它是一个独立的桌面软件——整合到 EncyHub 的 Web 界面里，与 ADB Master 并列管理 Android/iOS 设备，本身就是价值。

### Q4: pymobiledevice3 的稳定性能否满足生产使用？

**质疑**：pymobiledevice3 是第三方开源库，不是 Apple 官方工具。在 Windows 上的稳定性如何？会不会遇到各种莫名其妙的问题？

**回答**：风险确实存在：
- **USB 连接稳定性**：依赖 Windows 上的 Apple 驱动，可能有兼容性问题
- **iOS 版本兼容性**：每次 iOS 大版本更新可能需要等 pymobiledevice3 跟进
- **部分 API 可能不稳定**：尤其是 iOS 17+ 的 tunnel 机制

**缓解措施**：
1. Phase 1 先做最基础的 USB + lockdown，这条路径最稳定
2. 对所有 pymobiledevice3 调用做异常捕获和友好错误提示
3. 在 UI 上显示 pymobiledevice3 版本和 iOS 版本兼容性状态

### Q5: 为什么不直接调用爱思助手的 DLL？

**质疑**：用户已经安装了爱思助手，里面有完整的 `idm_*.dll` 模块。为什么不直接 ctypes 调用这些 DLL？

**回答**：
1. **逆向成本极高**——这些是闭源的商业 DLL，没有头文件、没有文档，接口需要完全逆向
2. **法律风险**——直接调用商业软件的私有 DLL 可能违反使用协议
3. **版本耦合**——爱思助手更新后 DLL 接口可能变化，导致 iOS Master 崩溃
4. **pymobiledevice3 已经够用**——它实现了我们需要的所有功能，且是开源的

爱思助手的分析价值在于**验证了技术路线的可行性**（它底层也用 libimobiledevice 生态），而非提供可复用的组件。

### Q6: 设备发现用轮询还是事件驱动？

**质疑**：ADB Master 用 3 秒轮询 `adb devices`。iOS Master 是否应该改为事件驱动（usbmux 支持 listen 模式）？

**回答**：两种方案各有利弊：
- **轮询**（3 秒）：简单、与 ADB Master 一致、不需要维护长连接
- **事件驱动**（usbmux listen）：响应更快、资源更少，但需要维护一个持续的 usbmux 连接

**决策**：Phase 1 用轮询（与 ADB Master 保持一致），后续可优化为事件驱动。一致的架构降低维护成本。

### Q7: config.json 是否应该与 ADB Master 共享结构？

**质疑**：两个工具的 config 结构很相似（昵称、连接历史、路径历史）。要不要抽取公共的 config 模式？

**回答**：不要。原因：
1. ADB Master 的 config 结构是为 Android 的双 serial 问题设计的（`hardware_id` → `safe_id` 转换），iOS 不需要
2. 两个工具独立迭代，共享 config 会带来耦合
3. 复制粘贴 `config_manager.py` 并简化，比抽象更务实

---

## 附录 A：ADB Master 完整功能清单与 iOS 映射

| # | ADB Master 功能 | iOS Master | 状态 |
|---|----------------|------------|------|
| 1 | 设备列表（USB + WiFi） | 设备列表（USB） | Phase 1 |
| 2 | 设备信息（model, serial） | 设备信息（丰富） | Phase 1 |
| 3 | 设备昵称编辑 | 设备昵称编辑 | Phase 1 |
| 4 | WiFi 连接（tcpip/pair） | WiFi 连接（tunnel） | Phase 5 |
| 5 | WiFi 断开 | WiFi 断开 | Phase 5 |
| 6 | WiFi 重连 | — | — |
| 7 | Logcat 日志流 | Syslog 日志流 | Phase 2 |
| 8 | 文件推送（本机路径） | AFC 推送（Media/App沙盒） | Phase 3 |
| 9 | 文件推送（远程上传） | AFC 推送（远程上传） | Phase 3 |
| 10 | 文件拉取（到本机） | AFC 拉取（到本机） | Phase 3 |
| 11 | 文件拉取（下载到浏览器） | AFC 拉取（下载到浏览器） | Phase 3 |
| 12 | 推送/拉取路径历史 | 推送/拉取路径历史 | Phase 3 |
| 13 | 应用列表 | 应用列表（更详细） | Phase 2 |
| 14 | 应用搜索 | 应用搜索 | Phase 2 |
| 15 | APK 提取 | ~~IPA 提取~~ | 不做 |
| 16 | APK 安装 | IPA 安装 | Phase 4 |
| 17 | 前台应用查询 | — (需 DDI) | Phase 4 |
| 18 | 应用重启 | — | 不做 |
| 19 | Scrcpy 投屏 | ~~投屏~~ | 不做 |
| 20 | 投屏触控 | ~~触控~~ | 不做 |
| 21 | — | 截图 | Phase 4（新增） |
| 22 | — | 应用卸载 | Phase 2（新增） |
| 23 | — | 设备文件浏览器 | Phase 3（新增） |

---

## 附录 B：pymobiledevice3 关键 API 速查

```python
# 设备发现
from pymobiledevice3.usbmux import list_devices
devices = list_devices()  # 返回 [MuxDevice(udid=..., ...)]

# 建立 lockdown 连接
from pymobiledevice3.lockdown import create_using_usbmux
lockdown = create_using_usbmux(udid="...")

# 设备信息
info = lockdown.all_values  # dict: DeviceName, ProductType, ProductVersion, ...

# 应用列表
from pymobiledevice3.services.installation_proxy import InstallationProxyService
with InstallationProxyService(lockdown) as proxy:
    apps = proxy.get_apps("User")  # or "System" or "Any"

# AFC 文件操作
from pymobiledevice3.services.afc import AfcService
with AfcService(lockdown) as afc:
    afc.listdir("/")        # ls /var/mobile/Media/
    afc.push("local.txt", "/Downloads/remote.txt")
    afc.pull("/DCIM/img.jpg", "local.jpg")

# App 沙盒访问
from pymobiledevice3.services.house_arrest import HouseArrestService
with HouseArrestService(lockdown, bundle_id="com.example.app") as afc:
    afc.listdir("/Documents/")

# Syslog
from pymobiledevice3.services.syslog import SyslogService
with SyslogService(lockdown) as syslog:
    for line in syslog.watch():
        print(line)

# 截图（需 Developer Disk Image）
from pymobiledevice3.services.dvt.dvt_secure_socket_proxy import DvtSecureSocketProxyService
from pymobiledevice3.services.dvt.instruments.screenshot import Screenshot
with DvtSecureSocketProxyService(lockdown) as dvt:
    png_bytes = Screenshot(dvt).get_screenshot()

# IPA 安装
from pymobiledevice3.services.installation_proxy import InstallationProxyService
with InstallationProxyService(lockdown) as proxy:
    proxy.install_from_local(ipa_path)
```
