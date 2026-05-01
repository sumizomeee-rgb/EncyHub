# ADB Master × APK 提取功能集成 —— 施工方案书

> **版本**: v1.0
> **日期**: 2026-03-19
> **施工范围**: 在 ADB Master 现有面板体系中新增「应用提取」可展开面板，支持浏览设备已安装应用、勾选并批量提取 APK

---

## 一、需求背景

当前 ADB Master 已支持 APK 安装（推送并安装 APK 到设备），但缺少**反向操作** —— 从设备中提取已安装应用的 APK 文件。

**使用场景**：
- 备份模拟器/真机上的特定应用（如 CX 文件管理器、调试用 APK 等）
- 提取未在应用市场上架的内部版本 APK
- 跨设备迁移应用（从一台设备提取后安装到另一台）

**验证结论**：
前期已通过命令行脚本验证了完整的技术路径：
`pm list packages -3` → `pm path <pkg>` → `adb exec-out cat <path>` → 本地保存
该路径在模拟器上实测成功提取 14 个应用（含 2GB+ 大型 APK），方案可行。

> ⚠️ **Git Bash 路径转换问题**：已确认 `adb pull` 在 Git Bash 环境下会被 MSYS 路径转换机制干扰（`/data/app/...` 被转为 `D:/Program Files/Git/data/app/...`）。Python 后端不受此影响，因此集成时使用 Python 的 `asyncio.subprocess` 直接调用 ADB 即可规避。

---

## 二、总体设计

### 2.1 目标

在 ADB Master 的 Web 控制中心中，新增一个 **[应用提取]** 可展开面板（与 [Logcat 日志]、[文件传输]、[投屏控制] 同级），提供以下能力：

- ✅ 一键扫描设备已安装应用列表（第三方 / 全部可切换）
- ✅ 列表展示包名、应用名（如可获取）、APK 大小
- ✅ 支持全选 / 反选 / 单独勾选
- ✅ 批量提取选中应用的 APK 到本地指定目录
- ✅ 实时显示提取进度（当前第 N/M 个，传输速度，已完成大小）
- ✅ 提取完成后可一键打开输出目录

### 2.2 UI 交互流程

```
用户选中设备 → 展开「应用提取」面板
                    │
                    ▼
         ┌─────────────────────────┐
         │  [刷新应用列表] 按钮     │
         │  [○ 仅第三方] [○ 全部]   │
         └────────────┬────────────┘
                      │ 点击刷新
                      ▼
         ┌─────────────────────────────────────┐
         │  ☐ 全选                    已选: 3/14 │
         │  ─────────────────────────────────── │
         │  ☑ com.cxinventor.file.explorer  17M │
         │  ☑ bin.mt.plus                   20M │
         │  ☐ com.android.chrome            53M │
         │  ☑ tv.danmaku.bili              112M │
         │  ☐ com.kurogame.haru.bilibili   2.0G │
         │  ...                                 │
         └────────────┬────────────────────────┘
                      │
         ┌────────────┴────────────┐
         │  保存到: [D:\apk_backup]│ [📂]
         │  [开始提取 (3个, ~149M)] │
         └────────────┬────────────┘
                      │ 点击提取
                      ▼
         ┌─────────────────────────────────────┐
         │  提取进度: 2/3                       │
         │  ████████████░░░░░░░ 67%             │
         │  当前: tv.danmaku.bili (112M)         │
         │  速度: 29.4 MB/s                     │
         │                           [取消提取]  │
         └────────────┬────────────────────────┘
                      │ 全部完成
                      ▼
         ┌─────────────────────────────────────┐
         │  ✅ 提取完成: 3/3 成功               │
         │  总大小: 149M                        │
         │  [打开输出目录] [继续提取]            │
         └─────────────────────────────────────┘
```

### 2.3 不做什么（边界）

- ❌ 不解析 APK 内部信息（如 AndroidManifest、签名等） —— 超出工具定位
- ❌ 不支持 Split APK 合并（多 APK 场景仅提取 base.apk） —— 可在后续迭代
- ❌ 不支持系统签名应用提取（部分受限应用 `pm path` 可能失败） —— 静默跳过并报告

---

## 三、技术方案

### 3.1 后端新增（Python / FastAPI）

#### 3.1.1 `adb_manager.py` 新增方法

在现有 `AdbManager` 类中添加以下方法：

