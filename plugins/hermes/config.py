"""Shared configuration and identity-reminder helpers for the Hermes plugin.

These helpers read the same plugin config the TypeScript core writes
(``~/.config/open-second-brain/config.yaml``) without a YAML dependency, and
load the per-turn identity-reminder template. They are the single source of
truth for both the native memory provider (``provider.py``) and the legacy
``register``/health surface in ``__init__.py`` so the two never drift.

## The contract this module owes ``src/core/config.ts``

The provider's whole readiness signal is ``resolve_vault() is not None``, so a
resolver that is a TRUNCATED copy of the one ``o2b`` uses does not report a
smaller truth - it reports a false one. An operator on a named profile, on a
project pointer, or with ``vault: ~/vault`` had a vault that every ``o2b``
command resolved and that this plugin called absent, which is the whole of
GitHub #130. The chains below are therefore mirrors, step for step and edge
case for edge case, and ``tests/python/test_resolver_parity.py`` drives one
fixture table through BOTH implementations rather than asserting each side's
behaviour separately.

- config path:  ``OPEN_SECOND_BRAIN_CONFIG`` -> ``XDG_CONFIG_HOME`` -> ``~/.config``
                (``XDG_CONFIG_HOME`` and ``LOCALAPPDATA`` through
                :func:`scope_first_setting`)
- vault:        ``VAULT_DIR`` env -> project pointer walk-up -> active named
                profile -> ``vault`` field -> ``None``, every result tilde-expanded
- agent name:   ``VAULT_AGENT_NAME`` env -> ``agent_name``/``agentName`` -> ``"agent"``
- timezone:     ``VAULT_TIMEZONE`` env -> ``timezone`` field -> ``None``

## Two modes: a multiplexed Hermes gateway

"env" above means :func:`env_setting`, the one reader of the names in
:data:`PROFILE_SCOPED_ENV`. A Hermes gateway with ``multiplex_profiles`` serves
several profiles from one process, and that process's environment belongs to
the profile that launched it. So when Hermes reports multiplexing, a scoped
name is read from the profile scope Hermes bound for the call (the profile's
``.env`` and secret sources) and NEVER from ``os.environ``; an unset scoped
value falls through to the rest of the chain (pointer, profile, config key,
default), and a call with no scope bound refuses with
:class:`ProfileScopeError`. Without multiplexing - and whenever Hermes or its
``agent.secret_scope`` module is absent, which is how the parity suite and the
doctor load this file - the reader is the plain ``os.environ`` lookup, so every
answer is unchanged. A scope module that is present but fails to import is
treated as multiplexed with no scope bound, never as absent.

## Where the mirror is deliberately imperfect

Three differences remain, named here rather than left as a false claim:

- ``resolve_timezone`` does NOT validate the IANA name. TypeScript rejects an
  unknown zone through ``Intl.DateTimeFormat``, whose data ships with the
  runtime; the Python equivalent (``zoneinfo``) depends on a system tzdata that
  a minimal container may not have, so validating here would make the two
  disagree on exactly the installs where the check matters least. The value is
  passed through and the TypeScript core validates it at use.
- ``expand_tilde`` does not normalise the joined path. Node's ``path.join``
  collapses redundant separators, so a config value like ``~/a//b`` yields a
  byte-different (though equivalent) path on the two sides. Canonical values -
  everything ``o2b`` and the wizard write - are unaffected.
- The platform default mirrors ``src/core/platform-dirs.ts``:
  ``%LOCALAPPDATA%\\open-second-brain\\config.yaml`` on native Windows (Hermes
  Agent runs there natively), ``~/.config/open-second-brain/config.yaml``
  everywhere else. ``XDG_CONFIG_HOME`` wins on both.

The parse itself is a mirror of ``parseSimpleYaml``: flat ``key: value`` lines,
each line trimmed BEFORE the key is taken (so an indented key is still a key),
surrounding single or double quotes stripped literally with no escape
processing, and the LAST occurrence of a duplicate key winning.
"""

from __future__ import annotations

import importlib
import json
import logging
import os
import re
import stat
import threading
from collections.abc import Mapping
from pathlib import Path

logger = logging.getLogger(__name__)

PLUGIN_NAME = "open-second-brain"
DEFAULT_AGENT = "agent"

