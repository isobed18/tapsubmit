from __future__ import annotations

import json
import re
import sqlite3
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Job:
    provider: str
    board: str
    external_id: str
    title: str
    location: str
    apply_url: str
    description: str = ""
    locations: tuple[str, ...] = ()
    workplace: str = "unknown"
    seniority: str = "unknown"
    employment_type: str = "unknown"
    skills: tuple[str, ...] = ()
    department: str = ""
    posted_at: str | None = None
    salary: dict | None = None
    signals: dict = field(default_factory=dict)
    opportunity_id: str | None = None

    @property
    def key(self) -> str:
        return f"{self.provider}:{self.board}:{self.external_id}"


class Catalog:
    """Board-scoped replacement on successful refresh; failed refreshes keep old data."""

    def __init__(self, path: str | Path):
        self.db = sqlite3.connect(str(path))
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS jobs (
                key TEXT PRIMARY KEY, provider TEXT, board TEXT, payload TEXT,
                seen_at REAL NOT NULL, active INTEGER NOT NULL
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS job_search USING fts5(
                key UNINDEXED, title, location, description
            );
            CREATE INDEX IF NOT EXISTS board_jobs ON jobs(provider, board);
            CREATE TABLE IF NOT EXISTS board_state (
                provider TEXT, board TEXT, etag TEXT, modified TEXT, sha256 TEXT,
                last_success REAL, PRIMARY KEY(provider, board)
            );
        """)
        columns={row[1] for row in self.db.execute('PRAGMA table_info(board_state)')}
        if 'representation' not in columns:
            self.db.execute('ALTER TABLE board_state ADD COLUMN representation TEXT')
            self.db.commit()

    def replace_board(self, provider: str, board: str, jobs: list[Job], now: float | None = None):
        now = time.time() if now is None else now
        with self.db:
            previous = self.db.execute(
                "SELECT key FROM jobs WHERE provider=? AND board=?", (provider, board)
            ).fetchall()
            self.db.executemany("DELETE FROM job_search WHERE key=?", [(x[0],) for x in previous])
            self.db.execute("UPDATE jobs SET active=0 WHERE provider=? AND board=?", (provider, board))
            for job in jobs:
                if job.provider != provider or job.board != board:
                    raise ValueError("Board identity mismatch")
                self.db.execute(
                    "INSERT INTO jobs VALUES (?,?,?,?,?,1) ON CONFLICT(key) DO UPDATE SET "
                    "payload=excluded.payload, seen_at=excluded.seen_at, active=1",
                    (job.key, provider, board, json.dumps(asdict(job)), now),
                )
                self.db.execute(
                    "INSERT INTO job_search VALUES (?,?,?,?)",
                    (job.key, job.title, job.location, job.description),
                )

    def search(self, query: str, limit: int = 50, max_age: float = 3600,
               now: float | None = None, scope="all") -> list[dict]:
        now = time.time() if now is None else now
        tokens = re.findall(r"\w+", query, flags=re.UNICODE)
        if not tokens:
            return []
        expression = " AND ".join('"' + word + '"*' for word in tokens)
        if scope == "title":
            expression = "title : (" + expression + ")"
        elif scope != "all":
            raise ValueError("Search scope must be title or all")
        rows = self.db.execute(
            "SELECT j.payload, j.seen_at FROM job_search s JOIN jobs j ON j.key=s.key "
            "WHERE job_search MATCH ? AND j.active=1 AND j.seen_at>=? "
            "ORDER BY rank LIMIT ?", (expression, now - max_age, max(1, min(limit, 500))),
        ).fetchall()
        return [{**json.loads(row[0]), "age_seconds": round(now-row[1], 3)} for row in rows]

    def count(self):
        return self.db.execute("SELECT COUNT(*) FROM jobs WHERE active=1").fetchone()[0]

    def board_state(self, provider, board):
        row = self.db.execute("SELECT * FROM board_state WHERE provider=? AND board=?",
                              (provider, board)).fetchone()
        return dict(row) if row else {}

    def record_refresh(self, provider, board, etag, modified, sha256, representation=None):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO board_state (provider,board,etag,modified,sha256,last_success,representation) VALUES (?,?,?,?,?,?,?)",
                            (provider, board, etag, modified, sha256, time.time(),representation))

    def touch_board(self, provider, board):
        with self.db:
            self.db.execute("UPDATE jobs SET seen_at=? WHERE provider=? AND board=? AND active=1",
                            (time.time(), provider, board))

    def stats(self):
        return [dict(row) for row in self.db.execute(
            "SELECT provider,board,count(*) AS count,min(seen_at) AS oldest_observation "
            "FROM jobs WHERE active=1 GROUP BY provider,board")]

    def close(self):
        self.db.close()