```python
async def list_packages(self, serial: str, third_party_only: bool = True) -> list[dict]:
    """
    获取设备已安装应用列表
    返回: [{"package": "com.example.app", "apk_path": "/data/app/.../base.apk", "size_bytes": 12345678}, ...]
    """

async def extract_apk(self, serial: str, package: str, local_path: str,
                       progress_callback=None) -> dict:
    """
    提取单个 APK 到本地
    使用 adb exec-out cat <apk_path> 流式写入本地文件
    返回: {"success": True, "size_bytes": ..., "elapsed_sec": ...}
    """
```

**实现要点**：
- `list_packages`: 执行 `pm list packages [-3]`，然后批量执行 `pm path` + `stat -c %s` 获取路径和大小
- `extract_apk`: 使用 `adb exec-out cat <path>` 替代 `adb pull`，通过 `asyncio.subprocess` 的 `stdout` 流式读取写入本地文件，每读取一个 chunk 调用 `progress_callback` 上报进度
- 大小获取优化：可对 `stat` 批量执行（通过 `adb shell` 单次会话减少 round-trip）

#### 3.1.2 `main.py` 新增 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/devices/{hw_id}/packages` | 获取应用列表。查询参数: `third_party_only=true` |
| `POST` | `/devices/{hw_id}/extract-apk` | 提取单个 APK。Body: `{"package": "...", "local_dir": "..."}` |
| `POST` | `/devices/{hw_id}/extract-apks` | 批量提取。Body: `{"packages": [...], "local_dir": "..."}` |
| `WebSocket` | `/devices/{hw_id}/extract-progress` | 实时进度推送（可选，备选方案用 SSE） |

**批量提取端点设计**：
- 采用 SSE（Server-Sent Events）流式返回每个包的提取进度
- 每完成一个包发送一条事件：`{"package": "...", "status": "done", "size_bytes": ..., "current": 2, "total": 5}`
- 客户端通过 `EventSource` 或 `fetch` + `ReadableStream` 接收

> **为什么用 SSE 而不是 WebSocket**：提取进度是单向推送场景（服务端 → 客户端），SSE 语义更匹配且实现更轻量。WebSocket 作为备选，若后续需要客户端发送取消指令可切换。

#### 3.1.3 取消提取机制

- 后端维护一个 `Dict[hw_id, asyncio.Event]` 的取消信号映射
- 前端发送 `DELETE /devices/{hw_id}/extract-apks` 时设置事件
- `extract_apk` 方法在每个 chunk 读取后检查取消信号

### 3.2 前端新增（React / JSX）

#### 3.2.1 新增 State

```jsx
// 应用提取面板
const [expandExtract, setExpandExtract] = useState(false)
const [packages, setPackages] = useState([])         // [{package, apk_path, size_bytes}, ...]
const [selectedPkgs, setSelectedPkgs] = useState(new Set())
const [pkgFilter, setPkgFilter] = useState('third_party') // 'third_party' | 'all'
const [extractDir, setExtractDir] = useState(() =>
  localStorage.getItem('adb_extractDir') || 'D:\\apk_backup'
)
const [extracting, setExtracting] = useState(false)
const [extractProgress, setExtractProgress] = useState(null)
// { current: 2, total: 5, currentPkg: 'com.xxx', speed: '29.4 MB/s', percent: 40 }
const [packagesLoading, setPackagesLoading] = useState(false)
```

#### 3.2.2 UI 组件结构

```
<应用提取面板> (expandExtract 控制折叠)
├── <工具栏>
│   ├── [刷新应用列表] 按钮
│   ├── [仅第三方 / 全部] 切换
│   └── 搜索过滤框 (按包名过滤)
├── <应用列表> (packages state)
│   ├── 全选 Checkbox + 已选计数
│   └── 每行: Checkbox + 包名 + 大小 (人类可读格式)
├── <提取配置>
│   ├── 本地保存路径输入框 + 打开目录按钮
│   └── [开始提取 (N个, ~大小)] 按钮
└── <进度区域> (extracting 时显示)
    ├── 进度条 + 百分比
    ├── 当前包名 + 速度
    └── [取消提取] 按钮
```

#### 3.2.3 交互细节

