# GM Console RuntimeGM 代码复制入口设计方案

## 背景

当前 RuntimeGM 客户端 Lua 代码维护在 `tools/gm_console/README_RuntimeGM_Client.md` 的第一个 `lua` 代码块中，`inject_runtime_gm.py` 通过正则从 Markdown 中提取代码后再替换连接地址。这对单人本机注入可用，但对其他同事通过网页复制代码不友好，也让 README 同时承担“文档”和“源码”两个职责。

这次改造目标是把 RuntimeGM Lua 收敛为唯一权威源，并在 GM Console 页面提供弹窗查看与复制完整代码。

## 目标

1. 新增唯一权威 Lua 源文件：`tools/gm_console/runtime_gm_client.lua`。
2. 注入脚本只读取该 Lua 文件，不再解析 README。
3. 后端提供 RuntimeGM 代码接口，Web 与注入脚本读取同一份源。
4. GM Console 页面在握手端口区域提供入口，弹窗展示完整 Lua 代码并支持一键复制。
5. 弹窗 host 由后端按部署机 `ipconfig`/本机网卡自动探测，端口默认使用后端监听端口。

## 非目标

1. 不改 RuntimeGM Lua 的业务能力，只迁移来源与展示方式。
2. 不重写注入脚本的目标文件配置、SVN revert、追加写入流程。
3. 不把 README 继续作为源码容器；README 可以删除或只保留简短说明，但不再作为权威代码来源。

## 方案

### 1. 权威 Lua 源

从 `README_RuntimeGM_Client.md` 的代码块中抽出完整 Lua，生成：

`tools/gm_console/runtime_gm_client.lua`

该文件成为唯一维护入口。文件内仍保留默认：

- `RuntimeGMClient.Host = "localhost"`
- `RuntimeGMClient.Port = 12581`
- `gmClient.Start("...", 12581)`

这些值由脚本或接口按需 patch。

### 2. 共享生成逻辑

新增轻量 Python 模块：

`tools/gm_console/runtime_gm_code.py`

职责：

- 读取 `runtime_gm_client.lua`
- 自动探测当前部署机 LAN IPv4
- 校验 host 非空、port 为合法整数
- 只替换文件末尾 `gmClient.Start(...)` 的连接参数
- 不替换开头 `RuntimeGMClient.Host` / `RuntimeGMClient.Port` 默认字段，避免连接地址出现在代码开头

`inject_runtime_gm.py` 和 `main.py` 都调用该模块，避免两边复制正则。

### 3. 后端接口

在 `tools/gm_console/main.py` 增加：

`GET /runtime-gm-code?port=<port>`

返回：

```json
{
  "code": "...",
  "host": "10.101.0.8",
  "port": 12581
}
```

如果前端不传 port，后端默认使用 `DEFAULT_TCP_PORT`。host 不由前端传入，由 GM Console 后端自动探测部署机 LAN IPv4。如果源文件缺失或参数非法，接口返回 400/500 级错误信息。

### 4. 前端交互

在 GM Console 左侧“握手端口”卡片增加一个代码入口按钮。点击后打开 `RuntimeGmCodeModal`：

- Host 只读展示后端探测到的部署机 LAN IPv4
- 端口展示当前 `handshakePort`
- 页面空闲时预取 `/api/gm_console/runtime-gm-code`，打开弹窗时复用缓存
- 中间区域展示完整 Lua 代码
- 顶部提供复制按钮，复用 `copyText`
- 加载/失败状态在弹窗内局部展示

该入口面向“同事拿到代码后粘贴到自己的目标 Lua 文件”场景，保持直接、可复制、少解释。

### 5. 验证

后端/脚本：

- 新增测试确认 `inject_runtime_gm.py` 不再引用 README 提取逻辑。
- 新增测试确认 `runtime_gm_code.build_runtime_gm_code()` 能正确替换 host/port。
- 新增测试确认 `main.py` 暴露 `/runtime-gm-code` 接口。

前端：

- 运行 `npm run build` 确认 JSX 编译通过。

已知 `pytest -q` 存在旧失败，这次优先运行新增/相关测试，并在最终说明里标明全量测试状态。

## 实施顺序

1. 新增测试，先观察失败。
2. 抽出 `runtime_gm_client.lua`。
3. 新增 `runtime_gm_code.py`。
4. 改造 `inject_runtime_gm.py` 使用新模块。
5. 在 `main.py` 增加接口。
6. 在 `GmConsole.jsx` 增加弹窗和复制入口。
7. 运行针对性 pytest 与前端构建。
