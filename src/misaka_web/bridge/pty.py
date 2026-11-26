"""A real terminal for the browser: a PTY where the OS has one, pipes where it does not.

A slash command like /research is parsed by the interactive TUI, never by the session control
socket (window.py:319 hands any text to the agent as a prompt), so the only honest way to run
the terminal commands from a phone is to own a terminal.

POSIX: os.openpty + setsid, so TUI rendering, keys and window size all behave as on a desk.
Windows: no POSIX PTY — a pipe pair runs non-interactive commands, and the TUI profiles are
refused at ticket time instead of failing mysteriously afterwards.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import shutil
import subprocess
import sys
from typing import Any, Callable

PROFILES = ("shell", "misaka", "panel", "attach")

# Profiles that need a real terminal (full-screen UI, raw keys).
TUI_PROFILES = frozenset({"misaka", "panel", "attach"})


class TerminalError(RuntimeError):
    def __init__(self, message: str, code: str = "terminal_error") -> None:
        super().__init__(message)
        self.code = code


def pty_available() -> bool:
    return hasattr(os, "openpty")


def mode() -> str:
    return "pty" if pty_available() else "pipe"


def _login_shell() -> list[str]:
    override = os.environ.get("MISAKA_WEB_TERMINAL_CMD")
    if override:
        # a JSON array is exact (tests, and paths with spaces); otherwise a shell-ish split
        text = override.strip()
        if text.startswith("["):
            import json

            return [str(item) for item in json.loads(text)]
        import shlex

        return shlex.split(text)
    if not pty_available():
        comspec = os.environ.get("COMSPEC") or "cmd.exe"
        return [comspec]
    shell = os.environ.get("SHELL") or shutil.which("bash") or "/bin/sh"
    return [shell, "-l"] if shell.endswith("bash") else [shell]


def command_for(profile: str, arg: str | None) -> list[str]:
    """What to start for a profile. Filesystem checks stay with the caller."""
    if profile not in PROFILES:
        raise TerminalError(f"Unknown terminal profile: {profile}", code="bad_profile")
    if profile in TUI_PROFILES and not pty_available():
        raise TerminalError(
            "This host has no POSIX PTY, so the full-screen profiles (misaka / panel / attach) "
            "cannot run here. Use the shell profile, or run the web UI on Linux or macOS.",
            code="pty_unavailable",
        )
    if profile == "shell":
        return _login_shell()
    misaka = os.environ.get("MISAKA_WEB_MISAKA_BIN") or _misaka_bin()
    if profile == "misaka":
        return [misaka, "chat"]
    if profile == "panel":
        return [misaka, "panel"]
    if not arg:
        raise TerminalError("The attach profile needs a session path.", code="bad_request")
    return [misaka, "chat", "--attach", "--session", arg]


def _misaka_bin() -> str:
    found = shutil.which("misaka")
    if found:
        return found
    return sys.executable.replace("python.exe", "misaka.exe").replace("python", "misaka")


class Terminal:
    """One child process and its byte stream; the caller decides where the bytes go."""

    def __init__(self, argv: list[str], cwd: str, *, cols: int = 100, rows: int = 30,
                 on_output: Callable[[bytes], None] | None = None) -> None:
        self.argv = argv
        self.cwd = cwd
        self.cols = max(20, int(cols))
        self.rows = max(5, int(rows))
        self.on_output = on_output
        self.pid: int | None = None
        self.exit_code: int | None = None
        self.mode = mode()
        self._master: int | None = None
        self._proc: subprocess.Popen[bytes] | None = None
        self._aproc: Any | None = None
        self._reader: asyncio.Task[None] | None = None
        self._closed = False
        self._waiters: list[asyncio.Future[int | None]] = []

    async def start(self) -> None:
        env = dict(os.environ)
        env.setdefault("TERM", "xterm-256color")
        env.pop("MISAKA_WEB_IN_TERMINAL", None)
        env["MISAKA_WEB_IN_TERMINAL"] = "1"
        if pty_available():
            self._start_pty(env)
        else:
            await self._start_pipe(env)

    def _start_pty(self, env: dict[str, str]) -> None:
        import fcntl
        import struct
        import termios

        master, slave = os.openpty()
        try:
            self._proc = subprocess.Popen(
                self.argv, cwd=self.cwd, env=env,
                stdin=slave, stdout=slave, stderr=slave,
                preexec_fn=os.setsid, close_fds=True,
            )
        finally:
            os.close(slave)
        self.pid = self._proc.pid
        self._master = master
        try:
            winsize = struct.pack("HHHH", self.rows, self.cols, 0, 0)
            fcntl.ioctl(master, termios.TIOCSWINSZ, winsize)
        except OSError:
            pass
        loop = asyncio.get_running_loop()
        loop.add_reader(master, self._drain_pty)

    def _drain_pty(self) -> None:
        assert self._master is not None
        try:
            chunk = os.read(self._master, 65536)
        except OSError:
            chunk = b""
        if not chunk:
            loop = asyncio.get_event_loop()
            try:
                loop.remove_reader(self._master)
            except (OSError, ValueError):
                pass
            self._finish()
            return
        if self.on_output:
            self.on_output(chunk)

    async def _start_pipe(self, env: dict[str, str]) -> None:
        if os.name == "nt":
            # Windows: the proactor loop cannot add_reader() a pipe, but it speaks asyncio subprocesses.
            try:
                proc = await asyncio.create_subprocess_exec(
                    *self.argv, cwd=self.cwd, env=env,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )
            except Exception as error:  # noqa: BLE001
                raise TerminalError(str(error) or "Could not start the terminal command.",
                                    code="spawn_failed") from error
            self._aproc = proc
            self.pid = proc.pid
            self._reader = asyncio.create_task(self._read_aproc(proc))
            return
        self._proc = subprocess.Popen(
            self.argv, cwd=self.cwd, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        self.pid = self._proc.pid
        assert self._proc.stdout is not None
        fd = self._proc.stdout.fileno()
        loop = asyncio.get_running_loop()

        def drain() -> None:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b""
            if not chunk:
                try:
                    loop.remove_reader(fd)
                except (OSError, ValueError):
                    pass
                self._finish()
                return
            if self.on_output:
                self.on_output(chunk)

        loop.add_reader(fd, drain)

    async def _read_aproc(self, proc: Any) -> None:
        assert proc.stdout is not None
        try:
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
                if self.on_output:
                    self.on_output(chunk)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - a broken pipe is an exit, not a crash
            pass
        finally:
            with contextlib.suppress(Exception):
                await proc.wait()
            self._finish()
    def _finish(self) -> None:
        if self._aproc is not None:
            code = self._aproc.returncode
        else:
            code = self._proc.poll() if self._proc else None
        self.exit_code = code
        for waiter in self._waiters:
            if not waiter.done():
                waiter.set_result(code)
        self._waiters.clear()

    async def write(self, data: bytes) -> None:
        if self._closed:
            raise TerminalError("This terminal is closed.", code="terminal_closed")
        if self._master is not None:
            await asyncio.get_running_loop().run_in_executor(None, os.write, self._master, data)
            return
        if self._aproc is not None and self._aproc.stdin is not None:
            self._aproc.stdin.write(data)
            await self._aproc.stdin.drain()
            return
        if self._proc is None or self._proc.stdin is None:
            raise TerminalError("This terminal has no stdin.", code="terminal_closed")
        self._proc.stdin.write(data)
        self._proc.stdin.flush()

    async def resize(self, cols: int, rows: int) -> None:
        self.cols, self.rows = max(20, int(cols)), max(5, int(rows))
        if self._master is None or not pty_available():
            return
        import fcntl
        import struct
        import termios

        try:
            fcntl.ioctl(self._master, termios.TIOCSWINSZ,
                        struct.pack("HHHH", self.rows, self.cols, 0, 0))
        except OSError:
            pass

    async def wait(self) -> int | None:
        if self.exit_code is not None:
            return self.exit_code
        future: asyncio.Future[int | None] = asyncio.get_running_loop().create_future()
        self._waiters.append(future)
        return await future

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        loop = asyncio.get_running_loop()
        if self._master is not None:
            try:
                loop.remove_reader(self._master)
            except (OSError, ValueError):
                pass
            try:
                os.close(self._master)
            except OSError:
                pass
            self._master = None
        if self._aproc is not None:
            if self._aproc.returncode is None:
                try:
                    self._aproc.terminate()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(self._aproc.wait(), timeout=2)
                except asyncio.TimeoutError:
                    try:
                        self._aproc.kill()
                    except ProcessLookupError:
                        pass
            if self._reader is not None:
                self._reader.cancel()
            self._finish()
            return
        if self._proc is not None and self._proc.poll() is None:
            try:
                self._proc.terminate()
            except OSError:
                pass
            try:
                self._proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        self._finish()