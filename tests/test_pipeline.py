import asyncio
import time

import pytest
import httpx

from applyburst.catalog import Catalog, Job
from applyburst.api import create_app
from applyburst.discovery import Board, normalize, refresh
from applyburst.execution import loopback_only, run_http
from applyburst.fixture import make_fixture
from applyburst.forms import EXPECTED, FIELDS, PROFILE, fingerprint, known_answers, validate_plan
from applyburst.harness import serve
from applyburst.ledger import Ledger


def test_catalog_freshness_closure_and_duplicate_ids():
    catalog = Catalog(":memory:")
    job = Job("greenhouse", "one", "1", "Software Engineer", "Remote", "https://example.test/1")
    other = Job("lever", "two", "1", "Software Engineer", "Remote", "https://example.test/2")
    catalog.replace_board("greenhouse", "one", [job], now=100)
    catalog.replace_board("lever", "two", [other], now=100)
    assert len(catalog.search("engineer", now=110)) == 2
    assert len(catalog.search('engineer " OR *', now=110)) == 0
    assert catalog.search("engineer", now=200, max_age=50) == []
    catalog.replace_board("greenhouse", "one", [], now=110)
    assert len(catalog.search("engineer", now=110)) == 1
    catalog.close()


async def test_discovery_api_returns_metadata_and_validates_request():
    catalog = Catalog(":memory:")
    catalog.replace_board("fixture", "one", [Job("fixture", "one", "1", "Engineer", "Remote",
                                                  "https://example.test", "full description")])
    app = create_app(catalog=catalog)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as client:
        response = await client.get("/jobs?query=engineer")
        assert response.status_code == 200
        assert response.json()["count"] == 1
        assert "description" not in response.json()["jobs"][0]
        assert response.json()["jobs"][0]["application_capability"] == "discovery_only"
        assert (await client.get("/jobs?limit=10000")).status_code == 422
        assert (await client.get("/status")).json()["model_required"] is False
    catalog.close()


def test_board_mismatch_does_not_destroy_previous_catalog():
    catalog = Catalog(":memory:")
    job = Job("greenhouse", "one", "1", "Engineer", "Remote", "https://example.test")
    catalog.replace_board("greenhouse", "one", [job])
    with pytest.raises(ValueError):
        catalog.replace_board("greenhouse", "one", [Job("lever", "other", "1", "Bad", "", "")])
    assert len(catalog.search("engineer")) == 1
    catalog.close()


def test_source_normalization_filters_unlisted_and_prospect():
    assert normalize(Board("greenhouse", "one"), {"jobs": [{"internal_job_id": None}]}) == []
    assert normalize(Board("ashby", "two"), {"jobs": [{"isListed": False}]}) == []
    with pytest.raises(ValueError):
        normalize(Board("lever", "three"), {"error": "unexpected"})


def test_unknown_required_question_and_missing_fact_stop_preparation():
    with pytest.raises(ValueError):
        known_answers(FIELDS + [{"name": "salary", "required": True, "kind": "text"}])
    with pytest.raises(ValueError):
        validate_plan({"mapping": EXPECTED}, profile={**PROFILE, "work_authorized": ""})
    with pytest.raises(ValueError):
        validate_plan({"mapping": {**EXPECTED, "email": "invented"}})
    assert fingerprint() != fingerprint(FIELDS + [{"name": "new"}])


@pytest.mark.parametrize("url", ["https://example.com", "http://127.0.0.1.evil.test", "http://user:pw@localhost"])
def test_baseline_writes_cannot_target_employers(url):
    with pytest.raises(ValueError):
        loopback_only(url)


async def test_concurrent_duplicate_attempts_have_one_side_effect(tmp_path):
    app = make_fixture(10)
    ledger = Ledger(tmp_path / "ledger.sqlite")
    async with serve(app) as url:
        one, two = await asyncio.gather(run_http(url, ["same"]*10, ledger),
                                        run_http(url, ["same"]*10, ledger))
        assert len(app.state.receipts) == 1
        assert sum(r["confirmed"] for r in [one, two]) == 1
        assert sum(app.state.attempts.values()) == 1
    ledger.close()
    reopened = Ledger(tmp_path / "ledger.sqlite")
    assert reopened.get("demo-candidate:same")["state"] == "confirmed_fixture"
    assert not reopened.claim("demo-candidate:same")
    reopened.close()


async def test_rate_rejection_retries_and_verifies_receipt():
    app, ledger = make_fixture(1, "rate_limit"), Ledger(":memory:")
    async with serve(app) as url:
        result = await run_http(url, ["rate"], ledger)
    assert result["confirmed"] == 1
    assert result["results"][0]["attempts"] == 2
    assert len(app.state.receipts) == 1
    ledger.close()


@pytest.mark.parametrize("fault,expected", [("missing_receipt", "unknown"), ("rejected", "failed"),
                                            ("ambiguous", "unknown")])
async def test_failures_never_become_success_or_blind_retry(fault, expected):
    app, ledger = make_fixture(1, fault), Ledger(":memory:")
    async with serve(app) as url:
        result = await run_http(url, [fault], ledger, timeout=.1)
        assert result["results"][0]["state"] == expected
        assert result["results"][0]["attempts"] == 1
        repeated = await run_http(url, [fault], ledger)
        assert repeated["results"][0]["state"] == "deduplicated"
    assert sum(app.state.attempts.values()) == 1
    ledger.close()


def test_crash_recovery_never_requeues_unknown_side_effect(tmp_path):
    path = tmp_path / "recovery.sqlite"
    ledger = Ledger(path)
    assert ledger.claim("in-flight")
    ledger.close()
    ledger = Ledger(path)
    ledger.recover_interrupted()
    assert ledger.get("in-flight")["state"] == "unknown"
    assert not ledger.claim("in-flight")
    ledger.close()


async def test_conditional_refresh_preserves_index_and_failed_source_keeps_age():
    catalog = Catalog(":memory:")
    board = Board("lever", "conditional")
    calls = []
    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(200, headers={"ETag": '"v1"'}, json=[{
                "id": "1", "text": "Software Engineer", "applyUrl": "https://example.test",
                "categories": {"location": "Remote"}}])
        if len(calls) == 2:
            assert request.headers["if-none-match"] == '"v1"'
            return httpx.Response(304)
        return httpx.Response(503)
    transport = httpx.MockTransport(handler)
    assert (await refresh(catalog, [board], transport=transport))["total_indexed"] == 1
    assert (await refresh(catalog, [board], transport=transport))["boards"][0]["outcome"] == "not_modified"
    state_before = catalog.board_state("lever", "conditional")
    assert (await refresh(catalog, [board], transport=transport))["boards"][0]["outcome"] == "failed"
    assert catalog.board_state("lever", "conditional") == state_before
    assert len(catalog.search("engineer")) == 1
    catalog.close()


async def test_slow_source_does_not_hide_fast_results():
    catalog = Catalog(":memory:")
    async def handler(request):
        if "slow" in str(request.url):
            await asyncio.sleep(.1)
            return httpx.Response(200, json=[])
        return httpx.Response(200, json=[{"id": str(i), "text": "Engineer", "categories": {},
                                          "applyUrl": "https://example.test"} for i in range(60)])
    task = asyncio.create_task(refresh(catalog, [Board("lever", "fast"), Board("lever", "slow")],
                                       transport=httpx.MockTransport(handler), deadline_seconds=.05))
    await asyncio.sleep(.02)
    assert len(catalog.search("engineer")) == 50
    report = await task
    assert report["first_50_matches_ms"] < report["elapsed_ms"]
    assert report["boards"][1]["outcome"] == "failed"
    catalog.close()
