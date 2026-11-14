"""Tests for the bridge's parent-death spawn seam.

Hermes 0.23 replaced the per-child ``tools.mcp_stdio_watchdog`` wrapper with one
owner-death supervisor per process (hermes-agent commit 2d783a15); the seam it
exposes is ``hermes_cli.process_identity.spawn_owned``. These tests pin the
three-way precedence the bridge promises, in the order a host can offer it:

1. a host with ``spawn_owned`` - the child is spawned through it, so its process
   group reaches the supervisor;
2. an older Hermes with only ``tools.mcp_stdio_watchdog`` - argv is wrapped in
   that poller, exactly as before;
3. neither (a standalone checkout, or any non-Hermes harness) - a plain spawn,
   with one warning that the guarantee is unavailable.

The imports are simulated through ``sys.modules`` so the tests never require a
Hermes checkout, and the same code runs on the CI Python that has no host at all.
"""

import logging
import os
import subprocess
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from plugins.hermes import bridge as bridge_mod  # noqa: E402
from plugins.hermes.bridge import McpBrainBridge, SPAWN_PURPOSE  # noqa: E402

_MANAGED_MODULES = ("hermes_cli", "hermes_cli.process_identity", "tools", "tools.mcp_stdio_watchdog")


class SpawnSeamTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = {name: sys.modules.get(name) for name in _MANAGED_MODULES}
        # A None entry makes the import raise ImportError even on a machine
        # with Hermes installed, so "absent" means absent; a test that needs
        # a host installs its fake modules over these entries.
        for name in _MANAGED_MODULES:
            sys.modules[name] = None
        McpBrainBridge._watchdog_absent_warned = False
        self.bridge = McpBrainBridge(vault=None)

    def tearDown(self) -> None:
        for name, module in self._saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
        McpBrainBridge._watchdog_absent_warned = False

    def _install_spawn_owned(self, recorder):
        package = types.ModuleType("hermes_cli")
        package.__path__ = []  # a package, so the submodule import resolves
        identity = types.ModuleType("hermes_cli.process_identity")
        setattr(identity, "spawn_owned", recorder)
        setattr(package, "process_identity", identity)
        sys.modules["hermes_cli"] = package
        sys.modules["hermes_cli.process_identity"] = identity

    def _install_legacy_watchdog(self):
        package = types.ModuleType("tools")
        package.__path__ = []
        watchdog = types.ModuleType("tools.mcp_stdio_watchdog")
        watchdog.__file__ = "/host/tools/mcp_stdio_watchdog.py"
        setattr(package, "mcp_stdio_watchdog", watchdog)
        sys.modules["tools"] = package
        sys.modules["tools.mcp_stdio_watchdog"] = watchdog

    def test_spawn_owned_is_preferred_when_the_host_provides_it(self) -> None:
        calls = []

        def spawn_owned(argv, *, purpose, **popen_kwargs):
            calls.append((argv, purpose, popen_kwargs))
            return mock.sentinel.process

        self._install_spawn_owned(spawn_owned)
        with mock.patch("subprocess.Popen", side_effect=AssertionError("plain Popen must not run")):
            process = self.bridge._default_spawn(["o2b", "mcp"])

        self.assertIs(process, mock.sentinel.process)
        self.assertEqual(len(calls), 1)
        argv, purpose, popen_kwargs = calls[0]
        self.assertEqual(argv, ["o2b", "mcp"])
        self.assertEqual(purpose, SPAWN_PURPOSE)
        self.assertEqual(popen_kwargs["bufsize"], 0)
        self.assertIn("cwd", popen_kwargs)
        self.assertIn("env", popen_kwargs)

    @unittest.skipIf(os.name != "posix", "the legacy watchdog wraps POSIX children only; Windows relies on the layer-3 job object")
    def test_legacy_watchdog_wraps_argv_when_spawn_owned_is_absent(self) -> None:
        self._install_legacy_watchdog()
        with mock.patch("subprocess.Popen", return_value=mock.sentinel.process) as popen:
            process = self.bridge._default_spawn(["o2b", "mcp"])

        self.assertIs(process, mock.sentinel.process)
        spawned = popen.call_args.args[0]
        self.assertEqual(
            spawned,
            [
                sys.executable,
                "/host/tools/mcp_stdio_watchdog.py",
                "--ppid",
                str(os.getpid()),
                "--",
                "o2b",
                "mcp",
            ],
        )

    @unittest.skipIf(os.name != "posix", "the legacy watchdog wraps POSIX children only; Windows relies on the layer-3 job object")
    def test_plain_spawn_warns_once_when_no_host_seam_exists(self) -> None:
        with mock.patch("subprocess.Popen", return_value=mock.sentinel.process) as popen:
            with self.assertLogs(bridge_mod.logger, level=logging.WARNING) as logs:
                self.bridge._default_spawn(["o2b", "mcp"])
                self.bridge._default_spawn(["o2b", "mcp"])

        self.assertEqual(popen.call_args.args[0], ["o2b", "mcp"])
        warnings = [line for line in logs.output if "parent-death watchdog module unavailable" in line]
        self.assertEqual(len(warnings), 1, "the absence is a property of the install, not of the call")

    def test_broken_host_import_degrades_to_plain_spawn(self) -> None:
        package = types.ModuleType("hermes_cli")
        package.__path__ = []
        sys.modules["hermes_cli"] = package

        class Broken(types.ModuleType):
            def __getattr__(self, name):  # noqa: D105 - attribute access is the failure
                raise RuntimeError("host import is broken")

        sys.modules["hermes_cli.process_identity"] = Broken("hermes_cli.process_identity")

        with mock.patch("subprocess.Popen", return_value=mock.sentinel.process) as popen:
            process = self.bridge._default_spawn(["o2b", "mcp"])

        self.assertIs(process, mock.sentinel.process)
        self.assertEqual(popen.call_args.args[0], ["o2b", "mcp"])


