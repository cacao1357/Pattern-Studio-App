"""Single coordinator; each local or provider task has its own bounded process."""

import os
import json
from pathlib import Path
import re
import subprocess
import sys
import threading
import time

from app.storage import ServiceError


_MEMORY_HANDLE = None
LOCAL_MEMORY_MIB = 6144
LINEART_MODEL_MEMORY_MIB = 6144


def bind_memory_limit(memory_mib=LOCAL_MEMORY_MIB):
    global _MEMORY_HANDLE
    if os.name != "nt":
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (memory_mib * 1024 * 1024,) * 2)
        return
    import ctypes
    from ctypes import wintypes

    class Basic(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                    "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class Extended(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", Basic), ("IoInfo", IoCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = (wintypes.HANDLE, wintypes.INT, ctypes.c_void_p, wintypes.DWORD)
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = kernel.CreateJobObjectW(None, None)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    limits = Extended()
    limits.BasicLimitInformation.LimitFlags = 0x100
    limits.ProcessMemoryLimit = memory_mib * 1024 * 1024
    if memory_mib == LINEART_MODEL_MEMORY_MIB:
        limits.BasicLimitInformation.LimitFlags |= 0x200
        limits.JobMemoryLimit = limits.ProcessMemoryLimit
    if not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        error = ctypes.get_last_error()
        kernel.CloseHandle(handle)
        raise ctypes.WinError(error)
    _MEMORY_HANDLE = handle


def _watch_parent(parent_pid):
    """Do not leave computation behind if its coordinating API crashes."""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        handle = kernel.OpenProcess(0x00100000, False, parent_pid)
        if not handle:
            os._exit(3)
        if kernel.WaitForSingleObject(handle, 0xFFFFFFFF) == 0:
            os._exit(3)
    else:
        while os.getppid() == parent_pid:
            time.sleep(0.5)
        os._exit(3)


def child_main(root, job_id, token, parent_pid, memory_mib=LOCAL_MEMORY_MIB):
    threading.Thread(target=_watch_parent, args=(parent_pid,), daemon=True).start()
    try:
        bind_memory_limit(memory_mib)
    except Exception:
        return 4  # Fail closed before loading algorithms if the limit is unavailable.
    from app.workbench_store import WorkbenchStore
    from app.services.local_workbench import execute_local
    from app.schemas.contracts import ProcessingError
    from app.storage import ServiceError
    store = WorkbenchStore(Path(root))
    try:
        job = store.get_job(job_id)
        if job["kind"] == "decompose-layers" or job["kind"] == "repair" and not job["parameters"].get("provider_call_id"):
            from pydantic import SecretStr
            from app.config import Settings
            from app.services.assisted_workbench import execute_decomposition
            data = sys.stdin.buffer.read(16 * 1024 + 1)
            if len(data) > 16 * 1024:
                raise ServiceError("PROVIDER_CONFIG_INVALID", "Provider worker configuration exceeds the local limit")
            config = json.loads(data)
            config["ark_api_key"] = SecretStr(config["ark_api_key"])
            config["api_token"] = SecretStr(config["api_token"])
            config["storage_root"] = Path(root)
            if job["kind"] == "repair":
                from app.services.finishing_workbench import execute_repair
                execute_repair(store, job, token, Settings(**config))
            else:
                execute_decomposition(store, job, token, Settings(**config))
        else:
            execute_local(store, job_id, token)
        store.finish_job(job_id, token)
    except (ProcessingError, ServiceError) as error:
        store.finish_job(job_id, token, {"code": error.code, "message": str(error)})
    except MemoryError:
        store.finish_job(job_id, token, {"code": "WORKER_MEMORY_LIMIT",
                                         "message": f"Local processing reached the {memory_mib} MiB memory limit; use a smaller working copy"})
    except Exception:
        store.finish_job(job_id, token, {"code": "LOCAL_PROCESSING_FAILED", "message": "Local processing failed; the original and previous versions remain available"})
    return 0


class LocalWorker:
    def __init__(self, store, *, timeout_seconds=90, provider_settings=None):
        self.store, self.timeout_seconds = store, timeout_seconds
        self.provider_settings = provider_settings
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._loop, name="pattern-studio-local-worker", daemon=True)
        self.last_heartbeat = time.time()
        self.last_error = None
        self.active_job_id = None

    def start(self):
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.thread.join(timeout=8)

    def status(self):
        return {"alive": self.thread.is_alive() and time.time() - self.last_heartbeat < 15,
                "heartbeat_age_seconds": round(time.time() - self.last_heartbeat, 2),
                "active_job_id": self.active_job_id, "error": self.last_error,
                "timeout_seconds": self.timeout_seconds, "provider_timeout_seconds": max(180, self.timeout_seconds),
                "memory_limit_mib": LOCAL_MEMORY_MIB, "lineart_model_memory_limit_mib": LINEART_MODEL_MEMORY_MIB,
                "concurrency": 1}

    def _loop(self):
        from app.services.workflow import WorkflowCoordinator
        workflows = WorkflowCoordinator(self.store)
        while not self.stop_event.is_set():
            self.last_heartbeat = time.time()
            try:
                workflows.advance()
                claimed = self.store.claim()
                self.last_error = None
                if claimed:
                    job, token = claimed
                    self.active_job_id = job["job_id"]
                    try:
                        self._run(job, token)
                    finally:
                        self.active_job_id = None
                    continue
            except Exception:
                self.last_error = "LOCAL_WORKER_UNAVAILABLE"
            self.stop_event.wait(0.2)

    def _run(self, job, token):
        backend = Path(__file__).resolve().parents[1]
        env = {k: os.environ[k] for k in ("SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP") if k in os.environ}
        env.update(PYTHONPATH=str(backend), PYTHONDONTWRITEBYTECODE="1", PYTHONUTF8="1")
        model_lineart = (
            (job["kind"] == "lineart" and job["parameters"].get("method") == "model")
            or (job["kind"] == "pipeline" and job["parameters"].get("recipe") == "model_lineart")
        )
        memory_mib = LINEART_MODEL_MEMORY_MIB if model_lineart else LOCAL_MEMORY_MIB
        command = [sys.executable, "-B", "-m", "app.worker", str(self.store.root), job["job_id"], token,
                   str(os.getpid()), str(memory_mib)]
        child = None
        diagnostics = bytearray()
        reader = None
        error = None
        started = time.monotonic()
        provider_task = job["kind"] == "decompose-layers" or job["kind"] == "repair" and not job["parameters"].get("provider_call_id")
        deadline_seconds = max(180, self.timeout_seconds) if provider_task else self.timeout_seconds
        try:
            current_settings = self.provider_settings() if callable(self.provider_settings) else self.provider_settings
            if provider_task and (current_settings is None or current_settings.blockers()):
                raise ServiceError("PROVIDER_DISABLED", "The queued cloud task was blocked by current settings; no new provider request was sent", 503)
            child = subprocess.Popen(command, cwd=backend.parent, env=env, stdin=subprocess.PIPE if provider_task else subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                     creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)

            if provider_task:
                from dataclasses import fields
                config = {}
                for field in fields(current_settings):
                    if field.name == "storage_root":
                        continue
                    value = getattr(current_settings, field.name)
                    config[field.name] = value.get_secret_value() if hasattr(value, "get_secret_value") else value
                # Credentials travel once through the owned child's private pipe;
                # never through argv, environment, a temporary file or the browser.
                child.stdin.write(json.dumps(config).encode("utf-8"))
                child.stdin.close()

            def drain_diagnostics():
                # Drain to avoid a pipe deadlock, retain only a bounded private prefix.
                for chunk in iter(lambda: child.stderr.read(1024), b""):
                    diagnostics.extend(chunk[:max(0, 4096 - len(diagnostics))])

            reader = threading.Thread(target=drain_diagnostics, daemon=True)
            reader.start()
            while child.poll() is None:
                self.last_heartbeat = time.time()
                if self.stop_event.is_set():
                    error = {"code": "PROCESS_INTERRUPTED", "message": "The API stopped during local processing; retry explicitly to create a new version"}
                    break
                if time.monotonic() - started > deadline_seconds:
                    error = {"code": "PROVIDER_WORKER_TIMEOUT" if provider_task else "WORKER_TIMEOUT",
                             "message": "AI processing was interrupted; reconcile the existing provider call before generating again" if provider_task else
                                        "Local processing exceeded its time limit; use a smaller working copy or lower detail"}
                    break
                if not self.store.heartbeat(job["job_id"], token):
                    break
                self.stop_event.wait(0.2)
            if error is None and child.poll() not in (None, 0):
                error = {"code": "WORKER_LIMIT_UNAVAILABLE" if child.returncode == 4 else "WORKER_EXITED",
                         "message": "The bounded local worker could not complete; use a smaller working copy and retry explicitly"}
        except ServiceError as failure:
            error = {"code": failure.code, "message": str(failure)}
        except Exception:
            error = {"code": "WORKER_START_FAILED", "message": "The local worker could not start in the current Python environment"}
        finally:
            if child and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=2)
            if reader:
                reader.join(timeout=1)
            if child and child.stdin and not child.stdin.closed:
                child.stdin.close()
            if child and child.stderr:
                child.stderr.close()
            if child and child.returncode not in (None, 0):
                if re.search(rb"memory allocation of [0-9]+ bytes failed", diagnostics):
                    error = {"code": "WORKER_MEMORY_LIMIT",
                             "message": f"Image processing reached the {memory_mib} MiB memory limit; use a smaller working copy and review any interrupted AI call before retrying"}
                if error:
                    error["worker_exit_code"] = child.returncode
            if self.store.get_job(job["job_id"])["state"] == "running":
                try:
                    if provider_task:
                        self.store.interrupt_provider_job(job["job_id"], token)
                    self.store.finish_job(job["job_id"], token, error or {
                        "code": "WORKER_EXITED", "message": "Local processing ended without publishing a final task state"})
                except ServiceError:
                    # Cancellation or completion may win after the state check above.
                    # Report stale ownership only when the task is still active.
                    if self.store.get_job(job["job_id"])["state"] not in {"cancelled", "succeeded", "failed"}:
                        raise


if __name__ == "__main__":
    raise SystemExit(child_main(sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])))
