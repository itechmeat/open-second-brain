import multiprocessing
import tempfile
import unittest
from pathlib import Path

from open_second_brain.event_log import append_event, redact_text


def append_concurrent_event(vault_dir: str, index: int) -> None:
    append_event(
        Path(vault_dir),
        "worker",
        f"entry {index}",
        date="2026.05.06",
        time=f"10:{index:02d}",
    )


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

    def test_append_event_rejects_invalid_explicit_times(self):
        with tempfile.TemporaryDirectory() as tmp:
            for invalid_time in ("9:00", "25:00", "bad"):
                with self.subTest(invalid_time=invalid_time):
                    with self.assertRaises(ValueError):
                        append_event(Path(tmp), "agent", "message", date="2026.05.06", time=invalid_time)

    def test_concurrent_process_appends_keep_all_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            processes = [multiprocessing.Process(target=append_concurrent_event, args=(tmp, index)) for index in range(12)]
            for process in processes:
                process.start()
            for process in processes:
                process.join(10)
                self.assertEqual(process.exitcode, 0)

            content = (Path(tmp) / "Daily" / "2026.05.06.md").read_text(encoding="utf-8")
            for index in range(12):
                self.assertIn(f"- 10:{index:02d} — @worker — entry {index}", content)
            self.assertEqual(content.count("@worker — entry"), 12)

    def test_redact_text_removes_secret_like_assignments(self):
        self.assertEqual(redact_text("api_key=abc token: xyz password = qwerty"), "api_key=[REDACTED] token: [REDACTED] password = [REDACTED]")


if __name__ == "__main__":
    unittest.main()