class SpawnOwnedProbeTests(unittest.TestCase):
    def test_probe_returns_none_without_the_host_module(self) -> None:
        names = ("hermes_cli", "hermes_cli.process_identity")
        saved = {name: sys.modules.get(name) for name in names}
        for name in names:
            sys.modules[name] = None  # blocks a real install too
        try:
            self.assertIsNone(bridge_mod._hermes_spawn_owned())
        finally:
            for name, module in saved.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module

    def test_probe_returns_the_host_callable(self) -> None:
        package = types.ModuleType("hermes_cli")
        package.__path__ = []
        identity = types.ModuleType("hermes_cli.process_identity")
        setattr(identity, "spawn_owned", lambda *a, **k: None)
        sys.modules["hermes_cli"] = package
        sys.modules["hermes_cli.process_identity"] = identity
        try:
            self.assertIs(bridge_mod._hermes_spawn_owned(), identity.spawn_owned)
        finally:
            sys.modules.pop("hermes_cli", None)
            sys.modules.pop("hermes_cli.process_identity", None)



class _FakeProc:
    """A child that reports clean exit, so stop() reaches its release path."""

    def __init__(self, pid: int = 4242) -> None:
        self.pid = pid
        self.terminated = False
        self.stdin = None
        self.stdout = None
        self.stderr = None

    def poll(self):
        return None

    def terminate(self) -> None:
        self.terminated = True

    def wait(self, timeout=None):
        return 0

    def kill(self) -> None:  # pragma: no cover - terminate/wait succeed first
        pass


class OwnedChildReleaseTests(unittest.TestCase):
    """A supervised child's process group is handed back when the bridge stops."""

    def setUp(self) -> None:
        self.proc = _FakeProc()
        self.released = []
        package = types.ModuleType("hermes_cli")
        package.__path__ = []
        identity = types.ModuleType("hermes_cli.process_identity")
        setattr(identity, "spawn_owned", lambda argv, *, purpose, **kw: self.proc)

        def release(pid, *, proc=None):
            self.released.append((pid, proc))

        setattr(identity, "release_process_group_once_empty", release)
        setattr(package, "process_identity", identity)
        sys.modules["hermes_cli"] = package
        sys.modules["hermes_cli.process_identity"] = identity
        self.bridge = McpBrainBridge(vault=None)

    def tearDown(self) -> None:
        sys.modules.pop("hermes_cli", None)
        sys.modules.pop("hermes_cli.process_identity", None)

    def test_stop_releases_the_supervised_group_once(self) -> None:
        self.bridge._proc = self.bridge._default_spawn(["o2b", "mcp"])
        self.assertTrue(self.bridge._spawned_owned)
        self.bridge.stop()
        self.assertEqual(self.released, [(self.proc.pid, self.proc)])
        self.assertFalse(self.bridge._spawned_owned)

    def test_stop_without_a_supervised_child_releases_nothing(self) -> None:
        self.bridge._proc = _FakeProc()
        self.bridge.stop()
        self.assertEqual(self.released, [])


if __name__ == "__main__":
    unittest.main()
