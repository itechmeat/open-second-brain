import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV = {**os.environ, "PYTHONPATH": str(ROOT / "src")}

sys.path.insert(0, str(ROOT / "src"))

from open_second_brain.mcp import (  # noqa: E402
    JSONRPC_VERSION,
    MCPServer,
    PROTOCOL_VERSION,
    SERVER_NAME,
    SERVER_VERSION,
    serve_stdio,
    slugify,
)
from tests.fixtures import create_plugin_repo, create_sandbox_vault  # noqa: E402


def _make_server(vault: Path, *, config: Path | None = None, repo: Path | None = None) -> MCPServer:
    return MCPServer(vault=vault, config_path=config, repo_root=repo)


def _initialize(server: MCPServer) -> dict:
    response = server.handle_request(
        {
            "jsonrpc": JSONRPC_VERSION,
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "test-client", "version": "0"},
            },
        }
    )
    assert server.handle_request(
        {"jsonrpc": JSONRPC_VERSION, "method": "notifications/initialized"}
    ) is None
    return response


def _call_tool(server: MCPServer, name: str, arguments: dict | None = None, request_id: int = 99) -> dict:
    return server.handle_request(
        {
            "jsonrpc": JSONRPC_VERSION,
            "id": request_id,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments or {}},
        }
    )


