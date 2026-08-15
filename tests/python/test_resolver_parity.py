"""One fixture table, both vault resolvers, byte-equal answers (GitHub #130).

The reported failure - Hermes showing "Needs Setup" after a completed setup -
is not a bug in either resolver read on its own. It is a DISAGREEMENT: the
TypeScript ``resolveVault`` finds a vault that ``plugins/hermes/config.py``
cannot see, so ``o2b`` works and the provider reports itself unconfigured.
Two independent suites, each asserting what its own side does, is exactly the
shape of test that let that ship. So this suite asserts one thing only: for
the same inputs, the two resolvers return the same answer.

## Why both sides run as subprocesses

Each fixture row is an environment (``VAULT_DIR``, ``HOME``,
``OPEN_SECOND_BRAIN_CONFIG``) plus a working directory - the pointer walk-up
starts at the cwd - plus a directory layout. Driving the Python resolver
in-process would mean mutating ``os.environ`` and ``os.chdir`` for every row,
which is both a hazard for the rest of the suite and asymmetric with the
TypeScript side, which has to be a subprocess regardless. Two subprocesses
handed the identical ``env`` and ``cwd``, each printing the same JSON shape,
makes the comparison the whole test rather than an artifact of how each side
was invoked.

CI runs both toolchains in the same job (Bun, then Python 3.11), which is why
this shape was chosen over generating a fixture from one side and replaying it
in the other: a recorded fixture pins what the recording side did on the day it
was recorded, and the divergence class here is precisely one side drifting.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

PLUGIN_CONFIG_PY = ROOT / "plugins" / "hermes" / "config.py"
CORE_CONFIG_TS = ROOT / "src" / "core" / "config.ts"

# Environment keys that steer either resolver. Every row starts from a copy of
# the ambient environment with all of these removed, so a developer's own
# vault can never make a row pass or fail.
_STEERING_ENV_KEYS = (
    "VAULT_DIR",
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "OPEN_SECOND_BRAIN_CONFIG",
    "XDG_CONFIG_HOME",
    "HOME",
)

# Both drivers print this exact shape so a row is one dict comparison.
_TS_DRIVER = """
const core = await import(process.env.O2B_PARITY_CORE);
const out = { vault: null, agent_name: null, error_kind: null, error_message: null };
try {
  out.vault = core.resolveVault();
  out.agent_name = core.resolveAgentName();
} catch (exc) {
  out.error_kind = exc?.name ?? "Error";
  out.error_message = exc?.message ?? String(exc);
}
console.log(JSON.stringify(out));
"""

_PY_DRIVER = """
import importlib.util, json, os, sys

spec = importlib.util.spec_from_file_location("o2b_hermes_config", os.environ["O2B_PARITY_PLUGIN"])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
out = {"vault": None, "agent_name": None, "error_kind": None, "error_message": None}
try:
    out["vault"] = mod.resolve_vault()
    out["agent_name"] = mod.resolve_agent_name()
except Exception as exc:
    out["error_kind"] = type(exc).__name__
    out["error_message"] = str(exc)
sys.stdout.write(json.dumps(out))
"""

# The one sentence both refusals must carry. It is the whole value of naming a
# present-but-unreadable config instead of reporting it absent: the operator is
# told what to do next. Rendered with the offending path by each side.
REMEDIATION_TEMPLATE = (
    "The file is present, so its settings are NOT in force and are not read as absent; "
    'make it readable (chmod u+r "{path}") or set OPEN_SECOND_BRAIN_CONFIG to a '
    "readable config file."
)


def _write(path: Path, body: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return path


def _make_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def _profiles(path: Path, active, profiles: dict) -> Path:
    return _write(path, json.dumps({"active": active, "profiles": profiles}, indent=2) + "\n")


def _pointer(directory: Path, vault: str) -> Path:
    return _write(
        directory / ".o2b-vault.json",
        json.dumps({"vault": vault, "linked_at": "2026-01-01T00:00:00.000Z"}, indent=2) + "\n",
    )


class Layout:
    """One fixture row's on-disk state, environment and working directory."""

    def __init__(self, tmp: Path) -> None:
        self.tmp = tmp
        self.home = _make_dir(tmp / "home")
        self.config = tmp / "cfg" / "config.yaml"
        self.cwd = _make_dir(tmp / "work")
        self.env: dict[str, str] = {}

    def finish(self) -> tuple[dict[str, str], str]:
        env = {"HOME": str(self.home), "OPEN_SECOND_BRAIN_CONFIG": str(self.config)}
        env.update(self.env)
        return env, str(self.cwd)


def _row_env_only(layout: Layout) -> None:
    _write(layout.config, 'vault: "/ignored/by/env"\n')
    layout.env["VAULT_DIR"] = str(_make_dir(layout.tmp / "env-vault"))


