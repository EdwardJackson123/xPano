import os
import subprocess

if os.name == "nt":
    import ctypes
    from ctypes import wintypes


def popen_creationflags():
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


class _NoopProcessJob:
    def terminate(self):
        pass

    def close(self):
        pass


if os.name == "nt":
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    _kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    _kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    _kernel32.SetInformationJobObject.restype = wintypes.BOOL
    _kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    _kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    _kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    _kernel32.TerminateJobObject.restype = wintypes.BOOL
    _kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _kernel32.OpenProcess.restype = wintypes.HANDLE
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel32.CloseHandle.restype = wintypes.BOOL

    _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
    _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
    _PROCESS_SET_QUOTA = 0x0100
    _PROCESS_TERMINATE = 0x0001

    class _IoCounters(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_ulonglong),
            ("WriteOperationCount", ctypes.c_ulonglong),
            ("OtherOperationCount", ctypes.c_ulonglong),
            ("ReadTransferCount", ctypes.c_ulonglong),
            ("WriteTransferCount", ctypes.c_ulonglong),
            ("OtherTransferCount", ctypes.c_ulonglong),
        ]

    class _JobObjectBasicLimitInformation(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class _JobObjectExtendedLimitInformation(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _JobObjectBasicLimitInformation),
            ("IoInfo", _IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    def _last_error():
        return ctypes.WinError(ctypes.get_last_error())

    class _WindowsProcessJob:
        def __init__(self):
            self.handle = _kernel32.CreateJobObjectW(None, None)
            if not self.handle:
                raise _last_error()
            limits = _JobObjectExtendedLimitInformation()
            limits.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            ok = _kernel32.SetInformationJobObject(
                self.handle,
                _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                ctypes.byref(limits),
                ctypes.sizeof(limits),
            )
            if not ok:
                error = _last_error()
                self.close()
                raise error

        def assign_pid(self, pid):
            process = _kernel32.OpenProcess(_PROCESS_SET_QUOTA | _PROCESS_TERMINATE, False, int(pid))
            if not process:
                raise _last_error()
            try:
                if not _kernel32.AssignProcessToJobObject(self.handle, process):
                    raise _last_error()
            finally:
                _kernel32.CloseHandle(process)

        def terminate(self):
            if self.handle:
                _kernel32.TerminateJobObject(self.handle, 1)

        def close(self):
            if self.handle:
                _kernel32.CloseHandle(self.handle)
                self.handle = None

        def __del__(self):
            self.close()


def guard_process(proc: subprocess.Popen):
    pid = getattr(proc, "pid", None)
    if os.name != "nt" or not pid:
        return _NoopProcessJob()
    try:
        job = _WindowsProcessJob()
        job.assign_pid(pid)
        return job
    except Exception:
        return _NoopProcessJob()


def kill_process_tree(proc: subprocess.Popen):
    poll = getattr(proc, "poll", None)
    if poll is None or poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        proc.kill()


def cleanup_process_tree(proc: subprocess.Popen, job=None, timeout=5):
    poll = getattr(proc, "poll", None)
    if poll is None:
        return
    job = job or _NoopProcessJob()
    if poll() is not None:
        job.close()
        return
    job.terminate()
    kill_process_tree(proc)
    try:
        proc.wait(timeout=timeout)
    except Exception:
        pass
    finally:
        job.close()
