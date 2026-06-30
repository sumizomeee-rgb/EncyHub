"""SVN execution engine with error handling"""
import subprocess
import sqlite3
from pathlib import Path
from typing import Tuple, Any
from datetime import datetime


class SVNExecutor:
    """Executes SVN operations with robust error handling"""

    def _find_working_copy_root(self, svn_path: str):
        """Find the SVN working copy root for a path inside a working copy."""
        path_obj = Path(svn_path)
        if not path_obj.exists():
            return None, f"ERROR: Path does not exist: {svn_path}"

        if not path_obj.is_dir():
            return None, f"ERROR: Path is not a directory: {svn_path}"

        current_path = path_obj.resolve()
        while current_path != current_path.parent:
            svn_dir = current_path / ".svn"
            if svn_dir.exists() and svn_dir.is_dir():
                return current_path, None
            current_path = current_path.parent

        return None, f"ERROR: Not an SVN working copy (no .svn directory found): {svn_path}"

    def _inspect_working_copy_state(self, svn_root: Path) -> dict[str, Any]:
        """Read lightweight SVN working copy state from wc.db."""
        state = {
            "wc_locks": 0,
            "work_queue": 0,
            "conflicts": [],
            "error": None,
        }
        wc_db = svn_root / ".svn" / "wc.db"
        if not wc_db.exists():
            state["error"] = f"wc.db not found: {wc_db}"
            return state

        try:
            uri = "file:" + wc_db.as_posix().replace("#", "%23").replace("?", "%3f") + "?mode=ro"
            con = sqlite3.connect(uri, uri=True, timeout=3)
            cur = con.cursor()
            state["wc_locks"] = cur.execute("SELECT COUNT(*) FROM WC_LOCK").fetchone()[0]
            state["work_queue"] = cur.execute("SELECT COUNT(*) FROM WORK_QUEUE").fetchone()[0]
            conflict_rows = cur.execute(
                "SELECT local_relpath FROM ACTUAL_NODE "
                "WHERE conflict_data IS NOT NULL OR tree_conflict_data IS NOT NULL "
                "ORDER BY local_relpath"
            ).fetchall()
            state["conflicts"] = [row[0] for row in conflict_rows]
            con.close()
        except Exception as e:
            state["error"] = str(e)

        return state

    def _build_preflight_diagnostics(self, svn_root: Path, operation_label: str) -> tuple[list[str], bool]:
        """Build diagnostics and decide whether an update can proceed."""
        lines = []
        state = self._inspect_working_copy_state(svn_root)
        if state["error"]:
            lines.append(f"WARNING: Failed to inspect SVN working copy state: {state['error']}")
            return lines, True

        conflicts = state["conflicts"]
        lines.append(
            "SVN working copy state: "
            f"locks={state['wc_locks']}, work_queue={state['work_queue']}, conflicts={len(conflicts)}"
        )

        if operation_label == "update":
            if state["wc_locks"] or state["work_queue"]:
                lines.append(
                    "ERROR: SVN working copy has pending locks or work queue items. "
                    "Run svn cleanup before update."
                )
                return lines, False

            if conflicts:
                lines.append(
                    "WARNING: SVN working copy has unresolved conflicts. "
                    "Continuing update because existing conflicts do not necessarily block unrelated paths."
                )
                lines.append("Conflict paths:")
                for relpath in conflicts[:30]:
                    lines.append(f"  {relpath}")
                if len(conflicts) > 30:
                    lines.append(f"  ... and {len(conflicts) - 30} more")
                lines.append("NOTE: svn cleanup cannot resolve text/tree conflicts.")

        return lines, True

    def _execute_svn_operation(
        self,
        svn_path: str,
        command_args: list[str],
        operation_label: str,
        idle_timeout: int = 300,
        max_timeout: int = 7200,
    ):
        """
        Execute an SVN command with streaming output and heartbeat monitoring.
        
        Args:
            svn_path: Path to SVN working copy
            command_args: SVN command arguments after "svn"
            operation_label: Human-readable operation label for logs
            idle_timeout: Seconds to wait for new output before timing out
            max_timeout: Maximum total execution time in seconds
        
        Yields:
            Log lines as they are produced
        """
        import time
        
        start_time = time.time()
        last_activity_time = start_time
        command = ["svn", *command_args, "--non-interactive"]
        command_text = " ".join(command)
        
        yield f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Starting SVN {operation_label} (Streaming)"
        yield f"Working directory: {svn_path}"
        yield f"Timeouts: Idle={idle_timeout}s, Max={max_timeout}s"
        
        svn_root, error = self._find_working_copy_root(svn_path)
        if error:
            yield error
            return
            
        yield f"SVN working copy root found: {svn_root}"
        diagnostics, can_continue = self._build_preflight_diagnostics(svn_root, operation_label)
        for line in diagnostics:
            yield line
        if not can_continue:
            return

        yield f"Executing: {command_text}"
        yield "--- SVN Output Start ---"
        
        try:
            # Use Popen for streaming output
            process = subprocess.Popen(
                command,
                cwd=svn_path,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,  # Merge stderr into stdout
                text=True,
                encoding='utf-8',
                errors='replace',
                bufsize=1,  # Line buffered
                universal_newlines=True
            )
            
            # Read output with timeout monitoring
            while True:
                # Check for timeouts
                current_time = time.time()
                
                # Check max timeout
                if current_time - start_time > max_timeout:
                    process.kill()
                    yield f"\nERROR: SVN {operation_label} exceeded max total time of {max_timeout} seconds"
                    return
                
                # Check idle timeout (heartbeat)
                if current_time - last_activity_time > idle_timeout:
                    process.kill()
                    yield f"\nERROR: SVN {operation_label} exceeded idle timeout of {idle_timeout} seconds (no output received)"
                    return
                
                # Non-blocking read attempt logic isn't trivial with standard pipes in a cross-platform way without threads?
                # Actually, standard readline() blocks. To support idle timeout while reading, 
                # we technically need a thread or select (linux only).
                # 
                # Windows Popen doesn't support select on pipes easily.
                # However, for this specific request "Wait as long as there is output", 
                # blocking on readline IS okay IF svn is stuck?
                # No, if SVN hangs without output, readline blocks forever and we can't enforce idle timeout.
                #
                # Simpler approach compatible with Windows:
                # Use a reader thread that puts lines into a Queue.
                # The main thread polls the Queue with a get(timeout=1).
                
                # Let's switch to the queued reader pattern inside this generator
                break
                
        except FileNotFoundError:
            yield "ERROR: SVN command not found. Ensure SVN is installed and in PATH."
            return
        except Exception as e:
            yield f"ERROR: Unexpected error: {str(e)}"
            return

        # Implementation of Queued Reader for Windows compatibility
        import threading
        import queue
        
        output_queue = queue.Queue()
        
        def reader_thread(proc, q):
            for line in proc.stdout:
                q.put(line)
            q.put(None)  # Sentinel
        
        t = threading.Thread(target=reader_thread, args=(process, output_queue))
        t.daemon = True
        t.start()
        
        last_activity_time = time.time()
        
        while True:
            try:
                # Wait for line with a small timeout to allow checking overall timeouts
                line = output_queue.get(timeout=1.0)
                
                if line is None:  # Process finished
                    break
                    
                # We got a line, reset idle timer
                last_activity_time = time.time()
                yield line.strip()
                
            except queue.Empty:
                # No output for 1 second, check timeouts
                current_time = time.time()
                
                if current_time - start_time > max_timeout:
                    process.kill()
                    yield f"\nERROR: SVN {operation_label} exceeded max total time of {max_timeout} seconds"
                    return
                
                if current_time - last_activity_time > idle_timeout:
                    process.kill()
                    yield f"\nERROR: SVN {operation_label} timed out after {idle_timeout} seconds of silence"
                    return
                
                # Check if process died unexpectedly without sending None (rare but possible)
                if not t.is_alive() and output_queue.empty():
                    break
        
        # Process finished
        process.wait()
        yield "--- SVN Output End ---"
        
        if process.returncode == 0:
            yield f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] SVN {operation_label} completed successfully"
        else:
            yield f"ERROR: SVN {operation_label} failed with exit code {process.returncode}"

    def execute_update(self, svn_path: str, idle_timeout: int = 300, max_timeout: int = 7200):
        """
        Execute svn update --non-interactive with streaming output and heartbeat monitoring.
        """
        yield from self._execute_svn_operation(
            svn_path=svn_path,
            command_args=["update"],
            operation_label="update",
            idle_timeout=idle_timeout,
            max_timeout=max_timeout,
        )

    def execute_cleanup(self, svn_path: str, idle_timeout: int = 300, max_timeout: int = 7200):
        """
        Execute svn cleanup --non-interactive with streaming output and heartbeat monitoring.
        """
        yield from self._execute_svn_operation(
            svn_path=svn_path,
            command_args=["cleanup"],
            operation_label="cleanup",
            idle_timeout=idle_timeout,
            max_timeout=max_timeout,
        )

    
    def get_svn_info(self, svn_path: str) -> Tuple[bool, dict]:
        """
        Get SVN info for a working copy
        
        Args:
            svn_path: Path to SVN working copy
        
        Returns:
            (success: bool, info: dict with url, revision, etc)
        """
        try:
            result = subprocess.run(
                ["svn", "info", "--non-interactive"],
                cwd=svn_path,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
                encoding='utf-8',
                errors='replace'
            )
            
            if result.returncode != 0:
                return False, {}
            
            # Parse svn info output
            info = {}
            for line in result.stdout.split('\n'):
                if ':' in line:
                    key, value = line.split(':', 1)
                    info[key.strip()] = value.strip()
            
            return True, info
            
        except Exception as e:
            return False, {}