#: Config file name, and the registry files that sit beside it.
CONFIG_FILENAME = "config.yaml"
PROFILES_FILENAME = "profiles.json"
VAULT_POINTER_FILENAME = ".o2b-vault.json"

#: Environment overrides, in one place so the resolvers and the write-effect
#: verification name the same strings.
VAULT_DIR_ENV = "VAULT_DIR"
AGENT_NAME_ENV = "VAULT_AGENT_NAME"
TIMEZONE_ENV = "VAULT_TIMEZONE"
CONFIG_PATH_ENV = "OPEN_SECOND_BRAIN_CONFIG"
XDG_CONFIG_HOME_ENV = "XDG_CONFIG_HOME"
LOCALAPPDATA_ENV = "LOCALAPPDATA"
#: Per-request deadline of the MCP bridge, read by ``bridge.py``.
REQUEST_TIMEOUT_ENV = "OPEN_SECOND_BRAIN_MCP_TIMEOUT"

#: The settings that belong to a Hermes profile rather than to the process.
#: On a multiplexed gateway these come from the bound profile scope only.
#: ``PATH``, ``PATHEXT`` and ``HOME`` describe the operating system and stay
#: process-global in both modes: Hermes keeps them out of a profile scope.
PROFILE_SCOPED_ENV: tuple[str, ...] = (
    VAULT_DIR_ENV,
    AGENT_NAME_ENV,
    TIMEZONE_ENV,
    CONFIG_PATH_ENV,
    REQUEST_TIMEOUT_ENV,
)

#: The config directories, which are scope-first on a multiplexed gateway.
#: Hermes scopes them like any other ``.env`` name, so a profile's value lives
#: in its scope and only the launch profile's value is in ``os.environ``;
#: reading ``os.environ`` alone would hand every profile the launch profile's
#: config file. Unlike :data:`PROFILE_SCOPED_ENV`, a name the scope leaves
#: unset falls back to the process environment, because on most installs it
#: is the operating system's own value and no profile sets it.
SCOPE_FIRST_ENV: tuple[str, ...] = (XDG_CONFIG_HOME_ENV, LOCALAPPDATA_ENV)

#: Characters a config value may not contain, mirroring
#: ``CONFIG_VALUE_REJECTED_CHARS`` in ``src/core/config.ts``. The reader strips
#: quotes literally and performs no unescaping, so a value carrying any of
#: these round-trips to something else - which is how a Windows path written by
#: this plugin became a different path when ``o2b`` read it back.
CONFIG_VALUE_REJECTED_CHARS: tuple[str, ...] = ('"', "\\", "\n", "\r")

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TEMPLATES_DIR = _REPO_ROOT / "templates"
_COMMON_TEMPLATE_PATH = _TEMPLATES_DIR / "identity-reminder.txt"
# This package runs inside Hermes, so the reminder target is fixed at the call
# site (mirrors the TypeScript behaviour where each runtime passes its own
# target literal). The Python side collapses to hermes -> common.
_TARGET = "hermes"
_TARGET_TEMPLATE_PATH = _TEMPLATES_DIR / f"identity-reminder.{_TARGET}.txt"

_template_cache: str | None = None

# Scoped names already reported as ignored in this process, plus the scope
# module's own name once its import failure is reported. One WARNING per name,
# not per call: the resolvers run on every turn.
_scope_warned: set[str] = set()
_scope_warned_lock = threading.Lock()

# Line splitter matching the TypeScript `text.split(/\r?\n/)`. `str.splitlines`
# also breaks on form feed, U+2028 and friends, which would make the two
# parsers disagree about how many lines a file has.
_LINE_SPLIT_RE = re.compile(r"\r?\n")


