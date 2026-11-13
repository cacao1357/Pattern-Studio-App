import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import unittest

from pydantic import SecretStr, ValidationError

from app.config import ARK_BASE_URL, DEFAULT_MODEL, ConfigurationError, Settings, load_settings
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
        result = manager.update(SettingsUpdate(revision=1, api_key_action="replace",
                                               api_key="new-test-key", paid_calls_enabled=True))

        self.assertEqual(result["revision"], 2)
        self.assertTrue(result["api_key_configured"])
        self.assertTrue(result["paid_calls_enabled"])
        self.assertNotIn("api_key", result)
        self.assertNotIn("new-test-key", json.dumps(result))
        self.assertEqual(manager.current().ark_api_key.get_secret_value(), "new-test-key")
        self.assertEqual(set(manager.secrets()), {"old-test-key", "new-test-key", "local-test-token"})
        saved = json.loads((self.root / "storage" / "settings.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["revision"], 2)
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