class SlugifyTests(unittest.TestCase):
    def test_slugify_lowercases_and_replaces_punctuation(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")

    def test_slugify_handles_unicode_and_empty(self):
        self.assertEqual(slugify("   "), "note")
        self.assertEqual(slugify("---"), "note")
        self.assertEqual(slugify("Кейс / Тест"), "note")

    def test_slugify_truncates_long_input(self):
        long = "a" * 200
        self.assertEqual(len(slugify(long)), 64)


class HandshakeTests(unittest.TestCase):
    def test_initialize_returns_server_info_and_tools_capability(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = _make_server(Path(tmp))
            response = _initialize(server)
            self.assertEqual(response["jsonrpc"], JSONRPC_VERSION)
            self.assertEqual(response["id"], 1)
            result = response["result"]
            self.assertEqual(result["serverInfo"]["name"], SERVER_NAME)
            self.assertEqual(result["serverInfo"]["version"], SERVER_VERSION)
            self.assertIn("tools", result["capabilities"])
            self.assertEqual(result["protocolVersion"], PROTOCOL_VERSION)

    def test_initialize_instructions_embed_resolved_agent_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            vault.mkdir()
            config = Path(tmp) / "config.yaml"
            config.write_text("agent_name: hermes-vps-agent\n", encoding="utf-8")
            prior_env = os.environ.pop("VAULT_AGENT_NAME", None)
            try:
                server = _make_server(vault, config=config)
                response = _initialize(server)
            finally:
                if prior_env is not None:
                    os.environ["VAULT_AGENT_NAME"] = prior_env
            instructions = response["result"]["instructions"]
            self.assertIn("@hermes-vps-agent", instructions)
            self.assertIn("event_log_append", instructions)
            self.assertIn("DO NOT", instructions)

    def test_initialize_negotiates_alternate_client_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = _make_server(Path(tmp))
            response = server.handle_request(
                {
                    "jsonrpc": JSONRPC_VERSION,
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {"name": "old", "version": "0"},
                    },
                }
            )
            self.assertEqual(response["result"]["protocolVersion"], "2024-11-05")

    def test_initialized_notification_is_silent(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = _make_server(Path(tmp))
            self.assertIsNone(
                server.handle_request(
                    {"jsonrpc": JSONRPC_VERSION, "method": "notifications/initialized"}
                )
            )

    def test_unknown_method_returns_method_not_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = _make_server(Path(tmp))
            response = server.handle_request(
                {"jsonrpc": JSONRPC_VERSION, "id": 7, "method": "does/not/exist"}
            )
            self.assertEqual(response["error"]["code"], -32601)


class ToolListingTests(unittest.TestCase):
    def test_tools_list_advertises_all_roadmap_tools(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = _make_server(Path(tmp))
            _initialize(server)
            response = server.handle_request(
                {"jsonrpc": JSONRPC_VERSION, "id": 2, "method": "tools/list"}
            )
            names = {tool["name"] for tool in response["result"]["tools"]}
            self.assertEqual(
                names,
                {
                    "second_brain_status",
                    "second_brain_query",
                    "second_brain_capture",
                    "event_log_append",
                    "vault_health",
                },
            )
            for tool in response["result"]["tools"]:
                self.assertIn("inputSchema", tool)
                self.assertEqual(tool["inputSchema"]["type"], "object")


class ToolCallTests(unittest.TestCase):
    def test_second_brain_status_reports_vault_and_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            vault.mkdir()
            config = Path(tmp) / "config.yaml"
            config.write_text("vault_path: /tmp/vault\napi_key: secret\n", encoding="utf-8")
            server = _make_server(vault, config=config)
            _initialize(server)

            response = _call_tool(server, "second_brain_status")
            structured = response["result"]["structuredContent"]
            self.assertEqual(structured["vault_path"], str(vault))
            self.assertTrue(structured["vault_exists"])
            self.assertEqual(structured["config"]["api_key"], "[REDACTED]")
            self.assertIn("vault_path", structured["config_keys"])

    def test_second_brain_query_filters_and_limits(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = create_sandbox_vault(Path(tmp))
            server = _make_server(vault)
            _initialize(server)

            response = _call_tool(
                server,
                "second_brain_query",
                {"pattern": "Sandbox", "limit": 5},
            )
            structured = response["result"]["structuredContent"]
            self.assertEqual(structured["limit"], 5)
            self.assertGreaterEqual(structured["total_pages"], 1)
            self.assertTrue(any("Sandbox" in p["title"] for p in structured["pages"]))

    def test_second_brain_capture_writes_note_with_frontmatter(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            vault.mkdir()
            server = _make_server(vault)
            _initialize(server)

            response = _call_tool(
                server,
                "second_brain_capture",
                {
                    "title": "Hello World",
                    "content": "# Body\n\ntext",
                    "tags": ["draft", "demo"],
                },
            )
            structured = response["result"]["structuredContent"]
            note = vault / "AI Wiki" / "notes" / "hello-world.md"
            self.assertTrue(note.is_file())
            text = note.read_text(encoding="utf-8")
            self.assertIn("title: Hello World", text)
            self.assertIn("tags: [draft, demo]", text)
            self.assertIn("# Body", text)
            self.assertEqual(structured["slug"], "hello-world")

    def test_second_brain_capture_rejects_existing_note_without_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            vault.mkdir()
            server = _make_server(vault)
            _initialize(server)

            args = {"title": "Same Title", "content": "first"}
            response = _call_tool(server, "second_brain_capture", args)
            self.assertFalse(response["result"]["isError"])

            response = _call_tool(server, "second_brain_capture", args, request_id=100)
            self.assertTrue(response["result"]["isError"])
            self.assertIn("already exists", response["result"]["content"][0]["text"])

    def test_second_brain_capture_rejects_empty_title(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            vault.mkdir()
            server = _make_server(vault)
            _initialize(server)

            response = _call_tool(
                server,
                "second_brain_capture",
                {"title": "   ", "content": "body"},
            )
            self.assertEqual(response["error"]["code"], -32602)

    def test_event_log_append_writes_daily_note(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            server = _make_server(vault)
            _initialize(server)

            response = _call_tool(
                server,
                "event_log_append",
                {
                    "message": "via mcp",
                    "agent": "mcp-test",
                    "date": "2026.05.06",
                    "time": "11:42",
                },
            )
            self.assertFalse(response["result"]["isError"])
            structured = response["result"]["structuredContent"]
            self.assertEqual(structured["agent"], "mcp-test")
            daily = vault / "Daily" / "2026.05.06.md"
            self.assertIn("- 11:42 — @mcp-test — via mcp", daily.read_text(encoding="utf-8"))

    def test_event_log_append_strips_leading_at_in_agent(self):
        # LLMs frequently echo the @-prefixed identity from the prompt back as
        # the `agent` argument. The server must strip the leading @ so the
        # final entry doesn't double up to `@@name`.
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            vault.mkdir()
            server = _make_server(vault)
            _initialize(server)

            response = _call_tool(
                server,
                "event_log_append",
                {
                    "message": "with-at-prefix",
                    "agent": "@hermes-vps-agent",
                    "date": "2026.05.06",
                    "time": "11:55",
                },
            )
            self.assertFalse(response["result"]["isError"])
            structured = response["result"]["structuredContent"]
            self.assertEqual(structured["agent"], "hermes-vps-agent")
            daily = vault / "Daily" / "2026.05.06.md"
            text = daily.read_text(encoding="utf-8")
            self.assertIn("- 11:55 — @hermes-vps-agent — with-at-prefix", text)
            self.assertNotIn("@@", text)

    def test_event_log_append_placeholder_agent_falls_back_to_default(self):
        # When the LLM hallucinates a placeholder/self-name (`agent`,
        # `assistant`, `claude`, ...) into the call, the server must treat it
        # as "no value" and fall back to the resolved default identity instead
        # of writing the guess verbatim into Daily.
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            vault.mkdir()
            config = Path(tmp) / "config.yaml"
            config.write_text("agent_name: hermes-vps-agent\n", encoding="utf-8")
            server = _make_server(vault, config=config)
            _initialize(server)

            prior_env = os.environ.pop("VAULT_AGENT_NAME", None)
            try:
                cases = (
                    "agent", "@agent", "AGENT", "  @agent  ",
                    "assistant", "@assistant", "Assistant",
                    "claude", "GPT", "gpt-5", "ai", "Bot", "model",
                )
                for trash in cases:
                    response = _call_tool(
                        server,
                        "event_log_append",
                        {
                            "message": f"trash:{trash}",
                            "agent": trash,
                            "date": "2026.05.06",
                            "time": "12:30",
                        },
                    )
                    self.assertFalse(response["result"]["isError"])
                    self.assertEqual(
                        response["result"]["structuredContent"]["agent"],
                        "hermes-vps-agent",
                        msg=f"placeholder {trash!r} should fall back to default",
                    )
            finally:
                if prior_env is not None:
                    os.environ["VAULT_AGENT_NAME"] = prior_env

    def test_event_log_append_empty_optional_strings_treated_as_missing(self):
        # LLMs in tool-use mode often pass empty strings for optional fields
        # they want to skip (e.g. `time=""`, `date=""`) instead of omitting
        # them. The server must treat empty-string optional args the same as
        # omitted, not pass `""` through to validators.
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            vault.mkdir()
            server = _make_server(vault)
            _initialize(server)

            response = _call_tool(
                server,
                "event_log_append",
                {
                    "message": "with-empty-optionals",
                    "agent": "",
                    "date": "",
                    "time": "",
                },
            )
            self.assertFalse(
                response["result"]["isError"],
                msg=f"empty optional strings should not error: {response}",
            )
            structured = response["result"]["structuredContent"]
            # date/time were empty → server filled in current values, not ""
            self.assertIsNone(structured["date"])
            self.assertIsNone(structured["time"])

    def test_event_log_append_uses_configured_timezone(self):
        # The plugin config stores an IANA timezone alongside agent_name. When
        # set, event_log_append must stamp Daily entries in that timezone, so
        # that user-local clock time appears regardless of where the host is.
        # Cross-checked with `datetime.now(ZoneInfo(...))` to avoid asserting
        # against a wall-clock value that flips between test runs around the
        # minute boundary.
        from datetime import datetime
        from zoneinfo import ZoneInfo

        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            vault.mkdir()
            config = Path(tmp) / "config.yaml"
            config.write_text(
                'agent_name: "hermes-vps-agent"\ntimezone: "Europe/Belgrade"\n',
                encoding="utf-8",
            )
            server = _make_server(vault, config=config)
            _initialize(server)

            prior = {k: os.environ.pop(k, None) for k in ("VAULT_AGENT_NAME", "VAULT_TIMEZONE")}
            try:
                # Capture the local-tz wall clock immediately *before* the
                # tool runs, so the assertion's expected date/hour are
                # derived from an instant strictly earlier than the one
                # the tool stamps. Capturing it after introduces a
                # midnight-rollover race (tool stamps day N, assertion
                # computes day N+1, mismatched filename).
                expected_at_call = datetime.now(ZoneInfo("Europe/Belgrade"))
                response = _call_tool(
                    server,
                    "event_log_append",
                    {"message": "tz-test"},
                )
            finally:
                for k, v in prior.items():
                    if v is not None:
                        os.environ[k] = v

            self.assertFalse(response["result"]["isError"], response)
            expected_file = vault / "Daily" / f"{expected_at_call.strftime('%Y.%m.%d')}.md"
            self.assertTrue(expected_file.is_file(), f"missing: {expected_file}")
            text = expected_file.read_text(encoding="utf-8")
            self.assertIn(f"— @hermes-vps-agent — tz-test", text)
            self.assertIn(f"- {expected_at_call.strftime('%H')}", text)

    def test_event_log_append_uses_vault_timezone_env(self):
        # Env var takes precedence over config. Useful for runtime overrides
        # (Hermes mcp_servers env block) without touching the plugin config.
        from datetime import datetime
        from zoneinfo import ZoneInfo

        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            vault.mkdir()
            config = Path(tmp) / "config.yaml"
            # Config says one zone; env says another — env must win.
            config.write_text('timezone: "UTC"\n', encoding="utf-8")
            server = _make_server(vault, config=config)
            _initialize(server)

            prior = os.environ.get("VAULT_TIMEZONE")
            os.environ["VAULT_TIMEZONE"] = "Europe/Belgrade"
            try:
                # Capture before the tool call so a midnight rollover
                # between the call and the assertion can't mismatch
                # the expected filename.
                expected_at_call = datetime.now(ZoneInfo("Europe/Belgrade"))
                response = _call_tool(
                    server,
                    "event_log_append",
                    {"message": "env-tz-test", "agent": "tester"},
                )
            finally:
                if prior is None:
                    os.environ.pop("VAULT_TIMEZONE", None)
                else:
                    os.environ["VAULT_TIMEZONE"] = prior

            self.assertFalse(response["result"]["isError"], response)
            expected_file = vault / "Daily" / f"{expected_at_call.strftime('%Y.%m.%d')}.md"
            self.assertTrue(expected_file.is_file())

    def test_event_log_append_invalid_config_timezone_falls_back_silently(self):
        # A typo in the config timezone must NOT break logging — we silently
        # fall back to system-local time. The entry still lands; only its
        # stamp is in server time instead of user-intended time.
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            vault.mkdir()
            config = Path(tmp) / "config.yaml"
            config.write_text('timezone: "Not/A/Real/Zone"\n', encoding="utf-8")
            server = _make_server(vault, config=config)
            _initialize(server)

            prior = os.environ.pop("VAULT_TIMEZONE", None)
            try:
                response = _call_tool(
                    server,
                    "event_log_append",
                    {"message": "fallback", "agent": "tester"},
                )
            finally:
                if prior is not None:
                    os.environ["VAULT_TIMEZONE"] = prior

            self.assertFalse(response["result"]["isError"], response)

    def test_event_log_append_uses_config_agent_name_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            vault.mkdir()
            config = Path(tmp) / "config.yaml"
            config.write_text("agent_name: openclaw-main\n", encoding="utf-8")
            server = _make_server(vault, config=config)
            _initialize(server)

            # Ensure environment variable does not shadow the config default
            prior_env = os.environ.pop("VAULT_AGENT_NAME", None)
            try:
                response = _call_tool(
                    server,
                    "event_log_append",
                    {
                        "message": "from-config-default",
                        "date": "2026.05.06",
                        "time": "12:00",
                    },
                )
            finally:
                if prior_env is not None:
                    os.environ["VAULT_AGENT_NAME"] = prior_env

            self.assertFalse(response["result"]["isError"])
            structured = response["result"]["structuredContent"]
            self.assertEqual(structured["agent"], "openclaw-main")
            daily = vault / "Daily" / "2026.05.06.md"
            self.assertIn(
                "- 12:00 — @openclaw-main — from-config-default",
                daily.read_text(encoding="utf-8"),
            )

    def test_event_log_append_rejects_invalid_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = _make_server(Path(tmp))
            _initialize(server)
            response = _call_tool(
                server,
                "event_log_append",
                {"message": "x", "time": "99:99"},
            )
            self.assertTrue(response["result"]["isError"])
            self.assertIn("HH:MM", response["result"]["content"][0]["text"])

    def test_vault_health_runs_doctor(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = create_sandbox_vault(Path(tmp))
            repo = create_plugin_repo(Path(tmp), valid=True)
            server = _make_server(vault, repo=repo)
            _initialize(server)

            response = _call_tool(server, "vault_health", {})
            structured = response["result"]["structuredContent"]
            self.assertTrue(structured["ok"])
            check_names = {check["name"] for check in structured["checks"]}
            self.assertIn("vault_writeable", check_names)
            self.assertIn("claude_manifest", check_names)
            self.assertIn("hermes_manifest", check_names)

    def test_unknown_tool_returns_method_not_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = _make_server(Path(tmp))
            _initialize(server)
            response = _call_tool(server, "not_a_tool")
            self.assertEqual(response["error"]["code"], -32601)


class StdioLoopTests(unittest.TestCase):
    def test_serve_stdio_processes_initialize_and_tools_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            server = MCPServer(vault=vault)
            payload = "\n".join(
                [
                    json.dumps(
                        {
                            "jsonrpc": JSONRPC_VERSION,
                            "id": 1,
                            "method": "initialize",
                            "params": {
                                "protocolVersion": PROTOCOL_VERSION,
                                "capabilities": {},
                                "clientInfo": {"name": "t", "version": "0"},
                            },
                        }
                    ),
                    json.dumps({"jsonrpc": JSONRPC_VERSION, "method": "notifications/initialized"}),
                    json.dumps({"jsonrpc": JSONRPC_VERSION, "id": 2, "method": "tools/list"}),
                ]
            ) + "\n"
            stdin = io.StringIO(payload)
            stdout = io.StringIO()
            stderr = io.StringIO()
            self.assertEqual(serve_stdio(server, stdin=stdin, stdout=stdout, stderr=stderr), 0)
            lines = [line for line in stdout.getvalue().splitlines() if line]
            self.assertEqual(len(lines), 2)
            init_response = json.loads(lines[0])
            list_response = json.loads(lines[1])
            self.assertEqual(init_response["id"], 1)
            self.assertEqual(list_response["id"], 2)
            self.assertEqual(len(list_response["result"]["tools"]), 5)

    def test_serve_stdio_returns_parse_error_for_invalid_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = MCPServer(vault=Path(tmp))
            stdin = io.StringIO("{not json}\n")
            stdout = io.StringIO()
            self.assertEqual(serve_stdio(server, stdin=stdin, stdout=stdout, stderr=io.StringIO()), 0)
            response = json.loads(stdout.getvalue().splitlines()[0])
            self.assertEqual(response["error"]["code"], -32700)

    def test_serve_stdio_returns_invalid_request_for_batch_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = MCPServer(vault=Path(tmp))
            batch = json.dumps(
                [
                    {"jsonrpc": JSONRPC_VERSION, "id": 1, "method": "ping"},
                    {"jsonrpc": JSONRPC_VERSION, "id": 2, "method": "ping"},
                ]
            )
            stdin = io.StringIO(batch + "\n")
            stdout = io.StringIO()
            self.assertEqual(serve_stdio(server, stdin=stdin, stdout=stdout, stderr=io.StringIO()), 0)
            response = json.loads(stdout.getvalue().splitlines()[0])
            self.assertEqual(response["error"]["code"], -32600)
            self.assertIn("batch", response["error"]["message"].lower())


class CliIntegrationTests(unittest.TestCase):
    def test_o2b_mcp_subcommand_serves_stdio(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            vault.mkdir()
            payload = "\n".join(
                [
                    json.dumps(
                        {
                            "jsonrpc": JSONRPC_VERSION,
                            "id": 1,
                            "method": "initialize",
                            "params": {
                                "protocolVersion": PROTOCOL_VERSION,
                                "capabilities": {},
                                "clientInfo": {"name": "t", "version": "0"},
                            },
                        }
                    ),
                    json.dumps({"jsonrpc": JSONRPC_VERSION, "method": "notifications/initialized"}),
                    json.dumps({"jsonrpc": JSONRPC_VERSION, "id": 2, "method": "tools/list"}),
                ]
            ) + "\n"
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "open_second_brain.cli",
                    "mcp",
                    "--vault",
                    str(vault),
                ],
                cwd=ROOT,
                input=payload,
                env=ENV,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=15,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("listening on stdio", result.stderr)
            lines = [line for line in result.stdout.splitlines() if line]
            self.assertEqual(len(lines), 2)
            tools_response = json.loads(lines[1])
            self.assertEqual(tools_response["id"], 2)
            tool_names = {tool["name"] for tool in tools_response["result"]["tools"]}
            self.assertIn("second_brain_status", tool_names)


if __name__ == "__main__":
    unittest.main()
