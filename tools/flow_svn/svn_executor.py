"""SVN execution engine with error handling"""
import subprocess
from pathlib import Path
from typing import Tuple
from datetime import datetime


class SVNExecutor:
    """Executes SVN operations with robust error handling"""
    
    def execute_update(self, svn_path: str, idle_timeout: int = 300, max_timeout: int = 7200):
        """
        Execute svn update --non-interactive with streaming output and heartbeat monitoring
        
        Args:
            svn_path: Path to SVN working copy
            idle_timeout: Seconds to wait for new output before timing out
            max_timeout: Maximum total execution time in seconds
        
        Yields:
            Log lines as they are produced
        """
        import time
        
        start_time = time.time()
        last_activity_time = start_time
        
        yield f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Starting SVN update (Streaming)"
        yield f"Working directory: {svn_path}"
        yield f"Timeouts: Idle={idle_timeout}s, Max={max_timeout}s"
        
        # Validate path exists
        path_obj = Path(svn_path)
        if not path_obj.exists():
            yield f"ERROR: Path does not exist: {svn_path}"
            return  # End generator
        
        if not path_obj.is_dir():
            yield f"ERROR: Path is not a directory: {svn_path}"
            return
        
        # Check if it's an SVN working copy
        current_path = path_obj.resolve()
        svn_root = None
        while current_path != current_path.parent:
            svn_dir = current_path / ".svn"
            if svn_dir.exists() and svn_dir.is_dir():
                svn_root = current_path
                break
            current_path = current_path.parent
        
        if not svn_root:
            yield f"ERROR: Not an SVN working copy (no .svn directory found): {svn_path}"
            return
            
        yield f"SVN working copy root found: {svn_root}"
        yield "Executing: svn update --non-interactive"
        yield "--- SVN Output Start ---"
        
        try:
            # Use Popen for streaming output
            process = subprocess.Popen(
                ["svn", "update", "--non-interactive"],
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
                    yield f"\nERROR: SVN update exceeded max total time of {max_timeout} seconds"
                    return
                
                # Check idle timeout (heartbeat)
                if current_time - last_activity_time > idle_timeout:
                    process.kill()
                    yield f"\nERROR: SVN update exceeded idle timeout of {idle_timeout} seconds (no output received)"
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
                    yield f"\nERROR: SVN update exceeded max total time of {max_timeout} seconds"
                    return
                
                if current_time - last_activity_time > idle_timeout:
                    process.kill()
                    yield f"\nERROR: SVN update timed out after {idle_timeout} seconds of silence"
                    return
                
                # Check if process died unexpectedly without sending None (rare but possible)
                if not t.is_alive() and output_queue.empty():
                    break
        
        # Process finished
        process.wait()
        yield "--- SVN Output End ---"
        
        if process.returncode == 0:
            yield f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] SVN update completed successfully"
        else:
            yield f"ERROR: SVN update failed with exit code {process.returncode}"

    
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