def _row_env_tilde(layout: Layout) -> None:
    _make_dir(layout.home / "env-vault")
    layout.env["VAULT_DIR"] = "~/env-vault"


def _row_env_bare_tilde(layout: Layout) -> None:
    layout.env["VAULT_DIR"] = "~"


def _row_config_absolute(layout: Layout) -> None:
    vault = _make_dir(layout.tmp / "cfg-vault")
    _write(layout.config, f'vault: "{vault}"\nagent_name: "cfg-agent"\n')


def _row_config_tilde(layout: Layout) -> None:
    _make_dir(layout.home / "tilde-vault")
    _write(layout.config, 'vault: "~/tilde-vault"\n')


def _row_config_tilde_unquoted(layout: Layout) -> None:
    _make_dir(layout.home / "tilde-vault")
    _write(layout.config, "vault: ~/tilde-vault\n")


def _row_config_single_quoted(layout: Layout) -> None:
    vault = _make_dir(layout.tmp / "sq-vault")
    _write(layout.config, f"vault: '{vault}'\n")


def _row_config_absent(layout: Layout) -> None:
    return None


def _row_config_without_vault(layout: Layout) -> None:
    _write(layout.config, 'agent_name: "solo"\ntimezone: "UTC"\n')


def _row_config_empty_vault_value(layout: Layout) -> None:
    _write(layout.config, 'vault: ""\nagent_name: "solo"\n')


def _row_duplicate_vault_keys(layout: Layout) -> None:
    first = _make_dir(layout.tmp / "first-vault")
    last = _make_dir(layout.tmp / "last-vault")
    _write(layout.config, f'vault: "{first}"\nvault: "{last}"\n')


def _row_duplicate_agent_keys(layout: Layout) -> None:
    _write(layout.config, 'agentName: "camel"\nagent_name: "snake"\n')


def _row_agent_camel_only(layout: Layout) -> None:
    _write(layout.config, 'agentName: "camel-only"\n')


def _row_indented_vault_key(layout: Layout) -> None:
    vault = _make_dir(layout.tmp / "nested-vault")
    _write(layout.config, f'some_block:\n  vault: "{vault}"\n')


def _row_backslash_value(layout: Layout) -> None:
    # A value the TypeScript writer refuses outright. Whatever a hand-written
    # (or legacy-plugin-written) file holds, both readers must read it the same.
    _write(layout.config, 'vault: "C:\\\\Users\\\\me\\\\vault"\n')


def _row_comments_and_blanks(layout: Layout) -> None:
    vault = _make_dir(layout.tmp / "commented-vault")
    _write(layout.config, f'# vault: "/decoy"\n\n   \nvault: "{vault}"\n')


def _row_profile_active(layout: Layout) -> None:
    vault = _make_dir(layout.tmp / "profile-vault")
    cfg_vault = _make_dir(layout.tmp / "cfg-vault")
    _write(layout.config, f'vault: "{cfg_vault}"\n')
    _profiles(layout.config.parent / "profiles.json", "work", {"work": {"vault": str(vault)}})


def _row_profile_inactive(layout: Layout) -> None:
    cfg_vault = _make_dir(layout.tmp / "cfg-vault")
    _write(layout.config, f'vault: "{cfg_vault}"\n')
    _profiles(
        layout.config.parent / "profiles.json",
        None,
        {"work": {"vault": str(_make_dir(layout.tmp / "profile-vault"))}},
    )


def _row_profile_dangling_pointer(layout: Layout) -> None:
    cfg_vault = _make_dir(layout.tmp / "cfg-vault")
    _write(layout.config, f'vault: "{cfg_vault}"\n')
    _profiles(layout.config.parent / "profiles.json", "gone", {"work": {"vault": "/nowhere"}})


def _row_profile_missing_target_dir(layout: Layout) -> None:
    # A profile whose vault directory no longer exists still wins: the
    # read-only profile resolver never checks the filesystem.
    cfg_vault = _make_dir(layout.tmp / "cfg-vault")
    _write(layout.config, f'vault: "{cfg_vault}"\n')
    _profiles(
        layout.config.parent / "profiles.json",
        "work",
        {"work": {"vault": str(layout.tmp / "deleted-vault")}},
    )


def _row_profile_tilde(layout: Layout) -> None:
    _make_dir(layout.home / "profile-vault")
    _write(layout.config, 'vault: "/ignored"\n')
    _profiles(layout.config.parent / "profiles.json", "work", {"work": {"vault": "~/profile-vault"}})


def _row_profiles_absent(layout: Layout) -> None:
    _row_config_absolute(layout)


def _row_profiles_malformed(layout: Layout) -> None:
    cfg_vault = _make_dir(layout.tmp / "cfg-vault")
    _write(layout.config, f'vault: "{cfg_vault}"\n')
    _write(layout.config.parent / "profiles.json", "{ not json at all\n")


