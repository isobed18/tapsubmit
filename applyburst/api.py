"""Small CPU-only discovery API. Interactive API documentation is served at /docs."""
import argparse
import asyncio
import time
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse

from .catalog import Catalog
from .discovery import load_boards, refresh


def create_app(catalog=None, db_path=".data/catalog.sqlite", boards=None):
    owns_catalog = catalog is None
    if owns_catalog:
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        catalog = Catalog(db_path)
    tasks = {"refresh": None, "report": None}

    @asynccontextmanager
    async def lifespan(app):
        yield
        if tasks["refresh"] and not tasks["refresh"].done():
            tasks["refresh"].cancel()
            try:
                await tasks["refresh"]
            except asyncio.CancelledError:
                pass
        if owns_catalog:
            catalog.close()

    app = FastAPI(title="ApplyBurst discovery baseline", version="0.1.0", lifespan=lifespan,
                  description="CPU-only indexed search. Public read-only refresh. No employer applications are submitted.")

    @app.get("/jobs")
    async def jobs(query: str = Query(default="engineer", min_length=1, max_length=200),
                   limit: int = Query(default=50, ge=1, le=100),
                   max_age: float = Query(default=3600, ge=0, le=86400),
                   scope: str = Query(default="title", pattern="^(title|all)$")):
        tick = time.perf_counter()
        rows = catalog.search(query, limit, max_age, scope=scope)
        # Do not transfer full descriptions for a search-results list.
        fields = ["provider", "board", "external_id", "title", "location", "apply_url", "age_seconds"]
        results = [{**{field: row[field] for field in fields}, "application_capability": "discovery_only"}
                   for row in rows]
        return {"query": query, "scope": scope, "count": len(results), "jobs": results,
                "search_ms": round((time.perf_counter()-tick)*1000, 3),
                "refresh_running": bool(tasks["refresh"] and not tasks["refresh"].done())}

    @app.get("/status")
    async def status():
        return {"indexed": catalog.count(), "boards": catalog.stats(), "model_required": False,
                "refresh_running": bool(tasks["refresh"] and not tasks["refresh"].done()),
                "last_refresh": tasks["report"]}

    @app.post("/refresh", status_code=202)
    async def start_refresh():
        if not tasks["refresh"] or tasks["refresh"].done():
            async def work():
                try:
                    tasks["report"] = await refresh(catalog, boards if boards is not None else load_boards())
                except Exception as exc:
                    tasks["report"] = {"outcome": "failed", "error": type(exc).__name__}
            tasks["refresh"] = asyncio.create_task(work())
        return {"state": "refreshing", "message": "Search remains available as boards finish."}

    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=".data/catalog.sqlite")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    uvicorn.run(create_app(db_path=args.db), host="127.0.0.1", port=args.port)
