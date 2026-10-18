import json
import sqlite3
import time


class Ledger:
    """Persistent claims prevent concurrent duplicate sends. In-flight crashes become unknown."""

    def __init__(self, path):
        self.db = sqlite3.connect(str(path))
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS applications (
                key TEXT PRIMARY KEY, state TEXT NOT NULL, receipt TEXT, updated_at REAL NOT NULL
            );
        """)

    def claim(self, key):
        with self.db:
            cursor = self.db.execute(
                "INSERT OR IGNORE INTO applications VALUES (?, 'running', NULL, ?)", (key, time.time()))
        return cursor.rowcount == 1

    def finish(self, key, state, receipt=None):
        if state not in {"confirmed_fixture", "accepted_by_mail_server", "failed", "unknown", "needs_input"}:
            raise ValueError("Invalid completion state")
        with self.db:
            self.db.execute("UPDATE applications SET state=?,receipt=?,updated_at=? WHERE key=?",
                            (state, json.dumps(receipt), time.time(), key))

    def get(self, key):
        row = self.db.execute("SELECT * FROM applications WHERE key=?", (key,)).fetchone()
        return dict(row) if row else None

    def recover_interrupted(self):
        with self.db:
            self.db.execute("UPDATE applications SET state='unknown' WHERE state='running'")

    def close(self):
        self.db.close()