def _row_profiles_bad_shapes(layout: Layout) -> None:
    cfg_vault = _make_dir(layout.tmp / "cfg-vault")
    _write(layout.config, f'vault: "{cfg_vault}"\n')
    _write(
        layout.config.parent / "profiles.json",
        json.dumps({"active": 7, "profiles": {"work": {"vault": 12}}}) + "\n",
    )


def _row_pointer_here(layout: Layout) -> None:
    vault = _make_dir(layout.tmp / "pointer-vault")
    cfg_vault = _make_dir(layout.tmp / "cfg-vault")
    _write(layout.config, f'vault: "{cfg_vault}"\n')
    _pointer(layout.cwd, str(vault))


def _row_pointer_walk_up(layout: Layout) -> None:
    vault = _make_dir(layout.tmp / "pointer-vault")
    cfg_vault = _make_dir(layout.tmp / "cfg-vault")
    _write(layout.config, f'vault: "{cfg_vault}"\n')
    _pointer(layout.cwd, str(vault))
    layout.cwd = _make_dir(layout.cwd / "pkg" / "src")


def _row_pointer_dangling(layout: Layout) -> None:
    cfg_vault = _make_dir(layout.tmp / "cfg-vault")
    _write(layout.config, f'vault: "{cfg_vault}"\n')
    _pointer(layout.cwd, str(layout.tmp / "never-created"))


def _row_pointer_malformed(layout: Layout) -> None:
    cfg_vault = _make_dir(layout.tmp / "cfg-vault")
    _write(layout.config, f'vault: "{cfg_vault}"\n')
    _write(layout.cwd / ".o2b-vault.json", "{ broken\n")


def _row_pointer_no_vault_field(layout: Layout) -> None:
    cfg_vault = _make_dir(layout.tmp / "cfg-vault")
    _write(layout.config, f'vault: "{cfg_vault}"\n')
    _write(layout.cwd / ".o2b-vault.json", json.dumps({"linked_at": "2026-01-01"}) + "\n")


def _row_pointer_nearest_wins(layout: Layout) -> None:
    far = _make_dir(layout.tmp / "far-vault")
    near = _make_dir(layout.tmp / "near-vault")
    _pointer(layout.cwd, str(far))
    nested = _make_dir(layout.cwd / "pkg")
    _pointer(nested, str(near))
    layout.cwd = nested


def _row_pointer_beats_profile(layout: Layout) -> None:
    pointer_vault = _make_dir(layout.tmp / "pointer-vault")
    _write(layout.config, f'vault: "{_make_dir(layout.tmp / "cfg-vault")}"\n')
    _profiles(
        layout.config.parent / "profiles.json",
        "work",
        {"work": {"vault": str(_make_dir(layout.tmp / "profile-vault"))}},
    )
    _pointer(layout.cwd, str(pointer_vault))


def _row_env_beats_everything(layout: Layout) -> None:
    _row_pointer_beats_profile(layout)
    layout.env["VAULT_DIR"] = str(_make_dir(layout.tmp / "env-vault"))


def _row_config_is_a_directory(layout: Layout) -> None:
    _make_dir(layout.config)


def _row_config_not_utf8(layout: Layout) -> None:
    layout.config.parent.mkdir(parents=True, exist_ok=True)
    layout.config.write_bytes(b'vault: "/tmp/\xff\xfe-vault"\n')


def _row_config_parent_not_a_directory(layout: Layout) -> None:
    _write(layout.tmp / "cfg", "i am a file, not a directory\n")


def _row_config_unreadable(layout: Layout) -> None:
    _write(layout.config, 'vault: "/tmp/secret-vault"\n')
    layout.config.chmod(0o000)


