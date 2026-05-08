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
