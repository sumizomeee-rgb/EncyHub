"""Trigger execution engine with safety mechanisms"""
import subprocess
import os
import psutil
import time
import tkinter as tk
from tkinter import messagebox
from pathlib import Path
from typing import List, Optional, Tuple
from datetime import datetime
from .models import Template, TriggerAction


class TriggerExecutor:
    """Executes post-SVN trigger actions"""
    
    def __init__(self):
        """Initialize trigger executor"""
        pass
    
    def execute_template(self, template: Template, svn_path: str) -> Tuple[bool, str]:
        """
        Execute all actions in a template sequentially
        
        Args:
            template: Template containing actions to execute
            svn_path: SVN working copy path (for context)
        
        Returns:
            (success: bool, log: str)
        """
        log_lines = []
        log_lines.append(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Executing template: {template.name}")
        log_lines.append(f"Template ID: {template.id}")
        log_lines.append(f"Total actions: {len(template.actions)}")
        
        for i, action in enumerate(template.actions, 1):
            log_lines.append(f"\n--- Action {i}/{len(template.actions)}: {action.type} ---")
            
            success, msg = self._execute_action(action, svn_path)
            log_lines.append(msg)
            
            if not success:
                log_lines.append(f"ERROR: Action {i} failed. Stopping execution.")
                return False, '\n'.join(log_lines)
        
        log_lines.append(f"\n[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] All triggers executed successfully")
        return True, '\n'.join(log_lines)
    
    def _execute_action(self, action: TriggerAction, svn_path: str) -> Tuple[bool, str]:
        """Execute a single trigger action"""
        
        if action.type == "noop":
            return True, "No operation (placeholder)"
        
        elif action.type == "kill_process":
            return self._kill_process(action.target)
        
        elif action.type == "start_exe":
            return self._start_executable(action.path, action.args)
        
        elif action.type == "unity_project":
            return self._start_unity_project(action.path)
        
        elif action.type == "open_directory":
            return self._open_directory(action.path)
        
        elif action.type == "shutdown":
            return self._shutdown_with_countdown()
        
        
        elif action.type == "focus_window":
            # args stores 'title' or 'process' mode
            mode = action.args if action.args else 'title'
            return self._focus_window(action.target, mode)

        elif action.type == "restart":
            return self._restart_with_countdown()
        
        elif action.type == "touch_file":
            return self._touch_file(action.path, svn_path)
        
        else:
            return False, f"Unknown action type: {action.type}"
    
    def _kill_process(self, process_name: str) -> Tuple[bool, str]:
        """Kill all instances of a process by name"""
        killed_count = 0
        
        try:
            for proc in psutil.process_iter(['name']):
                try:
                    if proc.info['name'].lower() == process_name.lower():
                        proc.kill()
                        killed_count += 1
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            
            if killed_count > 0:
                return True, f"Killed {killed_count} instance(s) of {process_name}"
            else:
                return True, f"No running instances of {process_name} found"
                
        except Exception as e:
            return False, f"Error killing process: {str(e)}"
    
    def _start_executable(self, exe_path: str, args: str = None) -> Tuple[bool, str]:
        """Start an executable with optional arguments"""
        try:
            path_obj = Path(exe_path)
            if not path_obj.exists():
                return False, f"Executable not found: {exe_path}"
            
            cmd = [str(exe_path)]
            if args:
                cmd.extend(args.split())
            
            # Start process detached (won't block)
            subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
            )
            
            return True, f"Started: {exe_path} {args if args else ''}"
            
        except Exception as e:
            return False, f"Error starting executable: {str(e)}"
    
    def _start_unity_project(self, project_path: str) -> Tuple[bool, str]:
        """Start a Unity project using Unity Editor directly"""
        try:
            path_obj = Path(project_path)
            if not path_obj.exists():
                return False, f"Unity project not found: {project_path}"
            
            # Unity Editor path (user's installation)
            unity_editor = r"D:\Program Files\Unity\2022.3.52f1\Editor\Unity.exe"
            
            if not Path(unity_editor).exists():
                return False, f"Unity Editor not found at: {unity_editor}"
            
            # Launch Unity Editor directly with project path
            cmd = [unity_editor, "-projectPath", str(project_path)]
            
            subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
            )
            
            return True, f"Started Unity Editor for project: {project_path}"
            
        except Exception as e:
            return False, f"Error starting Unity project: {str(e)}"
    
    def _focus_window(self, target: str, mode: str = 'title') -> Tuple[bool, str]:
        """
        Focus window(s) matching the target
        
        Args:
            target: Window title substring or process name
            mode: 'title' (default) or 'process'
        """
        try:
            import win32gui
            import win32process
            import win32con
            import win32api
            
            matches = []  # List of (hwnd, title)
            
            def window_enum_handler(hwnd, ctx):
                if win32gui.IsWindowVisible(hwnd):
                    title = win32gui.GetWindowText(hwnd)
                    if not title:
                        return
                    
                    is_match = False
                    if mode == 'title':
                        if target.lower() in title.lower():
                            is_match = True
                    elif mode == 'process':
                        try:
                            _, pid = win32process.GetWindowThreadProcessId(hwnd)
                            proc = psutil.Process(pid)
                            if proc.name().lower() == target.lower():
                                is_match = True
                        except:
                            pass
                    
                    if is_match:
                        matches.append((hwnd, title))
            
            win32gui.EnumWindows(window_enum_handler, None)
            
            if matches:
                # Cycle logic: Win32 EnumWindows returns windows in Z-order (top to bottom).
                # The last match in the list is the one furthest back in the Z-order.
                hwnd_to_focus, title_to_focus = matches[-1]
                
                try:
                    import ctypes
                    
                    # Method 1: SwitchToThisWindow (Undocumented but powerful)
                    # This often bypasses foreground locks where SetForegroundWindow fails
                    try:
                        ctypes.windll.user32.SwitchToThisWindow(hwnd_to_focus, True)
                    except Exception:
                        pass

                    # Check if it worked
                    if win32gui.GetForegroundWindow() == hwnd_to_focus:
                        return True, f"Focused (SwitchToThisWindow): {title_to_focus}"

                    # Logic to bypass SetForegroundWindow restrictions if Method 1 failed
                    current_thread = win32api.GetCurrentThreadId()
                    foreground_hwnd = win32gui.GetForegroundWindow()
                    foreground_thread, _ = win32process.GetWindowThreadProcessId(foreground_hwnd)
                    
                    attached = False
                    if current_thread != foreground_thread:
                        try:
                            # Attach input to the foreground window's thread
                            win32process.AttachThreadInput(current_thread, foreground_thread, True)
                            attached = True
                        except Exception:
                            pass

                    try:
                        # 2. Restore if minimized
                        if win32gui.IsIconic(hwnd_to_focus):
                            win32gui.ShowWindow(hwnd_to_focus, win32con.SW_RESTORE)
                        else:
                            win32gui.ShowWindow(hwnd_to_focus, win32con.SW_SHOW)
                            
                        # 3. Try simple SetForegroundWindow
                        win32gui.SetForegroundWindow(hwnd_to_focus)
                        
                    except Exception as e:
                        # 4. Fallback: Alt Key Trick (Simulates user interaction to allow focus steal)
                        try:
                            # Press Alt (VK_MENU = 0x12)
                            ctypes.windll.user32.keybd_event(0x12, 0, 0, 0)
                            win32gui.SetForegroundWindow(hwnd_to_focus)
                        except Exception as e2:
                            # 5. Last Resort: Minimize -> Restore (Force attention)
                            win32gui.ShowWindow(hwnd_to_focus, win32con.SW_MINIMIZE)
                            win32gui.ShowWindow(hwnd_to_focus, win32con.SW_RESTORE)
                            try:
                                win32gui.SetForegroundWindow(hwnd_to_focus)
                            except:
                                pass
                        finally:
                            # Release Alt
                            ctypes.windll.user32.keybd_event(0x12, 0, 2, 0)
                    
                    finally:
                        if attached:
                            win32process.AttachThreadInput(current_thread, foreground_thread, False)

                    # Ensure it's really the foreground window now (verification)
                    new_foreground = win32gui.GetForegroundWindow()
                    is_focused = (new_foreground == hwnd_to_focus)
                    
                    match_info = f"Matched {len(matches)} window(s). " if len(matches) > 1 else ""
                    success_msg = f"{match_info}Focused: {title_to_focus}"
                    
                    if not is_focused:
                        success_msg += " (Warning: OS prevented focus steal, check taskbar)"
                        
                    return True, success_msg
                    
                except Exception as e:
                    return True, f"WARNING: Failed to focus window '{title_to_focus}': {str(e)}"
            else:
                # Debug Info: List some visible windows to help user identify correct target
                all_visible = []
                def list_all_handler(hwnd, ctx):
                    if win32gui.IsWindowVisible(hwnd):
                        t = win32gui.GetWindowText(hwnd)
                        if t: all_visible.append(t)
                win32gui.EnumWindows(list_all_handler, None)
                
                debug_info = f"\n[DEBUG] Visible Windows: {', '.join(all_visible[:10])}..."
                return True, f"No matching windows found for {mode}: {target}. {debug_info}"
                
        except Exception as e:
            return True, f"WARNING: Error focusing window: {str(e)}"

    def _open_directory(self, dir_path: str) -> Tuple[bool, str]:
        """Open directory in Windows Explorer"""
        try:
            path_obj = Path(dir_path)
            if not path_obj.exists():
                return False, f"Directory not found: {dir_path}"
            
            os.startfile(str(path_obj))
            return True, f"Opened directory: {dir_path}"
            
        except Exception as e:
            return False, f"Error opening directory: {str(e)}"
    
    def _shutdown_with_countdown(self) -> Tuple[bool, str]:
        """Shutdown computer with 60-second countdown and cancel option"""
        return self._system_action_with_countdown("shutdown", "/s")
    
    def _restart_with_countdown(self) -> Tuple[bool, str]:
        """Restart computer with 60-second countdown and cancel option"""
        return self._system_action_with_countdown("restart", "/r")
    
    def _system_action_with_countdown(self, action_name: str, shutdown_flag: str) -> Tuple[bool, str]:
        """
        Execute system action (shutdown/restart) with countdown window
        
        Args:
            action_name: "shutdown" or "restart"
            shutdown_flag: "/s" for shutdown, "/r" for restart
        
        Returns:
            (success: bool, log: str)
        """
        cancelled = [False]  # Use list to allow modification in nested function
        
        def countdown_window():
            """Display countdown window with cancel button"""
            root = tk.Tk()
            root.title(f"FlowSVN - {action_name.capitalize()} Countdown")
            root.geometry("400x200")
            root.configure(bg='#212121')
            
            # Center window
            root.update_idletasks()
            x = (root.winfo_screenwidth() // 2) - (400 // 2)
            y = (root.winfo_screenheight() // 2) - (200 // 2)
            root.geometry(f"400x200+{x}+{y}")
            
            # Make window topmost
            root.attributes('-topmost', True)
            
            # Countdown label
            label = tk.Label(
                root,
                text=f"System will {action_name} in 60 seconds...",
                font=("Arial", 14, "bold"),
                fg="#39C5BB",
                bg="#212121"
            )
            label.pack(pady=30)
            
            time_label = tk.Label(
                root,
                text="60",
                font=("Arial", 32, "bold"),
                fg="#FF4081",
                bg="#212121"
            )
            time_label.pack(pady=10)
            
            def cancel():
                cancelled[0] = True
                root.destroy()
            
            cancel_btn = tk.Button(
                root,
                text="CANCEL",
                command=cancel,
                font=("Arial", 12, "bold"),
                bg="#FF4081",
                fg="white",
                relief="flat",
                padx=30,
                pady=10
            )
            cancel_btn.pack(pady=20)
            
            start_time = time.time()
            
            def update_countdown():
                elapsed = int(time.time() - start_time)
                remaining = 60 - elapsed
                
                if remaining <= 0 or cancelled[0]:
                    root.destroy()
                    return
                
                time_label.config(text=str(remaining))
                root.after(100, update_countdown)
            
            update_countdown()
            root.mainloop()
        
        # Show countdown window
        countdown_window()
        
        if cancelled[0]:
            return False, f"{action_name.capitalize()} cancelled by user"
        
        # Execute shutdown/restart
        try:
            subprocess.run(
                ["shutdown", shutdown_flag, "/t", "0"],
                check=True
            )
            return True, f"{action_name.capitalize()} initiated"
        except Exception as e:
            return False, f"Error initiating {action_name}: {str(e)}"

    def _touch_file(self, file_path: str, svn_path: str) -> Tuple[bool, str]:
        """
        Touch a file to update its timestamp (triggers Unity compilation if in Assets).
        
        Args:
            file_path: Path to the file to touch. Can be absolute or relative to SVN root.
            svn_path: Root path of the SVN working copy.
            
        Returns:
            (success: bool, log: str)
        """
        try:
            path_obj = Path(file_path)
            
            # If path is relative, make it absolute relative to SVN root
            if not path_obj.is_absolute():
                path_obj = Path(svn_path) / file_path
            
            # Create parent directories if they don't exist
            if not path_obj.parent.exists():
                return False, f"Parent directory does not exist: {path_obj.parent}"
            
            # Touch the file (update timestamp or create if missing)
            path_obj.touch()
            return True, f"Touched file: {path_obj}"
            
        except Exception as e:
            return False, f"Error touching file: {str(e)}"