# The fixture table. Every row runs through BOTH resolvers; nothing in it
# encodes what either side is expected to answer, only what they are both
# looking at.
FIXTURES: tuple[tuple[str, object], ...] = (
    ("env override, absolute", _row_env_only),
    ("env override, tilde", _row_env_tilde),
    ("env override, bare tilde", _row_env_bare_tilde),
    ("config key, absolute", _row_config_absolute),
    ("config key, tilde, quoted", _row_config_tilde),
    ("config key, tilde, unquoted", _row_config_tilde_unquoted),
    ("config key, single-quoted", _row_config_single_quoted),
    ("config absent", _row_config_absent),
    ("config without a vault key", _row_config_without_vault),
    ("config with an empty vault value", _row_config_empty_vault_value),
    ("duplicate vault keys", _row_duplicate_vault_keys),
    ("agent_name and agentName both present", _row_duplicate_agent_keys),
    ("agentName only", _row_agent_camel_only),
    ("vault key indented under another block", _row_indented_vault_key),
    ("value containing backslashes", _row_backslash_value),
    ("comments and blank lines", _row_comments_and_blanks),
    ("profiles.json active", _row_profile_active),
    ("profiles.json with no active profile", _row_profile_inactive),
    ("profiles.json active pointing at an unknown profile", _row_profile_dangling_pointer),
    ("profiles.json active whose vault directory is gone", _row_profile_missing_target_dir),
    ("profiles.json active with a tilde vault", _row_profile_tilde),
    ("profiles.json absent", _row_profiles_absent),
    ("profiles.json malformed", _row_profiles_malformed),
    ("profiles.json with wrongly typed fields", _row_profiles_bad_shapes),
    ("project pointer in the working directory", _row_pointer_here),
    ("project pointer found by walking up", _row_pointer_walk_up),
    ("project pointer at a vault that does not exist", _row_pointer_dangling),
    ("project pointer that is not valid JSON", _row_pointer_malformed),
    ("project pointer with no vault field", _row_pointer_no_vault_field),
    ("nearest project pointer wins", _row_pointer_nearest_wins),
    ("project pointer beats an active profile", _row_pointer_beats_profile),
    ("env override beats pointer and profile", _row_env_beats_everything),
    ("config path is a directory", _row_config_is_a_directory),
    ("config is not valid UTF-8", _row_config_not_utf8),
    ("config parent is not a directory", _row_config_parent_not_a_directory),
)

if os.name != "nt" and os.geteuid() != 0:
    # Root reads a mode-000 file, so this row would assert nothing there.
    FIXTURES = FIXTURES + (("config present but unreadable", _row_config_unreadable),)


class ResolverParityTests(unittest.TestCase):
    """Both resolvers, one fixture table, byte-equal answers."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.bun = shutil.which("bun")
        if cls.bun is None:
            raise unittest.SkipTest(
                "bun is not on PATH, so the TypeScript half of the comparison "
                "cannot be measured; this suite refuses to assert parity against "
                "one side alone"
            )

    def _base_env(self) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if k not in _STEERING_ENV_KEYS}
        env["O2B_PARITY_CORE"] = str(CORE_CONFIG_TS)
        env["O2B_PARITY_PLUGIN"] = str(PLUGIN_CONFIG_PY)
        return env

    def _run(self, argv: list[str], env: dict[str, str], cwd: str) -> dict:
        proc = subprocess.run(
            argv,
            env=env,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(
            proc.returncode,
            0,
            f"driver {argv[0]} exited {proc.returncode}\nstdout: {proc.stdout}\n"
            f"stderr: {proc.stderr}",
        )
        # Bun may print diagnostics; the payload is the last non-empty line.
        lines = [line for line in proc.stdout.splitlines() if line.strip()]
        self.assertTrue(lines, f"driver {argv[0]} printed nothing; stderr: {proc.stderr}")
        return json.loads(lines[-1])

    def _typescript(self, env: dict[str, str], cwd: str) -> dict:
        return self._run([self.bun, "-e", _TS_DRIVER], env, cwd)

    def _python(self, env: dict[str, str], cwd: str) -> dict:
        return self._run([sys.executable, "-c", _PY_DRIVER], env, cwd)

    def test_both_resolvers_agree_on_every_fixture(self) -> None:
        for name, build in FIXTURES:
            with self.subTest(fixture=name):
                with tempfile.TemporaryDirectory() as raw_tmp:
                    layout = Layout(Path(raw_tmp))
                    build(layout)
                    overrides, cwd = layout.finish()
                    env = self._base_env()
                    env.update(overrides)
                    try:
                        ts = self._typescript(env, cwd)
                        py = self._python(env, cwd)
                    finally:
                        # A mode-000 fixture must not defeat tempdir cleanup.
                        if layout.config.is_file():
                            layout.config.chmod(0o600)
                    self.assertEqual(
                        py["vault"],
                        ts["vault"],
                        f"vault disagreement on {name!r}: python={py['vault']!r} "
                        f"typescript={ts['vault']!r}",
                    )
                    self.assertEqual(
                        py["agent_name"],
                        ts["agent_name"],
                        f"agent disagreement on {name!r}: python={py['agent_name']!r} "
                        f"typescript={ts['agent_name']!r}",
                    )
                    self.assertEqual(
                        py["error_kind"],
                        ts["error_kind"],
                        f"refusal disagreement on {name!r}: python={py['error_kind']!r} "
                        f"typescript={ts['error_kind']!r} "
                        f"(python said {py['error_message']!r}, "
                        f"typescript said {ts['error_message']!r})",
                    )
                    if ts["error_kind"] is not None:
                        remediation = REMEDIATION_TEMPLATE.format(path=layout.config)
                        self.assertIn(remediation, ts["error_message"])
                        self.assertIn(remediation, py["error_message"])


if __name__ == "__main__":
    unittest.main()