class ConfigReadError(Exception):
    """The config file is PRESENT but its contents cannot be obtained.

    Mirrors ``ConfigReadError`` in ``src/core/config.ts``, including its
    remediation wording, because the two errors describe the same condition on
    the same file and an operator who hits it from one side must be told the
    same thing.

    Absent means "no operator settings, defaults apply". Present-but-unreadable
    - a directory in the file's place, an untraversable parent, a symlink loop,
    a permissions fault, bytes that are not UTF-8 - means the operator's
    settings exist and are NOT the ones in force. Collapsing the second into
    the first is what made a ``chmod``-ed config indistinguishable from a
    plugin that had never been set up.
    """

    def __init__(self, path: str, reason: str) -> None:
        super().__init__(
            f"failed to read plugin config {path}: {reason}. The file is present, so its "
            "settings are NOT in force and are not read as absent; make it readable "
            f'(chmod u+r "{path}") or set {CONFIG_PATH_ENV} to a readable config file.'
        )
        self.path = path
        self.reason = reason


class ProfileScopeError(ConfigReadError):
    """A profile-scoped setting was read on a multiplexed gateway with no scope.

    A subclass of :class:`ConfigReadError` so every site that already refuses,
    propagates or reports an unreadable configuration does the same here: the
    setting the operator configured exists, and it is not the one this call
    can see. The message names the setting and never a value; it does not use
    the parent's file-read template, which is pinned to the file case.
    """

    def __init__(self, name: str) -> None:
        Exception.__init__(
            self,
            f"{name} cannot be resolved: this multiplexed Hermes gateway bound no "
            "profile scope for the call, and Open Second Brain does not fall back to "
            "the gateway's process environment, which belongs to the launch profile. "
            "Restart the gateway (hermes gateway restart); if it persists, report it.",
        )
        self.name = name
        self.path = ""
        self.reason = "no profile scope bound"


#: Hermes's profile-scope module, and the module names whose absence means
#: "not running inside a Hermes that scopes settings".
_SCOPE_MODULE_NAME = "agent.secret_scope"
_ABSENT_SCOPE_MODULE_NAMES = frozenset({"agent", _SCOPE_MODULE_NAME})


#: Set once the scope module failed to import for a reason other than its
#: absence, so later reads fail closed without importing it again (a present
#: module that fails would otherwise rerun its top-level code on every read).
#: Absent and present modules are still looked up per call.
_scope_module_failed = False


class _UnusableProfileScope:
    """Stands in for a Hermes scope module that is present but failed to import.

    It answers "multiplexed, no scope bound", so every profile-scoped read
    refuses with :class:`ProfileScopeError` instead of serving the launch
    profile's process environment to every profile.
    """

    class UnscopedSecretError(Exception):
        """The scope module could not be imported, so no scope is bound."""

    @staticmethod
    def is_multiplex_active() -> bool:
        return True

    @classmethod
    def get_secret(cls, name: str, default: str | None = None) -> str | None:
        raise cls.UnscopedSecretError(name)


def _profile_scope_module():
    """Hermes's ``agent.secret_scope`` module, or ``None`` outside Hermes.

    Imported lazily, absolutely and per call: this file is also loaded by file
    location with no package and no Hermes (the resolver parity suite and the
    doctor's parity check), where the import must fail quietly and leave the
    process-environment answers in force. Only the absence of ``agent`` or of
    ``agent.secret_scope`` counts as "outside Hermes"; any other import failure
    is a Hermes whose scoping is broken, which fails closed: one WARNING naming
    the exception type, then :class:`_UnusableProfileScope`, which later calls
    return without importing the module again.
    """
    global _scope_module_failed
    if _scope_module_failed:
        return _UnusableProfileScope
    try:
        return importlib.import_module(_SCOPE_MODULE_NAME)
    except ModuleNotFoundError as exc:
        if exc.name in _ABSENT_SCOPE_MODULE_NAMES:
            return None
        failure: Exception = exc
    except Exception as exc:  # noqa: BLE001 - any failure of a present module fails closed
        failure = exc
    _scope_module_failed = True
    _warn_scope_module_failed(failure)
    return _UnusableProfileScope


def _warn_scope_module_failed(exc: Exception) -> None:
    """Say once per process that the scope module failed, naming its type only."""
    with _scope_warned_lock:
        if _SCOPE_MODULE_NAME in _scope_warned:
            return
        _scope_warned.add(_SCOPE_MODULE_NAME)
    logger.warning(
        "%s: %s failed to import (%s); profile-scoped settings are refused until it imports",
        PLUGIN_NAME,
        _SCOPE_MODULE_NAME,
        type(exc).__name__,
    )


