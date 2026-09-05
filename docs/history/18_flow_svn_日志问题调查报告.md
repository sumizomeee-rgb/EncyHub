# FlowSVN 任务计划问题调查与解决方案报告

**调查日期**: 2026-03-06
**调查人**: Claude Code
**问题**: FlowSVN 任务计划未正常执行，历史日志停在 2026-02-28

---

## 一、问题确认

### 1.1 用户描述
- FlowSVN 能正常打开，可以添加任务
- 历史日志和执行日志最后一次记录是 2026-02-28
- SVN 仓库每天都在更新（用户声称）

### 1.2 调查结论

**存在两个独立的问题：**

| 问题 | 描述 |
|------|------|
| **问题 A** | 系统中存在两个 FlowSVN 部署实例，用户查看的是错误的项目 |
| **问题 B** | EncyHub 的任务计划路径代码存在 Bug，导致任务无法执行 |

---

## 二、问题 A：多实例混淆

### 2.1 发现的两个实例

| 实例 | 路径 | 任务计划名称 | 创建时间 | 最后执行 | 执行次数 |
|------|------|--------------|----------|----------|----------|
| AutoSvn | `E:\Such_Proj\Python\AutoSvn` | `FlowSVN_HaruTruk_1589731f` | 2026-01-17 | 2026-03-06 09:00 | 58次 |
| EncyHub | `E:\Such_Proj\Other\EncyHub` | `FlowSVN_Haru主干_7f3c9892` | 2026-03-06 | 2026-02-28 | 1次 |

### 2.2 真相

- **AutoSvn 项目**的 FlowSVN (EXE 版本) 从 2026-01-17 开始就在正常工作
- **EncyHub 项目**的 FlowSVN 是迁移/开发中的版本
- 用户在查看 EncyHub 的 Web 界面，但实际执行的是 AutoSvn 版本

---

## 三、问题 B：任务计划路径 Bug

### 3.1 Bug 位置

**文件**: `tools/flow_svn/task_scheduler.py`

**修复前 (2026-02-28 及之前)**:
```python
# 第 25-26 行
# Running from source
self.python_exe = sys.executable
self.script_path = Path(__file__).parent.parent / "flowsvn.py"  # ← 错误路径
self.is_frozen = False
```

**修复后 (2026-03-06)**:
```python
# Running from source
self.python_exe = sys.executable
self.script_path = Path(__file__).parent / "cli.py"  # ← 正确路径
self.is_frozen = False
```

### 3.2 Bug 分析

```
task_scheduler.py 实际位置: E:\Such_Proj\Other\EncyHub\tools\flow_svn\task_scheduler.py

修复前计算结果:
  Path(__file__).parent.parent / "flowsvn.py"
  = tools\flow_svn\..\flowsvn.py
  = tools\flowsvn.py  ← 文件不存在！

修复后计算结果:
  Path(__file__).parent / "cli.py"
  = tools\flow_svn\cli.py  ← 文件存在！
```

### 3.3 影响时间线

```
2026-02-14
    │
    │  Initial commit
    │  task_scheduler.py 路径计算错误
    │
    ▼
2026-02-26 ~ 2026-02-28
    │
    │  服务启动，打印 "Scheduled task: Haru主干 at 09:00"
    │  任务计划创建成功，但指向不存在的脚本
    │  任务计划执行时静默失败
    │
    ▼
2026-03-06 03:36
    │
    │  提交 603a57f 修复路径问题
    │  服务重启，任务计划重新创建
    │  路径现在正确指向 tools/flow_svn/cli.py
    │
    ▼
现在
    │
    │  任务计划应该可以正常执行
    │
    ▼
```

### 3.4 为什么日志显示 "Scheduled task" 但实际失败？

代码逻辑分析 (`main.py` 第 42-50 行):

```python
for task in tasks:
    if task.enabled:
        success, msg = task_scheduler.create_task(task.id, task.name, task.schedule_time)
        if success:
            print(f"[FlowSVN] Scheduled task: {task.name} at {task.schedule_time}")
        else:
            print(f"[FlowSVN] Failed to schedule task {task.name}: {msg}")
```

- `schtasks /Create` 命令成功返回 0，任务计划被创建
- 但任务计划指向的脚本路径不存在
- Windows 任务计划在执行时才失败（找不到脚本）
- 失败是静默的，没有反馈到 FlowSVN 日志

---

## 四、解决方案

### 4.1 清理旧任务计划

需要删除 AutoSvn 的任务计划，避免重复执行：

```powershell
# 以管理员身份运行
schtasks /Delete /TN "FlowSVN_HaruTruk_1589731f" /F
```

### 4.2 验证 EncyHub 任务计划

检查任务计划配置是否正确：

