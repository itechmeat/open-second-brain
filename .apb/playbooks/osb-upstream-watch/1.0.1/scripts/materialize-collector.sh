set -eu

# Materialize the deterministic collector for the osb-upstream-watch run into the
# run directory. Script nodes receive no params: everything the collector needs
# (table path, state root, filters) is passed on its command line by the agent
# nodes that follow. The collector is the port of the nightly VPS workflow's
# embedded osb-upstream-collect script (stdlib only, gh invoked read-only).

: "${APB_RUN_DIR:?APB_RUN_DIR is required}"
COLLECTOR_DIR="$APB_RUN_DIR/collector"
mkdir -p "$COLLECTOR_DIR"

cat > "$COLLECTOR_DIR/osb-upstream-collect.py" <<'__OSB_COLLECT_PY__'
#!/usr/bin/env python3
"""osb-upstream-collect - deterministic data collector for the osb-upstream-watch playbook.

Offloads the mechanical, token-heavy work (gh release/commit fetching, date filtering,
release-vs-commits mode decision, conventional-commit filtering, Markdown table writeback)
out of the LLM. The model orchestrates (collect -> pending -> done) and does only the
semantic work (feature extraction, evidence gathering, kanban).

Port of the nightly VPS workflow's embedded collector to the devbox run directory:
no personal default paths (--table and --state-root are required), a --repos filter,
an explicit --since window override, a --dry-run mode that writes nothing, and the
read-only `block` / `pending` subcommands that fetch project blocks without touching
state.
Stdlib only. gh is invoked read-only via subprocess.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone, date, timedelta
from pathlib import Path

RELEASE_BODY_MAX = 4000
COMMITS_FALLBACK_DAYS = 60
CANDIDATE_CAP = 10

URL_RE = re.compile(r"https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)")
DATE_RE = re.compile(r"^\d{2}\.\d{2}\.\d{4}$")
FEAT_RE = re.compile(r"^(feat|feature)(\(|:|!)", re.IGNORECASE)
MERGE_FEAT_RE = re.compile(r"^Merge pull request #(\d+) from \S+/feat", re.IGNORECASE)
PR_FEAT_LABELS = {"enhancement", "feature", "feat"}


class RowNotFound(Exception):
    pass


# --------------------------------------------------------------------------- #
# Time (patched in tests)
# --------------------------------------------------------------------------- #
def today_utc():
    return datetime.now(timezone.utc).date()


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- #
# Table parsing (URL-anchored - robust to the table's irregular pipe layout)
# --------------------------------------------------------------------------- #
def _row_from_cells(cells, i, mobj):
    def at(k):
        return cells[i + k] if i + k < len(cells) else ""
    repo = mobj.group(2)
    if repo.endswith(".git"):
        repo = repo[:-4]
    stars_s = at(2)
    state_s = at(3)
    return {
        "owner": mobj.group(1),
        "repo": repo,
        "url": f"https://github.com/{mobj.group(1)}/{repo}",
        "updated": at(1),
        "stars": int(stars_s) if stars_s.isdigit() else 0,
        "state": int(state_s) if state_s.lstrip("-").isdigit() else -1,
        "last_release_tag": at(4),
        "last_error": at(5),
    }


def parse_table(text):
    rows = []
    for line in text.splitlines():
        if "github.com" not in line or "---" in line:
            continue
        cells = [c.strip() for c in line.split("|")]
        for i, c in enumerate(cells):
            mobj = URL_RE.search(c)
            if mobj:
                rows.append(_row_from_cells(cells, i, mobj))
                break
    return rows


def parse_ddmmyyyy(s):
    s = (s or "").strip()
    if not DATE_RE.match(s):
        return None
    try:
        return datetime.strptime(s, "%d.%m.%Y").date()
    except ValueError:
        return None


def is_due(row, today):
    if row.get("state") != 1:
        return False
    d = parse_ddmmyyyy(row.get("updated", ""))
    if d is None:
        return True  # never processed (empty/unparseable) -> due
    return d < today


def iso_since_from_updated(updated):
    d = parse_ddmmyyyy(updated)
    if d is None:
        return "1970-01-01T00:00:00Z"
    return d.strftime("%Y-%m-%dT00:00:00Z")


# --------------------------------------------------------------------------- #
# Table writeback (atomic, anchored on the unique repo URL)
# --------------------------------------------------------------------------- #
def _write_table_atomic(path, text):
    """Write text to a sibling temp file, then os.replace it over `path` so a
    crash mid-write can never leave a truncated table behind."""
    p = Path(path)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, p)


def _set_cell(parts, idx, value):
    if idx >= len(parts):
        return
    old = parts[idx]
    new = " " + value
    if len(new) < len(old):
        new = new + " " * (len(old) - len(new))
    else:
        new = new + " "
    parts[idx] = new


def rewrite_row(text, owner, repo, *, updated=None, last_tag=None, last_error=None):
    lines = text.splitlines(keepends=True)
    target_idx = None
    for li, line in enumerate(lines):
        for c in line.split("|"):
            mobj = URL_RE.search(c)
            if mobj and mobj.group(1) == owner and mobj.group(2).removesuffix(".git") == repo:
                if target_idx is not None:
                    raise RowNotFound(f"ambiguous: multiple rows for {owner}/{repo}")
                target_idx = li
                break
    if target_idx is None:
        raise RowNotFound(f"no row for {owner}/{repo}")

    line = lines[target_idx]
    nl = ""
    if line.endswith("\r\n"):
        line, nl = line[:-2], "\r\n"
    elif line.endswith("\n"):
        line, nl = line[:-1], "\n"
    parts = line.split("|")
    # locate URL cell index in the raw (unstripped) parts
    i = None
    for idx, c in enumerate(parts):
        mobj = URL_RE.search(c)
        if mobj and mobj.group(1) == owner and mobj.group(2).removesuffix(".git") == repo:
            i = idx
            break
    if updated is not None:
        _set_cell(parts, i + 1, updated)
    if last_tag is not None:
        _set_cell(parts, i + 4, last_tag)
    if last_error is not None:
        _set_cell(parts, i + 5, last_error)
    lines[target_idx] = "|".join(parts) + nl
    return "".join(lines)


# --------------------------------------------------------------------------- #
# Release / commit logic
# --------------------------------------------------------------------------- #
def _parse_iso(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def filter_releases(releases, since_iso):
    since = _parse_iso(since_iso)
    out = []
    for r in releases:
        pa = r.get("publishedAt")
        if pa and _parse_iso(pa) > since:
            out.append(r)
    return out


def decide_mode(in_window, all_releases, today, stale_days=COMMITS_FALLBACK_DAYS):
    """releases (in-window release) | activity (no in-window release and the repo is not
    actively releasing -> fall back to merged-PRs/commits) | empty (actively releasing,
    nothing landed in the window)."""
    if in_window:
        return "releases"
    if not all_releases:
        return "activity"
    newest = max((_parse_iso(r["publishedAt"]).date()
                  for r in all_releases if r.get("publishedAt")), default=None)
    if newest is None or (today - newest).days > stale_days:
        return "activity"
    return "empty"


def filter_feature_commits(commits):
    kept = []
    for c in commits:
        msg = (c.get("commit", {}) or {}).get("message", "") or ""
        first = msg.splitlines()[0] if msg else ""
        if FEAT_RE.match(first) or MERGE_FEAT_RE.match(first):
            kept.append(c)
    return kept


def filter_feature_prs(prs):
    """Merged PRs that look feature-bearing: conventional feat/feature title, or a
    feature/enhancement label. Drops fix/chore/docs/refactor/deps and untitled work."""
    kept = []
    for p in prs:
        title = p.get("title") or ""
        labels = {(l.get("name") or "").lower() for l in (p.get("labels") or [])}
        if FEAT_RE.match(title) or (labels & PR_FEAT_LABELS):
            kept.append(p)
    return kept


def cap_candidates(items_oldest_first, cap):
    """Keep the newest `cap` items; return (kept, dropped_count). cap=None disables."""
    if cap is None or len(items_oldest_first) <= cap:
        return items_oldest_first, 0
    return items_oldest_first[-cap:], len(items_oldest_first) - cap


# --------------------------------------------------------------------------- #
# State: snapshot + processed ledger
# --------------------------------------------------------------------------- #
def _state_dir(state_root, day):
    return Path(state_root) / day.isoformat()


def append_processed(path, repo, status, *, last_tag=None, commit=None, error=None, reason=None):
    rec = {"repo": repo, "status": status, "processed_at": _now_iso()}
    if last_tag:
        rec["last_tag"] = last_tag
    if commit:
        rec["commit"] = commit
    if error:
        rec["error"] = error
    if reason:
        rec["reason"] = reason
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def read_processed_repos(path):
    p = Path(path)
    if not p.exists():
        return set()
    repos = set()
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            repos.add(json.loads(line)["repo"])
        except (ValueError, KeyError):
            continue
    return repos


# --------------------------------------------------------------------------- #
# gh layer (run_gh is patched in tests)
# --------------------------------------------------------------------------- #
def run_gh(args, attempts=3):
    delay = 1.0
    last = (1, "", "not run")
    for k in range(attempts):
        try:
            p = subprocess.run(["gh"] + args, capture_output=True, text=True, timeout=120)
        except subprocess.TimeoutExpired as e:
            last = (124, "", f"timeout: {e}")
        else:
            if p.returncode == 0:
                return 0, p.stdout, p.stderr
            last = (p.returncode, p.stdout, p.stderr)
            combined = (p.stdout + p.stderr).lower()
            if "404" in combined or "not found" in combined:
                return last  # not transient - let caller verify
        if k < attempts - 1:
            time.sleep(delay)
            delay *= 2
    return last


def _gh_json(args):
    rc, out, err = run_gh(args)
    if rc != 0:
        return None, (rc, out, err)
    try:
        return json.loads(out or "[]"), None
    except ValueError as e:
        return None, (rc, out, f"json error: {e}")


def gh_release_list(owner, repo):
    return _gh_json(["release", "list", "-R", f"{owner}/{repo}", "--limit", "50",
                     "--json", "tagName,publishedAt,name"])


def gh_release_view(owner, repo, tag):
    rc, out, err = run_gh(["release", "view", tag, "-R", f"{owner}/{repo}"])
    if rc != 0:
        return ""
    body = out or ""
    if len(body) > RELEASE_BODY_MAX:
        body = body[:RELEASE_BODY_MAX] + "\n…(truncated)"
    return body


def gh_api_commits(owner, repo, since):
    # First page only: the cap and drop accounting cover the fetched page (no pagination).
    return _gh_json(["api", "-X", "GET", f"repos/{owner}/{repo}/commits",
                     "-F", f"since={since}", "-F", "per_page=100"])


def gh_repo_exists(owner, repo):
    rc, _, _ = run_gh(["api", f"repos/{owner}/{repo}"])
    return rc == 0


def gh_merged_prs(owner, repo, since_date):
    """Merged PRs with mergedAt on/after since_date (YYYY-MM-DD) - same window as releases."""
    return _gh_json(["pr", "list", "-R", f"{owner}/{repo}", "--state", "merged",
                     "--search", f"merged:>={since_date}", "--limit", "100",
                     "--json", "number,title,labels,mergedAt,url,mergeCommit"])


# --------------------------------------------------------------------------- #
# Collection of one project
# --------------------------------------------------------------------------- #
def collect_one(row, today, since_override=None, cap=CANDIDATE_CAP, stale_days=COMMITS_FALLBACK_DAYS):
    """Return (block_or_None, mode) where mode in releases|prs|commits|empty|error.

    The SAME `since` lower bound drives releases (publishedAt), merged PRs (mergedAt), and
    commits - there is no separate date logic per source.

    since_override (ISO) forces a uniform lower bound for every project; when set, the
    per-row Updated / LastReleaseTag refinement is bypassed so the requested window is
    honored exactly. `cap` bounds candidates per project (newest kept, rest counted in
    `dropped`); `stale_days` is the release-cadence threshold below which a repo is
    considered actively-releasing (so its between-release commits are not mined).
    """
    owner, repo = row["owner"], row["repo"]
    releases, gherr = gh_release_list(owner, repo)
    if releases is None:
        return {"error": f"release list failed: {gherr[2][:200]}"}, "error"

    if since_override:
        since = since_override
    else:
        since = iso_since_from_updated(row["updated"])
        lrt = row.get("last_release_tag", "")
        if lrt and not lrt.startswith("commit:"):
            for r in releases:
                if r.get("tagName") == lrt and r.get("publishedAt") and r["publishedAt"] > since:
                    since = r["publishedAt"]

    in_window = filter_releases(releases, since)
    mode = decide_mode(in_window, releases, today, stale_days)

    base = {"repo": f"{owner}/{repo}", "url": row["url"], "stars": row["stars"],
            "mode": mode, "since": since, "releases": [], "commits": []}

    if mode == "releases":
        ordered = sorted(in_window, key=lambda r: r.get("publishedAt", ""))
        kept, dropped = cap_candidates(ordered, cap)
        for r in kept:
            tag = r["tagName"]
            base["releases"].append({
                "tag": tag,
                "published_at": r.get("publishedAt", ""),
                "name": r.get("name", ""),
                "url": f"https://github.com/{owner}/{repo}/releases/tag/{tag}",
                "body": gh_release_view(owner, repo, tag),
            })
        base["newest_tag"] = kept[-1]["tagName"]
        if dropped:
            base["dropped"] = dropped
        return base, "releases"

    if mode == "activity":
        # Same window as releases: merged PRs first (clean feature units), commits as fallback
        # for repos that push to master without PRs.
        prs, _ = gh_merged_prs(owner, repo, since[:10])
        feat_prs = filter_feature_prs(prs or [])
        if feat_prs:
            ordered = sorted(feat_prs, key=lambda p: p.get("mergedAt", ""))
            kept, dropped = cap_candidates(ordered, cap)
            for p in kept:
                num = p["number"]
                purl = p.get("url") or f"https://github.com/{owner}/{repo}/pull/{num}"
                base["commits"].append({
                    "sha": "",
                    "date": p.get("mergedAt", ""),
                    "url": purl,
                    "summary": p.get("title", ""),
                    "pr": {"number": num, "title": p.get("title", ""), "url": purl},
                })
            merge_oid = ((kept[-1].get("mergeCommit") or {}) or {}).get("oid") or ""
            if not merge_oid:
                # an empty watermark would silently pin the repo as up-to-date forever
                return {"error": "no merge commit in the first page"}, "error"
            base["newest_commit_sha"] = merge_oid[:7]
            base["mode"] = "prs"
            if dropped:
                base["dropped"] = dropped
            return base, "prs"

        commits, gherr = gh_api_commits(owner, repo, since)
        if commits is None:
            if gherr and ("404" in (gherr[1] + gherr[2]).lower() or "not found" in (gherr[1] + gherr[2]).lower()):
                if gh_repo_exists(owner, repo):
                    return {"error": "commits 404 but repo exists (malformed request)"}, "error"
                return {"error": "repo not found"}, "error"
            return {"error": f"commits fetch failed: {gherr[2][:200]}"}, "error"
        feat = filter_feature_commits(commits)
        if not feat:
            return {"reason": "no-feature-activity"}, "empty"
        kept, dropped = cap_candidates(list(reversed(feat)), cap)  # API newest-first -> oldest-first
        for c in kept:  # kept is oldest->newest
            sha = c["sha"]
            msg = (c.get("commit", {}) or {}).get("message", "") or ""
            first = msg.splitlines()[0] if msg else ""
            pr = None
            mm = MERGE_FEAT_RE.match(first)
            if mm:
                pr = {"number": int(mm.group(1)),
                      "url": f"https://github.com/{owner}/{repo}/pull/{mm.group(1)}"}
            base["commits"].append({
                "sha": sha[:7],
                "date": (c.get("commit", {}) or {}).get("author", {}).get("date", ""),
                "url": f"https://github.com/{owner}/{repo}/commit/{sha}",
                "summary": first,
                "pr": pr,
            })
        base["newest_commit_sha"] = feat[0]["sha"][:7]
        if dropped:
            base["dropped"] = dropped
        return base, "commits"

    return {"reason": "no-release-in-window"}, "empty"


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #
def _find_row(rows, repo):
    owner, r = repo.split("/", 1)
    for row in rows:
        if row["owner"] == owner and row["repo"] == r:
            return row
    raise RowNotFound(f"no row for {repo}")


def _dispose_empty(table_path, proc_path, repo, today, reason=None):
    """A project with nothing new: bump Updated, log processed (with the empty reason),
    never surfaced to the model."""
    owner, r = repo.split("/", 1)
    tp = Path(table_path)
    _write_table_atomic(tp, rewrite_row(tp.read_text(encoding="utf-8"), owner, r,
                                        updated=today.strftime("%d.%m.%Y"), last_error=""))
    append_processed(proc_path, repo, "empty", reason=reason)


def _record_collection_error(table_path, repo, message):
    owner, r = repo.split("/", 1)
    tp = Path(table_path)
    try:
        _write_table_atomic(tp, rewrite_row(tp.read_text(encoding="utf-8"), owner, r,
                                            last_error=message[:200]))
    except RowNotFound:
        pass


def cmd_collect(table, state_root, refetch=False, since_date=None, process_all=False,
                cap=CANDIDATE_CAP, stale_days=COMMITS_FALLBACK_DAYS, repos_filter=None,
                dry_run=False):
    today = today_utc()
    sd = _state_dir(state_root, today)
    snap_path = sd / "collection.json"
    proc_path = sd / "processed.ndjson"

    since_override = None
    if since_date:
        since_override = since_date.strftime("%Y-%m-%dT00:00:00Z")

    rows = parse_table(Path(table).read_text(encoding="utf-8"))
    by_repo = {f"{r['owner']}/{r['repo']}": r for r in rows}

    ignored = []
    if repos_filter:
        for req in sorted(repos_filter):
            row = by_repo.get(req)
            if row is None:
                ignored.append({"repo": req, "reason": "not-in-table"})
            elif row.get("state") != 1:
                ignored.append({"repo": req, "reason": f"state-{row.get('state')}"})
            elif not process_all and not is_due(row, today):
                ignored.append({"repo": req, "reason": "not-due"})

    if process_all:
        due = [r for r in rows if r.get("state") == 1
               and (repos_filter is None or f"{r['owner']}/{r['repo']}" in repos_filter)]
    else:
        due = [r for r in rows if is_due(r, today)
               and (repos_filter is None or f"{r['owner']}/{r['repo']}" in repos_filter)]

    if snap_path.exists() and not refetch and not dry_run:
        snapshot = json.loads(snap_path.read_text(encoding="utf-8"))
        # rows collected before a --repos-restricted retry carry the same snapshot
        projects = snapshot.get("projects", [])
        disposed = [p["repo"] for p in snapshot.get("disposed", [])]
        errored = [p["repo"] for p in snapshot.get("errored", [])]
    else:
        projects = []
        disposed = []
        errored = []
        for row in due:
            block, mode = collect_one(row, today, since_override=since_override,
                                      cap=cap, stale_days=stale_days)
            repo = f"{row['owner']}/{row['repo']}"
            if mode == "empty":
                if not dry_run:
                    sd.mkdir(parents=True, exist_ok=True)
                    _dispose_empty(table, proc_path, repo, today,
                                   reason=(block or {}).get("reason"))
                disposed.append({"repo": repo, "reason": (block or {}).get("reason")})
            elif mode == "error":
                if not dry_run:
                    _record_collection_error(table, repo, block.get("error", "error"))
                errored.append({"repo": repo, "error": block.get("error", "error")})
            else:
                projects.append(block)
        snapshot = {"collected_at": _now_iso(), "day": today.isoformat(),
                    "projects": projects, "disposed": disposed, "errored": errored}
        if not dry_run:
            sd.mkdir(parents=True, exist_ok=True)
            snap_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2),
                                 encoding="utf-8")

    processed = set() if dry_run else read_processed_repos(proc_path)
    pending = [
        {"repo": p["repo"], "mode": p["mode"], "since": p["since"],
         "releases": len(p.get("releases", [])), "commits": len(p.get("commits", [])),
         **({"dropped": p["dropped"]} if p.get("dropped") else {})}
        for p in snapshot["projects"] if p["repo"] not in processed
    ]
    return {"day": snapshot["day"], "collected_at": snapshot["collected_at"],
            "dry_run": dry_run, "total": len(due),
            "with_updates": len(pending),
            "no_updates": len([d for d in snapshot.get("disposed", [])]),
            "pending": pending, "empty": snapshot.get("disposed", []),
            "errors": snapshot.get("errored", []), "ignored": ignored,
            "state_dir": None if dry_run else str(sd)}


def _pending_blocks(state_root, repo=None):
    """The day snapshot's projects the processed ledger has not consumed yet,
    optionally narrowed to one owner/name. Read-only: no ledger, no table, no
    state write. Empty when nothing is pending or no snapshot exists."""
    sd = _state_dir(state_root, today_utc())
    snap_path = sd / "collection.json"
    if not snap_path.exists():
        return []
    snapshot = json.loads(snap_path.read_text(encoding="utf-8"))
    processed = read_processed_repos(sd / "processed.ndjson")
    return [p for p in snapshot.get("projects", [])
            if p["repo"] not in processed and (repo is None or p["repo"] == repo)]


def cmd_next(state_root):
    pending = _pending_blocks(state_root)
    return pending[0] if pending else None


def cmd_pending(state_root, repo=None):
    return _pending_blocks(state_root, repo)


def cmd_block(table, repo, since_date=None, cap=CANDIDATE_CAP, stale_days=COMMITS_FALLBACK_DAYS):
    today = today_utc()
    rows = parse_table(Path(table).read_text(encoding="utf-8"))
    row = _find_row(rows, repo)
    since_override = None
    if since_date:
        since_override = since_date.strftime("%Y-%m-%dT00:00:00Z")
    block, mode = collect_one(row, today, since_override=since_override,
                              cap=cap, stale_days=stale_days)
    if mode in ("empty", "error"):
        block = dict(block or {})
        block["repo"] = repo
        block["mode"] = mode
    return block


def cmd_done(table, state_root, repo, last_tag=None, commit=None, error=None):
    today = today_utc()
    sd = _state_dir(state_root, today)
    proc_path = sd / "processed.ndjson"
    owner, r = repo.split("/", 1)
    tp = Path(table)
    text = tp.read_text(encoding="utf-8")
    if error:
        text = rewrite_row(text, owner, r, last_error=error[:200])
        append_processed(proc_path, repo, "error", error=error)
    else:
        tagval = last_tag if last_tag else (f"commit:{commit}" if commit else None)
        text = rewrite_row(text, owner, r, updated=today.strftime("%d.%m.%Y"),
                           last_tag=tagval, last_error="")
        append_processed(proc_path, repo, "done", last_tag=last_tag, commit=commit)
    _write_table_atomic(tp, text)
    return {"repo": repo, "status": "error" if error else "done"}


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def _parse_cap(s):
    n = int(s)  # non-numeric input -> argparse reports the invalid value itself
    if n < 1:
        raise SystemExit("--cap expects a positive integer")
    return n


def _add_common_filters(p):
    p.add_argument("--cap", type=_parse_cap, default=CANDIDATE_CAP,
                   help="Max candidates per project, newest kept (default %d)." % CANDIDATE_CAP)
    p.add_argument("--stale-days", type=int, default=COMMITS_FALLBACK_DAYS,
                   help="Release-cadence threshold; older -> mine PRs/commits (default %d)."
                        % COMMITS_FALLBACK_DAYS)
    p.add_argument("--since", type=str, default=None, metavar="YYYY-MM-DD[THH:MM:SSZ]",
                   help="Force a uniform window start for every project (overrides the "
                        "per-row Updated / LastReleaseTag watermark); a plain date or an "
                        "ISO timestamp, normalized to its date.")


def _parse_since(s):
    if not s:
        return None
    value = s.strip()
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    raise SystemExit("--since expects YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ, got %r" % s)


def _parse_repos(s):
    if not s:
        return None
    out = [x.strip() for x in s.split(",") if x.strip()]
    return out or None


def main(argv=None):
    ap = argparse.ArgumentParser(description="Deterministic collector for osb-upstream-watch.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    pc = sub.add_parser("collect", help="Build the day's snapshot; print the pending index.")
    pc.add_argument("--table", required=True, help="Path to the project table Markdown file.")
    pc.add_argument("--state-root", required=True, help="Directory for the day snapshot and ledger.")
    pc.add_argument("--refetch", action="store_true", help="Ignore an existing same-day snapshot.")
    pc.add_argument("--repos", type=str, default=None,
                    help="Comma-separated owner/name list restricting the sweep.")
    pc.add_argument("--all", dest="process_all", action="store_true",
                    help="Process every State==1 project, ignoring the Updated<today due filter.")
    pc.add_argument("--dry-run", dest="dry_run", action="store_true",
                    help="Write nothing: no snapshot, no ledger, no table writeback.")
    _add_common_filters(pc)

    pb = sub.add_parser("block", help="Fetch one project block (read-only, no state).")
    pb.add_argument("--table", required=True, help="Path to the project table Markdown file.")
    pb.add_argument("--repo", required=True, help="owner/repo")
    _add_common_filters(pb)

    pn = sub.add_parser("next", help="Print the next pending project block (empty when done).")
    pn.add_argument("--state-root", required=True, help="Directory holding the day snapshot.")

    pp = sub.add_parser("pending",
                        help="Print every pending project block (read-only, no state).")
    pp.add_argument("--state-root", required=True, help="Directory holding the day snapshot.")
    pp.add_argument("--repo", default=None, help="Limit the output to one owner/name block.")

    pd = sub.add_parser("done", help="Mark a project processed and write back its table row.")
    pd.add_argument("--table", required=True, help="Path to the project table Markdown file.")
    pd.add_argument("--state-root", required=True, help="Directory holding the day ledger.")
    pd.add_argument("repo", help="owner/repo")
    g = pd.add_mutually_exclusive_group(required=True)
    g.add_argument("--last-tag")
    g.add_argument("--commit")
    g.add_argument("--error")

    args = ap.parse_args(argv)
    if args.cmd == "collect":
        out = cmd_collect(args.table, args.state_root, refetch=args.refetch,
                          since_date=_parse_since(args.since), process_all=args.process_all,
                          cap=args.cap, stale_days=args.stale_days,
                          repos_filter=_parse_repos(args.repos), dry_run=args.dry_run)
        print(json.dumps(out, ensure_ascii=False, indent=2))
    elif args.cmd == "block":
        out = cmd_block(args.table, args.repo, since_date=_parse_since(args.since),
                        cap=args.cap, stale_days=args.stale_days)
        print(json.dumps(out, ensure_ascii=False, indent=2))
    elif args.cmd == "next":
        block = cmd_next(args.state_root)
        if block is not None:
            print(json.dumps(block, ensure_ascii=False, indent=2))
    elif args.cmd == "pending":
        print(json.dumps(cmd_pending(args.state_root, args.repo),
                         ensure_ascii=False, indent=2))
    elif args.cmd == "done":
        out = cmd_done(args.table, args.state_root, args.repo,
                       last_tag=args.last_tag, commit=args.commit, error=args.error)
        print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
__OSB_COLLECT_PY__

python3 -c "import ast; ast.parse(open('$COLLECTOR_DIR/osb-upstream-collect.py').read())"
echo "materialized $COLLECTOR_DIR/osb-upstream-collect.py (syntax ok)"