def is_multiplexed() -> bool:
    """Whether Hermes reports a multiplexed gateway for the current call."""
    scope_module = _profile_scope_module()
    return scope_module is not None and bool(scope_module.is_multiplex_active())


def env_setting(name: str) -> str | None:
    """The one reader of a profile-scoped setting; empty counts as unset.

    Not multiplexed: ``os.environ``, exactly as before. Multiplexed: the bound
    profile scope only - a miss is ``None`` and the caller's chain continues;
    the process environment is never consulted. Names outside
    :data:`PROFILE_SCOPED_ENV` are process-global and always read from
    ``os.environ``.

    :raises ProfileScopeError: when multiplexed and no scope is bound.
    """
    scope_module = _profile_scope_module() if name in PROFILE_SCOPED_ENV else None
    if scope_module is None or not scope_module.is_multiplex_active():
        return os.environ.get(name) or None
    _warn_ignored_process_value(name)
    try:
        value = scope_module.get_secret(name, None)
    except scope_module.UnscopedSecretError as exc:
        raise ProfileScopeError(name) from exc
    return value or None


def scope_first_setting(name: str) -> str | None:
    """A :data:`SCOPE_FIRST_ENV` name: the bound scope's value, else ``os.environ``.

    Not multiplexed: ``os.environ``, exactly as before, and the scope is never
    read. Multiplexed: the bound profile scope's non-empty value, falling back
    to the process environment when the scope has none.

    :raises ProfileScopeError: when multiplexed and no scope is bound.
    """
    scope_module = _profile_scope_module()
    if scope_module is not None and scope_module.is_multiplex_active():
        try:
            value = scope_module.get_secret(name, None)
        except scope_module.UnscopedSecretError as exc:
            raise ProfileScopeError(name) from exc
        if value:
            return value
    return os.environ.get(name) or None


def _warn_ignored_process_value(name: str) -> None:
    """Say once per process that a gateway-environment value is not used.

    Names the variable and never its value: the value belongs to the launch
    profile and may be a path or an identity the other profiles must not see.
    """
    if not os.environ.get(name):
        return
    with _scope_warned_lock:
        if name in _scope_warned:
            return
        _scope_warned.add(name)
    logger.warning(
        "%s: ignoring %s from the gateway process environment on a multiplexed gateway; "
        "set it in the profile's .env instead",
        PLUGIN_NAME,
        name,
    )


def _reset_scope_warnings_for_tests() -> None:
    """Test-only: forget which ignored names were already reported and a failed import."""
    global _scope_module_failed
    with _scope_warned_lock:
        _scope_warned.clear()
    _scope_module_failed = False


class ConfigValueError(ValueError):
    """A value that cannot survive the round trip through the config format."""

    def __init__(self, key: str, char: str) -> None:
        super().__init__(
            f"config value for {json.dumps(key)} contains a disallowed character "
            f"({json.dumps(char)}); reject rather than silently corrupting on read-back"
        )
        self.key = key
        self.char = char


class ConfigEffectError(Exception):
    """A written config key does not resolve to the value that was written.

    Raised after a write, never instead of one: the file on disk holds what was
    asked for, but something ahead of it in the resolution chain (an
    environment override, a project pointer, an active profile) shadows it, so
    the value the operator just set is not the value in force. Reporting the
    write as successful would leave the wizard, the config file and the running
    provider each telling a different story.
    """

    def __init__(self, key: str, written: str, effective: str | None, shadowed_by: str) -> None:
        super().__init__(
            f"config key {json.dumps(key)} was written as {json.dumps(written)} but "
            f"resolves to {json.dumps(effective)}: {shadowed_by}. The file was written; "
            "clear the shadowing source (or set it to the intended value) so the two agree."
        )
        self.key = key
        self.written = written
        self.effective = effective
        self.shadowed_by = shadowed_by


def expand_tilde(value: str) -> str:
    """Expand a leading ``~``, mirroring ``expandTilde`` in TypeScript.

    Only a bare ``~`` or a leading ``~/`` expand; ``~user`` is left alone (as
    Node does), and no other component is touched.
    """
    home = str(Path.home())
    if value == "~":
        return home
    if value.startswith("~/") or (os.name == "nt" and value.startswith("~\\")):
        rest = value[2:]
        return home if rest == "" else os.path.join(home, rest)
    return value


