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
- vault:        ``VAULT_DIR`` env -> project pointer walk-up -> active named
                profile -> ``vault`` field -> ``None``, every result tilde-expanded
- agent name:   ``VAULT_AGENT_NAME`` env -> ``agent_name``/``agentName`` -> ``"agent"``
- timezone:     ``VAULT_TIMEZONE`` env -> ``timezone`` field -> ``None``

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
- Windows has no mirror at all here. ``resolve_default_config_path`` in
  TypeScript refuses unsupported platforms with a named error; this module is
  only ever loaded by the Hermes gateway, which is POSIX, so it keeps the
  POSIX-only layout without the refusal.

The parse itself is a mirror of ``parseSimpleYaml``: flat ``key: value`` lines,
each line trimmed BEFORE the key is taken (so an indented key is still a key),
surrounding single or double quotes stripped literally with no escape
processing, and the LAST occurrence of a duplicate key winning.
"""

from __future__ import annotations

import json
import logging
import os
import re
import stat
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
    if value.startswith("~/"):
        rest = value[2:]
        return home if rest == "" else os.path.join(home, rest)
    return value


def config_path() -> Path:
    """Resolve the plugin config path (``OPEN_SECOND_BRAIN_CONFIG`` -> XDG -> ~)."""
    override = os.environ.get(CONFIG_PATH_ENV)
    if override:
        return Path(expand_tilde(override))
    xdg = os.environ.get(XDG_CONFIG_HOME_ENV)
    if xdg:
        return Path(expand_tilde(xdg)) / PLUGIN_NAME / CONFIG_FILENAME
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
    env_value = os.environ.get(AGENT_NAME_ENV)
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
    env_value = os.environ.get(VAULT_DIR_ENV)
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
    env_value = os.environ.get(TIMEZONE_ENV)
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
    if env_key and os.environ.get(env_key):
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
