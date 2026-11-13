import json
import base64
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pydantic import SecretStr, ValidationError

from app.config import ARK_BASE_URL, DEFAULT_MODEL, ConfigurationError, Settings, load_settings
from app.credential_store import CredentialProtectionError
from app.schemas.settings import SettingsUpdate
from app.services.runtime_settings import RuntimeSettings, RuntimeSettingsConflict


class RuntimeSettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.storage = self.root / "storage" / "api"
        self.storage.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def settings(self, key="old-test-key"):
        return Settings(api_token=SecretStr("local-test-token"), ark_api_key=SecretStr(key),
                        storage_root=self.storage)

    def test_update_replaces_key_and_public_response_never_returns_secret(self):
        manager = RuntimeSettings(self.settings())
        self.assertEqual(manager.public()["api_key_storage"], "not_saved")
        result = manager.update(SettingsUpdate(revision=1, api_key_action="replace",
                                               api_key="new-test-key", paid_calls_enabled=True))

        self.assertEqual(result["revision"], 2)
        self.assertTrue(result["api_key_configured"])
        self.assertEqual(result["api_key_storage"], "windows_dpapi" if os.name == "nt" else "private_file")
        self.assertTrue(result["paid_calls_enabled"])
        self.assertNotIn("api_key", result)
        self.assertNotIn("new-test-key", json.dumps(result))
        self.assertEqual(manager.current().ark_api_key.get_secret_value(), "new-test-key")
        self.assertEqual(set(manager.secrets()), {"old-test-key", "new-test-key", "local-test-token"})
        saved = json.loads((self.root / "storage" / "settings.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["revision"], 2)
        if os.name == "nt":
            self.assertIn("api_key_protected", saved)
            self.assertNotIn("api_key", saved)
            self.assertNotIn("new-test-key", json.dumps(saved))
        else:
            self.assertEqual(saved["api_key"], "new-test-key")

    def test_concurrent_updates_accept_exactly_one_revision(self):
        manager = RuntimeSettings(self.settings())
        def update(max_calls):
            try:
                return manager.update(SettingsUpdate(revision=1, max_calls=max_calls))["revision"]
            except RuntimeSettingsConflict:
                return "conflict"
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(update, [6, 7]))
        self.assertEqual(results.count(2), 1)
        self.assertEqual(results.count("conflict"), 1)
        self.assertEqual(manager.public()["revision"], 2)

    def test_clear_key_persists_and_load_settings_applies_private_override(self):
        manager = RuntimeSettings(self.settings())
        manager.update(SettingsUpdate(revision=1, api_key_action="clear", model=DEFAULT_MODEL))

        restarted = load_settings(self.root, environ={
            "ARK_API_KEY": "environment-key",
            "SEEDREAM_MODEL": "doubao-seedream-5-0-flash-260601",
        })
        self.assertEqual(restarted.ark_api_key.get_secret_value(), "")
        self.assertEqual(restarted.model, DEFAULT_MODEL)
        self.assertEqual(restarted.base_url, ARK_BASE_URL)

    def test_stale_revision_is_rejected_without_changing_active_settings(self):
        manager = RuntimeSettings(self.settings())
        manager.update(SettingsUpdate(revision=1, paid_calls_enabled=True))

        with self.assertRaises(RuntimeSettingsConflict):
            manager.update(SettingsUpdate(revision=1, paid_calls_enabled=False))
        self.assertTrue(manager.current().paid_calls_enabled)
        self.assertEqual(manager.public()["revision"], 2)

    def test_invalid_destination_and_key_action_are_rejected(self):
        manager = RuntimeSettings(self.settings())
        with self.assertRaises(ConfigurationError):
            manager.update(SettingsUpdate(revision=1, base_url="https://example.invalid/api"))
        with self.assertRaises(ValidationError):
            SettingsUpdate(revision=1, api_key="must-not-be-accepted-with-keep")
        self.assertEqual(manager.public()["revision"], 1)
        self.assertEqual(manager.current().base_url, ARK_BASE_URL)

    def test_seedream_5_5_model_is_accepted_and_unknown_models_rejected(self):
        manager = RuntimeSettings(self.settings())
        result = manager.update(SettingsUpdate(revision=1, model="doubao-seedream-5-5-261028"))
        self.assertEqual(result["model"], "doubao-seedream-5-5-261028")
        with self.assertRaises(ConfigurationError):
            manager.update(SettingsUpdate(revision=2, model="doubao-seedream-9-9-999999"))
        self.assertEqual(manager.current().model, "doubao-seedream-5-5-261028")

    @unittest.skipUnless(os.name == "nt", "Windows DPAPI is only available on Windows")
    def test_windows_key_is_protected_and_survives_restart_keep_and_clear(self):
        manager = RuntimeSettings(self.settings())
        result = manager.update(SettingsUpdate(revision=1, api_key_action="replace", api_key="new-windows-test-key"))
        path = self.root / "storage" / "settings.json"
        saved = json.loads(path.read_text(encoding="utf-8"))
        self.assertIn("api_key_protected", saved)
        self.assertNotIn("api_key", saved)
        self.assertNotIn("new-windows-test-key", path.read_text(encoding="utf-8"))
        self.assertNotIn("api_key_protected", json.dumps(result))
        self.assertNotIn("new-windows-test-key", json.dumps(result))
        self.assertEqual(result["api_key_storage"], "windows_dpapi")

        restarted_settings = load_settings(self.root, environ={})
        self.assertEqual(restarted_settings.ark_api_key.get_secret_value(), "new-windows-test-key")
        restarted = RuntimeSettings(restarted_settings)
        restarted.update(SettingsUpdate(revision=2, paid_calls_enabled=True))
        kept = load_settings(self.root, environ={})
        self.assertEqual(kept.ark_api_key.get_secret_value(), "new-windows-test-key")
        self.assertTrue(kept.paid_calls_enabled)

        RuntimeSettings(kept).update(SettingsUpdate(revision=3, api_key_action="clear"))
        cleared = load_settings(self.root, environ={})
        self.assertEqual(cleared.ark_api_key.get_secret_value(), "")

    def test_legacy_plaintext_settings_load_and_migrate_on_save(self):
        path = self.root / "storage" / "settings.json"
        path.write_text(json.dumps({"revision": 1, "api_key": "legacy-test-key"}), encoding="utf-8")
        loaded = load_settings(self.root, environ={})
        self.assertEqual(loaded.ark_api_key.get_secret_value(), "legacy-test-key")
        manager = RuntimeSettings(loaded)
        self.assertEqual(manager.public()["api_key_storage"], "private_file")
        manager.update(SettingsUpdate(revision=1, model=DEFAULT_MODEL))
        saved = json.loads(path.read_text(encoding="utf-8"))
        if os.name == "nt":
            self.assertNotIn("api_key", saved)
            self.assertIn("api_key_protected", saved)
            self.assertNotIn("legacy-test-key", path.read_text(encoding="utf-8"))
        else:
            self.assertEqual(saved["api_key"], "legacy-test-key")

    @unittest.skipUnless(os.name == "nt", "Windows DPAPI is only available on Windows")
    def test_unreadable_protected_key_fails_closed_without_environment_fallback(self):
        path = self.root / "storage" / "settings.json"
        invalid_ciphertext = base64.b64encode(b"not a DPAPI payload").decode("ascii")
        path.write_text(json.dumps({"revision": 1, "api_key_protected": invalid_ciphertext}), encoding="utf-8")
        with self.assertRaises(ConfigurationError) as caught:
            load_settings(self.root, environ={"ARK_API_KEY": "environment-fallback-secret"})
        self.assertNotIn("environment-fallback-secret", str(caught.exception))
        self.assertIn("could not be opened", str(caught.exception))

    def test_private_settings_reject_both_plaintext_and_protected_key_fields(self):
        path = self.root / "storage" / "settings.json"
        path.write_text(json.dumps({"revision": 1, "api_key": "legacy-secret",
                                    "api_key_protected": "encrypted-secret"}), encoding="utf-8")
        with self.assertRaises(ConfigurationError) as caught:
            load_settings(self.root, environ={})
        self.assertNotIn("legacy-secret", str(caught.exception))
        self.assertNotIn("encrypted-secret", str(caught.exception))

    @unittest.skipUnless(os.name == "nt", "Windows DPAPI is only available on Windows")
    def test_windows_protection_failure_keeps_existing_settings_and_active_key(self):
        manager = RuntimeSettings(self.settings())
        with patch("app.services.runtime_settings.protect_key", side_effect=CredentialProtectionError("safe failure")):
            with self.assertRaises(ConfigurationError) as caught:
                manager.update(SettingsUpdate(revision=1, api_key_action="replace", api_key="must-not-leak"))
        self.assertNotIn("must-not-leak", str(caught.exception))
        self.assertEqual(manager.current().ark_api_key.get_secret_value(), "old-test-key")
        self.assertEqual(manager.public()["revision"], 1)
        self.assertFalse((self.root / "storage" / "settings.json").exists())

    def test_failed_atomic_write_does_not_publish_candidate(self):
        bad_path = self.root / "a-directory"
        bad_path.mkdir()
        manager = RuntimeSettings(self.settings(), config_path=bad_path)
        with self.assertRaises(ConfigurationError) as caught:
            manager.update(SettingsUpdate(revision=1, api_key_action="replace", api_key="secret-that-must-not-leak"))
        self.assertNotIn("secret-that-must-not-leak", str(caught.exception))
        self.assertEqual(manager.current().ark_api_key.get_secret_value(), "old-test-key")
        self.assertEqual(manager.public()["revision"], 1)


if __name__ == "__main__":
    unittest.main()