def _windows_local_app_data() -> Path:
    """``%LOCALAPPDATA%``, or ``~/AppData/Local`` in a stripped environment."""
    local = scope_first_setting(LOCALAPPDATA_ENV)
    return Path(local) if local else Path.home() / "AppData" / "Local"


def config_path() -> Path:
    """Resolve the plugin config path (``OPEN_SECOND_BRAIN_CONFIG`` -> XDG -> platform default)."""
    override = env_setting(CONFIG_PATH_ENV)
    if override:
        return Path(expand_tilde(override))
    xdg = scope_first_setting(XDG_CONFIG_HOME_ENV)
    if xdg:
        return Path(expand_tilde(xdg)) / PLUGIN_NAME / CONFIG_FILENAME
    if os.name == "nt":
        return _windows_local_app_data() / PLUGIN_NAME / CONFIG_FILENAME
    return Path.home() / ".config" / PLUGIN_NAME / CONFIG_FILENAME


def _config_text(path: Path) -> str | None:
    """Decoded config contents, ``None`` when genuinely absent.

    The absent/unreadable split is the point of this function; see
    :class:`ConfigReadError`. Only ``ENOENT`` (and the ``ENOTDIR`` its parent
    walk raises, which is a different errno and therefore a read failure) is an
    absence - every other errno is a failure to read a file that is there.
    """
    try:
        info = path.stat()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ConfigReadError(str(path), str(exc)) from exc
    # Ahead of the read rather than letting it raise EISDIR, because it also
    # covers the paths a read cannot survive: a FIFO here would block forever.
    if not stat.S_ISREG(info.st_mode):
        raise ConfigReadError(str(path), "path exists but is not a regular file") from None
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise ConfigReadError(str(path), f"not valid UTF-8: {exc}") from exc
    except OSError as exc:
        raise ConfigReadError(str(path), str(exc)) from exc


def line_key(raw_line: str) -> str | None:
    """The key a config line defines, or ``None`` when it defines none.

    The single authority on what counts as a key line. The reader uses it to
    build the config mapping and the writer uses it to find the line to
    replace, so a line the reader honours is exactly the line the writer
    rewrites - the two used to answer that question with two different regular
    expressions, one taking the first match and one the last.
    """
    line = raw_line.strip()
    if not line or line.startswith("#"):
        return None
    separator = line.find(":")
    if separator == -1:
        return None
    return line[:separator].strip() or None


def parse_simple_yaml(text: str) -> dict[str, str]:
    """Parse the flat ``key: value`` subset, mirroring ``parseSimpleYaml``.

    Deliberately not a YAML parser: the plugin config is a flat key/value file
    written by the TypeScript core, and the project ships ``dependencies = []``.
    Lines that are not ``key: value`` (comments, blanks, list items) are
    skipped, surrounding quotes are stripped literally with no unescaping, and
    a duplicate key keeps its LAST value.
    """
    data: dict[str, str] = {}
    for raw_line in _LINE_SPLIT_RE.split(text):
        key = line_key(raw_line)
        if key is None:
            continue
        line = raw_line.strip()
        value = line[line.find(":") + 1 :].strip()
        if len(value) >= 2 and (
            (value.startswith('"') and value.endswith('"'))
            or (value.startswith("'") and value.endswith("'"))
        ):
            value = value[1:-1]
        data[key] = value
    return data


def _config_data(path: Path | None = None) -> dict[str, str]:
    """Parsed config contents; empty when the file is absent.

    :raises ConfigReadError: when the file is present but unreadable.
    """
    text = _config_text(path if path is not None else config_path())
    return {} if text is None else parse_simple_yaml(text)