| 交互 | 行为 |
|------|------|
| 点击「刷新应用列表」 | 调用 GET `/packages`，loading 动画，完成后填充列表 |
| 切换「仅第三方/全部」 | 重新请求列表，清空已选 |
| 搜索框输入 | 前端过滤（不发请求），实时筛选匹配的包名 |
| 勾选/取消勾选 | 更新 `selectedPkgs` Set，自动计算总大小 |
| 点击「开始提取」 | POST `/extract-apks`，切换到进度视图 |
| 提取中点击「取消」| DELETE 请求 → 后端取消 → 前端显示部分完成结果 |
| 提取完成 | 显示成功/失败数量 + [打开目录] 按钮 |

### 3.3 目录结构变更

```
E:\Such_Proj\Other\EncyHub\
├── tools/adb_master/
│   ├── adb_manager.py     # ⚙️ 修改: 新增 list_packages() / extract_apk()
│   ├── main.py            # ⚙️ 修改: 新增 3 个 API 端点 + 1 个 SSE 端点
│   ├── config_manager.py  # (不修改)
│   ├── path_utils.py      # (不修改)
│   └── scrcpy_web_manager.py  # (不修改)
│
├── frontend/src/pages/
│   └── AdbMaster.jsx      # ⚙️ 修改: 新增「应用提取」面板 (~200行)
```

**不新增文件**，所有变更在现有文件中完成，保持项目结构简洁。

---

## 四、实现步骤

### Step 1: 后端 - 应用列表接口

**文件**: `adb_manager.py`
**变更**: 新增 `list_packages()` 方法

- 执行 `pm list packages [-3]` 获取包名列表
- 批量执行 `pm path <pkg>` 获取 APK 路径
- 批量执行 `stat -c %s <apk_path>` 获取文件大小（单次 shell 会话优化）
- 返回排序后的列表

**文件**: `main.py`
**变更**: 新增 `GET /devices/{hw_id}/packages` 端点

### Step 2: 后端 - APK 提取接口

**文件**: `adb_manager.py`
**变更**: 新增 `extract_apk()` 方法

- 使用 `asyncio.create_subprocess_exec` 调用 `adb exec-out cat <apk_path>`
- 流式读取 stdout 写入本地文件（chunk size: 64KB）
- 记录已传输字节数、计算速度
- 支持取消信号检查

**文件**: `main.py`
**变更**: 新增批量提取端点

- `POST /devices/{hw_id}/extract-apks` —— SSE 流式响应
- `DELETE /devices/{hw_id}/extract-apks` —— 取消正在进行的提取
- 维护 `_extract_cancel_events: Dict[str, asyncio.Event]`

### Step 3: 前端 - 应用提取面板

**文件**: `AdbMaster.jsx`
**变更**: 新增面板 UI

- State 定义 + localStorage 持久化 (extractDir)
- 面板头部: 刷新按钮 + 第三方/全部切换 + 搜索框
- 应用列表: 全选 + 可勾选行 + 大小显示
- 提取配置: 路径输入 + 预估大小 + 开始按钮
- 进度视图: 进度条 + 速度 + 取消按钮 + 完成状态

### Step 4: 联调 & 优化

- 大 APK 测试（2GB+，验证流式传输稳定性）
- 多设备切换时的状态清理
- 离线设备时的错误处理
- 提取过程中设备断连的优雅降级

---

## 五、人类可读大小格式化

复用或新增前端 utility：

```javascript
function formatSize(bytes) {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i]
}
```

---

## 六、风险与应对

| 风险 | 影响 | 应对措施 |
|------|------|----------|
| Split APK (多 APK 应用) | 仅提取 base.apk，安装可能不完整 | 列表中标注「Split」提示用户；后续迭代支持 |
| 系统应用权限受限 | `pm path` 或 `cat` 可能被拒绝 | 捕获错误，跳过并在结果中标记失败原因 |
| 超大 APK（2GB+）传输中断 | 文件不完整 | 传输后校验文件大小与 `stat` 值是否一致 |
| 磁盘空间不足 | 写入失败 | 捕获 IOError，提示用户释放空间 |
| 提取过程中设备断连 | 进程卡住 | ADB 命令设超时，检测 subprocess 退出码 |

---

## 七、预期工作量

| 步骤 | 涉及文件 | 预估新增代码 |
|------|----------|-------------|
| Step 1: 应用列表接口 | adb_manager.py, main.py | ~80 行 |
| Step 2: APK 提取接口 | adb_manager.py, main.py | ~120 行 |
| Step 3: 前端面板 | AdbMaster.jsx | ~200 行 |
| Step 4: 联调优化 | 多文件 | ~30 行 |
| **合计** | **3 个文件** | **~430 行** |
