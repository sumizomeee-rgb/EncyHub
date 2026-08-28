"""
平台重启（restart-hub）回归测试

历史缺陷：/api/hub/restart-hub 会用 Popen 额外启动一个新的 start.bat，
新旧两个启动脚本又都会在对方进程退出后重新拉起，互相杀死对方占用 9524
端口的进程，形成无限重启循环（日志表现为反复出现
"Process exited unexpectedly (code=15), restarting in 3s..."）。

现行约定：重启接口不启动任何新进程，仅以 RESTART_EXIT_CODE 退出，
由唯一的外层启动脚本（start.bat / start.sh，部署机上为 systemd 的
Restart=on-failure）负责重新拉起。
"""
import inspect
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from hub_core.api import router, restart_hub
from hub_core.config import ROOT_DIR, RESTART_EXIT_CODE


def build_app():
    """只挂载 Hub API 路由，避免导入 main.py 触发 lifespan 真实启动工具进程"""
    app = FastAPI()
    app.include_router(router)
    return app


class TestRestartHubEndpoint:
    """重启接口行为测试"""

    def test_restart_spawns_no_process_and_exits_with_restart_code(self, monkeypatch):
        """重启接口不得启动任何子进程（尤其是第二个 start.bat），
        并必须以约定退出码退出，交由外层启动脚本重新拉起"""
        monkeypatch.setenv("ENCYHUB_SUPERVISOR", "pytest")
        monkeypatch.delenv("INVOCATION_ID", raising=False)

        # 任何创建子进程的尝试都视为回归（旧实现会 Popen 一个新的 start.bat）
        spawn_calls = []

        def fake_popen(*args, **kwargs):
            spawn_calls.append((args, kwargs))
            raise AssertionError("restart-hub 不允许启动任何子进程")

        monkeypatch.setattr(subprocess, "Popen", fake_popen)

        exit_codes = []
        monkeypatch.setattr(os, "_exit", lambda code: exit_codes.append(code))

        with TestClient(build_app()) as client:
            resp = client.post("/api/hub/restart-hub")
            assert resp.status_code == 200
            assert resp.json()["success"] is True
            # 接口内部延迟 0.5 秒退出，等待延迟任务执行完
            time.sleep(1.2)

        assert spawn_calls == [], "重启接口启动了子进程，会再次引发双启动脚本循环"
        assert exit_codes == [RESTART_EXIT_CODE]

    def test_restart_refused_without_supervisor(self, monkeypatch):
        """进程未由启动脚本托管时（例如直接 python main.py 调试），
        必须拒绝重启而不是把平台停掉后无人拉起"""
        monkeypatch.delenv("ENCYHUB_SUPERVISOR", raising=False)
        monkeypatch.delenv("INVOCATION_ID", raising=False)

        exit_codes = []
        monkeypatch.setattr(os, "_exit", lambda code: exit_codes.append(code))

        with TestClient(build_app()) as client:
            resp = client.post("/api/hub/restart-hub")
            assert resp.status_code == 400
            time.sleep(0.8)

        assert exit_codes == [], "无托管环境时不允许退出进程"


class TestStartupScriptContract:
    """重启退出码是 Python 与启动脚本之间的跨语言契约，必须保持一致"""

    def test_start_scripts_recognize_restart_exit_code(self):
        """start.bat / start.sh 必须识别同一个重启退出码，否则重启后平台不会被拉起"""
        code = str(RESTART_EXIT_CODE)
        bat = (ROOT_DIR / "start.bat").read_text(encoding="utf-8", errors="ignore")
        sh = (ROOT_DIR / "start.sh").read_text(encoding="utf-8", errors="ignore")
        assert f"if %EXIT_CODE%=={code}" in bat, "start.bat 缺少重启退出码分支"
        assert f"-eq {code}" in sh, "start.sh 缺少重启退出码分支"

    def test_start_scripts_set_supervisor_env(self):
        """启动脚本必须声明托管身份，重启接口据此判断是否允许重启"""
        bat = (ROOT_DIR / "start.bat").read_text(encoding="utf-8", errors="ignore")
        sh = (ROOT_DIR / "start.sh").read_text(encoding="utf-8", errors="ignore")
        assert "ENCYHUB_SUPERVISOR" in bat
        assert "ENCYHUB_SUPERVISOR" in sh

    def test_start_scripts_do_not_restart_on_arbitrary_nonzero(self):
        """任何非零退出都自动重启是双启动脚本互杀循环的燃料，必须移除"""
        bat = (ROOT_DIR / "start.bat").read_text(encoding="utf-8", errors="ignore")
        sh = (ROOT_DIR / "start.sh").read_text(encoding="utf-8", errors="ignore")
        assert "Process exited unexpectedly" not in bat
        assert "Process exited unexpectedly" not in sh

    def test_restart_endpoint_no_longer_spawns_start_script(self):
        """重启接口源码（不含 docstring 说明文字）中不得再出现
        启动第二个进程/脚本的逻辑"""
        import ast
        import textwrap

        src = textwrap.dedent(inspect.getsource(restart_hub))
        func = ast.parse(src).body[0]
        # 跳过 docstring，只检查实际代码；错误提示文案中提到 start.bat 是允许的
        code_src = ast.unparse(ast.Module(body=func.body[1:], type_ignores=[]))
        assert "Popen" not in code_src
        assert "subprocess" not in code_src
        assert "RESTART_EXIT_CODE" in code_src
