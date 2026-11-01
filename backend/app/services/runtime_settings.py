"""Atomic, revisioned settings for one local Pattern Studio process."""

import json
import os
from pathlib import Path
import threading
from uuid import uuid4

from pydantic import SecretStr

from app.config import ConfigurationError, Settings
from app.schemas.settings import SettingsUpdate


class RuntimeSettingsConflict(ConfigurationError):
    """The submitted settings revision is stale; map this to HTTP 409."""


class RuntimeSettings:
    """Hold a live immutable settings snapshot and persist updates atomically."""

    def __init__(self, initial: Settings, config_path: Path | None = None):
        self._path = Path(config_path) if config_path is not None else initial.storage_root.parent / "settings.json"
        self._lock = threading.RLock()
        self._settings = initial
        self._revision = self._disk_revision(default=1)
        self._secrets = {initial.ark_api_key.get_secret_value(), initial.api_token.get_secret_value()}
        self._secrets.discard("")

    def _disk_document(self):
        try:
            if not self._path.is_file():
                return None
            if self._path.stat().st_size > 16 * 1024:
                raise ConfigurationError("Private settings exceed the configuration size limit")
            document = json.loads(self._path.read_text(encoding="utf-8"))
            if not isinstance(document, dict):
                raise ConfigurationError("Private settings have an unsupported format")
            return document
        except ConfigurationError:
            raise
        except (OSError, json.JSONDecodeError, UnicodeError):
            raise ConfigurationError("Private settings could not be read") from None

    def _disk_revision(self, *, default):
        document = self._disk_document()
        if document is None:
            return default
        revision = document.get("revision", 1)
        if type(revision) is not int or revision < 1:
            raise ConfigurationError("Private settings revision is invalid")
        return revision

    def current(self) -> Settings:
        with self._lock:
            return self._settings

    def secrets(self) -> tuple[str, ...]:
        with self._lock:
            return tuple(sorted(self._secrets, key=len, reverse=True))

    def public(self) -> dict:
        with self._lock:
            return self._public_locked()

    def _public_locked(self):
        settings = self._settings
        return {
            "revision": self._revision,
            "api_key_configured": bool(settings.ark_api_key.get_secret_value()),
            "model": settings.model,
            "base_url": settings.base_url,
            "paid_calls_enabled": settings.paid_calls_enabled,
            "pricing_confirmed": settings.pricing_confirmed,
            "budget_cents": settings.budget_cents,
            "reservation_cents": settings.reservation_cents,
            "max_calls": settings.max_calls,
            "blockers": settings.blockers(),
            "effective": "next_provider_job",
            "requires_restart": False,
        }

    def update(self, payload: SettingsUpdate) -> dict:
        """Validate, compare revision, persist, then publish the new live snapshot."""
        if not isinstance(payload, SettingsUpdate):
            raise TypeError("payload must be a validated SettingsUpdate")
        with self._lock:
            disk_revision = self._disk_revision(default=1)
            if payload.revision != self._revision or disk_revision != self._revision:
                raise RuntimeSettingsConflict("Settings changed; reload and apply your update again")
            old = self._settings
            values = {
                "api_token": old.api_token,
                "ark_api_key": old.ark_api_key,
                "storage_root": old.storage_root,
                "model": old.model,
                "base_url": old.base_url,
                "paid_calls_enabled": old.paid_calls_enabled,
                "pricing_confirmed": old.pricing_confirmed,
                "budget_cents": old.budget_cents,
                "reservation_cents": old.reservation_cents,
                "max_calls": old.max_calls,
                "response_limit_bytes": old.response_limit_bytes,
                "output_pixel_limit": old.output_pixel_limit,
            }
            for field in ("model", "base_url", "paid_calls_enabled", "pricing_confirmed",
                          "budget_cents", "reservation_cents", "max_calls"):
                value = getattr(payload, field)
                if value is not None:
                    values[field] = value
            if payload.api_key_action == "replace":
                assert payload.api_key is not None
                values["ark_api_key"] = payload.api_key
            elif payload.api_key_action == "clear":
                values["ark_api_key"] = SecretStr("")
            # Settings validates the unchanged endpoint allowlist, key/token conflict,
            # model syntax and all provider budgets before any filesystem mutation.
            candidate = Settings(**values)
            next_revision = self._revision + 1
            document = {
                "revision": next_revision,
                "api_key": candidate.ark_api_key.get_secret_value(),
                "model": candidate.model,
                "base_url": candidate.base_url,
                "paid_calls_enabled": candidate.paid_calls_enabled,
                "pricing_confirmed": candidate.pricing_confirmed,
                "budget_cents": candidate.budget_cents,
                "reservation_cents": candidate.reservation_cents,
                "max_calls": candidate.max_calls,
            }
            self._atomic_write(document)
            if old.ark_api_key.get_secret_value():
                self._secrets.add(old.ark_api_key.get_secret_value())
            if candidate.ark_api_key.get_secret_value():
                self._secrets.add(candidate.ark_api_key.get_secret_value())
            self._settings = candidate
            self._revision = next_revision
            return self._public_locked()

    def _atomic_write(self, document):
        temporary = self._path.with_name(self._path.name + "." + uuid4().hex + ".tmp")
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            payload = json.dumps(document, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
            with temporary.open("xb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            if os.name != "nt":
                os.chmod(temporary, 0o600)
            temporary.replace(self._path)
        except OSError:
            raise ConfigurationError("Private settings could not be saved; the active settings are unchanged") from None
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
