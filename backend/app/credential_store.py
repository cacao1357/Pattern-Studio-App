"""Current-user Windows protection for credentials stored by local settings."""

import base64
import ctypes
from ctypes import wintypes
import os


class CredentialProtectionError(ValueError):
    """Credential protection failed without including the credential in errors."""


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


CRYPTPROTECT_UI_FORBIDDEN = 0x1


def _blob(data: bytes):
    buffer = ctypes.create_string_buffer(data, max(len(data), 1))
    return _DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte))), buffer


def _dpapi(data: bytes, *, decrypt: bool) -> bytes:
    if os.name != "nt":
        raise CredentialProtectionError("Windows credential protection is unavailable")
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    source, source_buffer = _blob(data)
    destination = _DataBlob()
    if decrypt:
        operation = crypt32.CryptUnprotectData
        operation.argtypes = (ctypes.POINTER(_DataBlob), ctypes.POINTER(wintypes.LPWSTR),
                              ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                              wintypes.DWORD, ctypes.POINTER(_DataBlob))
        operation.restype = wintypes.BOOL
        success = operation(ctypes.byref(source), None, None, None, None,
                            CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(destination))
    else:
        operation = crypt32.CryptProtectData
        operation.argtypes = (ctypes.POINTER(_DataBlob), wintypes.LPCWSTR, ctypes.c_void_p,
                              ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD,
                              ctypes.POINTER(_DataBlob))
        operation.restype = wintypes.BOOL
        success = operation(ctypes.byref(source), "Pattern Studio API key", None, None, None,
                            CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(destination))
    if not success:
        raise CredentialProtectionError("Windows credential protection failed")
    try:
        return ctypes.string_at(destination.pbData, destination.cbData)
    finally:
        kernel32.LocalFree.argtypes = (ctypes.c_void_p,)
        kernel32.LocalFree.restype = ctypes.c_void_p
        kernel32.LocalFree(destination.pbData)
        # Keep the source buffer alive until DPAPI has finished reading it.
        del source_buffer


def protect_key(value: str) -> str:
    """Return base64 DPAPI ciphertext scoped to the current Windows user."""
    try:
        encrypted = _dpapi(value.encode("utf-8"), decrypt=False)
        return base64.b64encode(encrypted).decode("ascii")
    except (UnicodeError, OSError, AttributeError, ctypes.ArgumentError):
        raise CredentialProtectionError("Windows credential protection failed") from None


def unprotect_key(value: str) -> str:
    """Decode and decrypt a current-user DPAPI value."""
    try:
        ciphertext = base64.b64decode(value.encode("ascii"), validate=True)
        return _dpapi(ciphertext, decrypt=True).decode("utf-8")
    except (UnicodeError, ValueError, OSError, AttributeError, ctypes.ArgumentError):
        raise CredentialProtectionError("Saved Windows credential could not be opened for this user") from None