def _pointer_vault_field(path: Path) -> str | None:
    """The ``vault`` field of a pointer file, or ``None`` when unusable.

    Fail-soft by design (mirrors ``probeAt``): a malformed pointer is reported
    by ``o2b brain project status``, not by every command that resolves a vault.
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.debug("ignoring unusable vault pointer %s: %s", path, exc)
        return None
    if not isinstance(raw, dict):
        return None
    vault = raw.get("vault")
    if not isinstance(vault, str) or vault.strip() == "":
        return None
    return vault


def _resolve_pointer_vault(start_dir: str) -> str | None:
    """Nearest project pointer's vault, mirroring ``resolvePointerVault``.

    Walks up to the filesystem root and stops at the FIRST directory holding a
    pointer file - a malformed pointer stops the walk too, rather than letting
    resolution silently fall through to a grandparent's pointer.
    """
    directory = os.path.abspath(start_dir)
    while True:
        candidate = Path(directory) / VAULT_POINTER_FILENAME
        if candidate.exists():
            vault = _pointer_vault_field(candidate)
            # The directory check is on the raw value, before tilde expansion,
            # exactly as the TypeScript does it.
            if vault is None or not os.path.isdir(vault):
                return None
            return vault
        parent = os.path.dirname(directory)
        if parent == directory:
            return None
        directory = parent


def _resolve_active_profile_vault(path: Path) -> str | None:
    """Active named profile's vault, mirroring ``resolveActiveProfileVault``.

    Read-only and never raising: a malformed or unreadable registry is treated
    as empty here (the mutating profile commands are the ones that refuse), and
    the recorded path is returned without checking that it still exists.
    """
    registry = path.parent / PROFILES_FILENAME
    if not registry.exists():
        return None
    try:
        raw = json.loads(registry.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.debug("ignoring malformed profiles registry %s: %s", registry, exc)
        return None
    if not isinstance(raw, dict):
        return None
    active = raw.get("active")
    if not isinstance(active, str):
        return None
    profiles = raw.get("profiles")
    if not isinstance(profiles, dict):
        return None
    entry = profiles.get(active)
    if not isinstance(entry, dict):
        return None
    vault = entry.get("vault")
    return vault if isinstance(vault, str) else None


def resolve_agent_name() -> str:
    """Resolve the agent identity, mirroring ``resolveAgentName`` in TypeScript.

    ``agent_name`` wins over ``agentName`` by KEY PRESENCE, not by position in
    the file: the TypeScript reads a parsed mapping, so a file carrying both
    spellings resolves the snake_case one wherever it sits.

    :raises ConfigReadError: when the config file is present but unreadable.
    """
    env_value = env_setting(AGENT_NAME_ENV)
    if env_value:
        return env_value
    data = _config_data()
    value = data["agent_name"] if "agent_name" in data else data.get("agentName")
    return value or DEFAULT_AGENT


def resolve_vault(cwd: str | None = None) -> str | None:
    """Resolve the vault path, mirroring ``resolveVault`` in TypeScript.

    Order: ``VAULT_DIR`` env, project pointer walk-up from ``cwd``, active named
    profile, ``vault`` config key, ``None``. Every answer is tilde-expanded.

    The config file is read BEFORE the profile registry, matching the
    TypeScript, so an unreadable config refuses even when a profile would have
    answered - the operator is told about the broken file either way.

    :param cwd: directory the pointer walk starts from; the process working
        directory when omitted, which is what the gateway passes implicitly.
    :raises ConfigReadError: when the config file is present but unreadable.
    """
    env_value = env_setting(VAULT_DIR_ENV)
    if env_value:
        return expand_tilde(env_value)
    pointer_vault = _resolve_pointer_vault(cwd if cwd is not None else os.getcwd())
    if pointer_vault is not None:
        return expand_tilde(pointer_vault)
    path = config_path()
    data = _config_data(path)
    profile_vault = _resolve_active_profile_vault(path)
    if profile_vault:
        return expand_tilde(profile_vault)
    configured = data.get("vault")
    if configured:
        return expand_tilde(configured)
    return None


def resolve_timezone() -> str | None:
    """Resolve the configured timezone, or ``None`` when unset.

    Order: ``VAULT_TIMEZONE`` env, ``timezone`` config key, ``None``. Unlike
    the TypeScript this does not reject an invalid IANA name; see the module
    docstring for why.

    :raises ConfigReadError: when the config file is present but unreadable.
    """
    env_value = env_setting(TIMEZONE_ENV)
    if env_value:
        return env_value
    return _config_data().get("timezone") or None


def _assert_writable_value(key: str, value: str) -> None:
    for char in CONFIG_VALUE_REJECTED_CHARS:
        if char in value:
            raise ConfigValueError(key, char)


def set_config_values(values: Mapping[str, str | None], path: Path | None = None) -> Path:
    """Write ``key: value`` pairs into the config file, preserving the rest.

    A ``None`` or empty value UNSETS the key: every line defining it is dropped
    so resolution falls through to whatever is behind it. Skipping falsy values
    instead - which this used to do - made a field the operator cleared in the
    wizard silently keep its old value.

    A non-empty value replaces the LAST line defining the key (the one
    :func:`parse_simple_yaml` honours) and drops the earlier duplicates, so
    reading the file back cannot yield a different value than was written.

    Unlike the TypeScript ``setConfigValue``, which rebuilds the whole file
    from the parsed mapping, this edits lines in place: comments and unknown
    blocks in a hand-maintained config survive a wizard run. Both refuse the
    same characters for the same reason - the reader unescapes nothing.

    :raises ConfigReadError: when the existing file is present but unreadable,
        so a write never clobbers content that could not be read.
    :raises ConfigValueError: when a value cannot survive the round trip.
    """
    target = path if path is not None else config_path()
    text = _config_text(target)
    lines = _LINE_SPLIT_RE.split(text) if text is not None else []
    # A trailing newline yields a final empty element; drop it so appended keys
    # do not accumulate blank lines across runs.
    if lines and lines[-1] == "":
        lines.pop()

    for key, value in values.items():
        matches = [i for i, line in enumerate(lines) if line_key(line) == key]
        if not value:
            for index in reversed(matches):
                del lines[index]
            continue
        _assert_writable_value(key, value)
        new_line = f'{key}: "{value}"'
        if matches:
            lines[matches[-1]] = new_line
            for index in reversed(matches[:-1]):
                del lines[index]
        else:
            lines.append(new_line)

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(lines) + "\n" if lines else "", encoding="utf-8")
    return target


def shadowing_source(key: str) -> str | None:
    """What resolves ``key`` ahead of the config file right now, if anything.

    Used by :meth:`provider.OpenSecondBrainMemoryProvider.save_config` to name
    the cause when a written value is not the effective one, instead of leaving
    the operator with a value that does not take.
    """
    env_key = {"vault": VAULT_DIR_ENV, "agent_name": AGENT_NAME_ENV, "timezone": TIMEZONE_ENV}.get(
        key
    )
    if env_key and is_multiplexed():
        if env_setting(env_key):
            return f"the {env_key} setting in this Hermes profile's .env overrides the config file"
    elif env_key and os.environ.get(env_key):
        return f"the {env_key} environment variable overrides the config file"
    if key != "vault":
        return None
    if _resolve_pointer_vault(os.getcwd()) is not None:
        return (
            f"a {VAULT_POINTER_FILENAME} project pointer in or above the working "
            "directory overrides the config file"
        )
    if _resolve_active_profile_vault(config_path()):
        return f"an active named profile in {PROFILES_FILENAME} overrides the config file"
    return None


def load_reminder_template() -> str:
    """Read the Hermes reminder template, falling back to the common file.

    Cached after the first call: the template is an installation-time artifact
    that does not change at runtime, and a gateway restart (every plugin
    update) flushes the cache by starting a fresh process.
    """
    global _template_cache
    if _template_cache is not None:
        return _template_cache
    if _TARGET_TEMPLATE_PATH.is_file():
        _template_cache = _TARGET_TEMPLATE_PATH.read_text(encoding="utf-8").rstrip()
    else:
        _template_cache = _COMMON_TEMPLATE_PATH.read_text(encoding="utf-8").rstrip()
    return _template_cache


def _reset_template_cache_for_tests() -> None:
    """Test-only: drop the cached body so a fixture rewrite is visible."""
    global _template_cache
    _template_cache = None


def render_reminder(agent: str) -> str:
    """Substitute every ``{agent}`` placeholder in the reminder template."""
    return load_reminder_template().replace("{agent}", agent)


def build_reminder() -> str | None:
    """Render the identity reminder for the configured agent.

    Returns ``None`` when no identity is configured, so the literal ``@agent``
    placeholder never leaks into a user-facing turn.
    """
    agent = resolve_agent_name()
    if agent == DEFAULT_AGENT:
        return None
    return render_reminder(agent)
