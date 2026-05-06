import tempfile
import unittest
from pathlib import Path

from open_second_brain.event_log import append_event, redact_text


class EventLogTests(unittest.TestCase):
    def test_append_event_creates_daily_note_with_raw_events_section(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = append_event(
                vault_dir=Path(tmp),
                agent="test-agent",
                message="created project skeleton",
                date="2026.05.06",
                time="09:30",
            )
            self.assertEqual(path, Path(tmp) / "Daily" / "2026.05.06.md")
            self.assertEqual(
                path.read_text(encoding="utf-8"),
                "---\nformatted: false\n---\n\n# 2026.05.06\n\n## Raw events\n\n- 09:30 — @test-agent — created project skeleton\n",
            )

    def test_append_event_preserves_manual_content_above_raw_events(self):
        with tempfile.TemporaryDirectory() as tmp:
            daily = Path(tmp) / "Daily" / "2026.05.06.md"
            daily.parent.mkdir(parents=True)
            daily.write_text("# 2026.05.06\n\nManual note.\n\n## Raw events\n\n- 08:00 — @old — old entry\n", encoding="utf-8")
            append_event(Path(tmp), "new", "new entry", date="2026.05.06", time="09:00")
            self.assertEqual(
                daily.read_text(encoding="utf-8"),
                "# 2026.05.06\n\nManual note.\n\n## Raw events\n\n- 08:00 — @old — old entry\n- 09:00 — @new — new entry\n",
            )

    def test_append_event_inserts_entries_chronologically(self):
        with tempfile.TemporaryDirectory() as tmp:
            append_event(Path(tmp), "agent", "later", date="2026.05.06", time="11:00")
            append_event(Path(tmp), "agent", "earlier", date="2026.05.06", time="09:00")
            content = (Path(tmp) / "Daily" / "2026.05.06.md").read_text(encoding="utf-8")
            self.assertLess(content.index("09:00"), content.index("11:00"))

    def test_redact_text_removes_secret_like_assignments(self):
        self.assertEqual(redact_text("api_key=abc token: xyz password = qwerty"), "api_key=[REDACTED] token: [REDACTED] password = [REDACTED]")


if __name__ == "__main__":
    unittest.main()