```powershell
schtasks /Query /TN "\FlowSVN_Haru主干_7f3c9892" /V /FO LIST
```

确认以下字段：
- **Task To Run**: `E:\Such_Proj\Other\EncyHub\.venv\Scripts\python.exe "E:\Such_Proj\Other\EncyHub\tools\flow_svn\cli.py" run-id 7f3c9892`
- **Next Run Time**: 明天 09:00

### 4.3 手动测试 CLI 执行

```bash
cd E:\Such_Proj\Other\EncyHub
.venv\Scripts\python.exe tools\flow_svn\cli.py run-id 7f3c9892
```

预期结果：
- SVN 更新执行
- `data/flow_svn/config.json` 中的 `last_run` 和 `execution_history` 更新

### 4.4 迁移配置数据（可选）

如果需要保留 AutoSvn 的历史数据：

```powershell
# 查看源配置
type E:\Such_Proj\Python\AutoSvn\data\config.json

# 手动复制 templates 等配置到 EncyHub
# 目标: E:\Such_Proj\Other\EncyHub\data\flow_svn\config.json
```

---

## 五、执行步骤

### 步骤 1: 删除旧任务计划

```powershell
schtasks /Delete /TN "FlowSVN_HaruTruk_1589731f" /F
```

### 步骤 2: 验证当前任务计划

```powershell
schtasks /Query /TN "\FlowSVN_Haru主干_7f3c9892" /V
```

### 步骤 3: 手动测试执行

```bash
cd E:\Such_Proj\Other\EncyHub
python tools\flow_svn\cli.py run-id 7f3c9892
```

### 步骤 4: 检查配置更新

```bash
type data\flow_svn\config.json | findstr last_run
```

确认 `last_run` 已更新为当前时间。

### 步骤 5: 等待自动执行验证

明天 09:00 检查：
1. SVN 仓库是否更新
2. `config.json` 中的 `last_run` 是否更新
3. `execution_history` 是否有新记录

---

## 六、后续改进建议

### 6.1 添加 CLI 执行日志

在 `cli.py` 中添加文件日志记录，方便排查问题：

```python
import logging
from datetime import datetime

def setup_logging():
    log_dir = PROJECT_ROOT / "logs" / "flow_svn"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"cli_{datetime.now().strftime('%Y%m%d')}.log"

    logging.basicConfig(
        filename=str(log_file),
        level=logging.INFO,
        format='[%(asctime)s] %(levelname)s: %(message)s'
    )
    return logging.getLogger(__name__)
```

### 6.2 任务计划健康检查

在服务启动时验证任务计划的可执行性：

```python
def validate_task_scheduler(task_id: str):
    """验证任务计划的脚本路径是否存在"""
    script_path = Path(__file__).parent / "cli.py"
    if not script_path.exists():
        print(f"[FlowSVN] WARNING: CLI script not found: {script_path}")
        return False
    return True
```

### 6.3 添加实例标识

在 Web 界面显示当前实例路径，避免混淆：

```python
@app.get("/")
async def index():
    return {
        "name": "FlowSVN",
        "instance_path": str(PROJECT_ROOT),
        "status": "running",
        # ...
    }
```

---

## 七、附录

### 7.1 相关文件

| 文件 | 路径 | 说明 |
|------|------|------|
| CLI 脚本 | `tools/flow_svn/cli.py` | 任务计划执行的入口脚本 |
| 任务调度器 | `tools/flow_svn/task_scheduler.py` | Windows 任务计划集成 |
| 配置文件 | `data/flow_svn/config.json` | 任务配置存储 |
| 服务日志 | `logs/flow_svn/*.log` | 服务启动日志 |

### 7.2 Git 提交记录

| 提交 | 日期 | 说明 |
|------|------|------|
| `60ec05f` | 2026-02-14 | Initial commit |
| `26ff9597` | 2026-02-28 | 添加 flowsvn.py，但路径计算错误 |
| `95a2b694` | 2026-02-28 | 修复 ConfigManager Bug |
| `603a57f` | 2026-03-06 | **修复任务计划路径问题** |

### 7.3 调试命令

```bash
# 查看所有 FlowSVN 任务计划
ls C:\Windows\System32\Tasks\FlowSVN*

# 手动执行任务
python tools\flow_svn\cli.py run-id 7f3c9892

# 检查 SVN 状态
cd F:\HaruTrunk && svn info && svn log -l 5

# 查看配置
type data\flow_svn\config.json
```

---

**报告结束**

**核心结论**：
1. 之前的 FlowSVN 任务计划指向不存在的脚本路径，导致静默失败
2. 2026-03-06 的提交已修复此问题
3. 需要删除 AutoSvn 的旧任务计划，使用 EncyHub 版本
4. 建议添加 CLI 执行日志以便未来排查问题