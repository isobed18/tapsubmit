"""One bounded, unauthenticated public JobSpy search. Never submits an application."""
import importlib.metadata
import json
import multiprocessing
import time
import io
import logging
from pathlib import Path


def child(queue):
    try:
        from jobspy import scrape_jobs
        captured = io.StringIO()
        handler = logging.StreamHandler(captured)
        logger = logging.getLogger("JobSpy:LinkedIn")
        logger.addHandler(handler)
        tick = time.perf_counter()
        jobs = scrape_jobs(site_name=["linkedin"], search_term="software engineer", location="Turkey",
                           results_wanted=50, fetch_description=False, linkedin_fetch_description=False,
                           verbose=0)
        queue.put({"outcome": "returned" if len(jobs) >= 50 else "partial",
                   "warnings": captured.getvalue(), "elapsed_ms": (time.perf_counter()-tick)*1000,
                   "count": len(jobs), "requested": 50, "descriptions_requested": False,
                   "sample_titles": jobs["title"].head(5).tolist() if len(jobs) else []})
    except Exception as exc:
        queue.put({"outcome": "failed", "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    from .bench import metadata
    queue = multiprocessing.Queue()
    process = multiprocessing.Process(target=child, args=(queue,))
    tick = time.perf_counter()
    process.start()
    process.join(60)
    if process.is_alive():
        process.terminate()
        process.join()
        result = {"outcome": "timeout", "timeout_seconds": 60}
    else:
        result = queue.get(timeout=2)
    result.update(metadata=metadata(), package=importlib.metadata.version("python-jobspy"),
                  wall_ms=(time.perf_counter()-tick)*1000,
                  scope="One public read-only LinkedIn query through JobSpy, no login or proxy")
    Path("reports").mkdir(exist_ok=True)
    Path("reports/jobspy.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2), flush=True)
