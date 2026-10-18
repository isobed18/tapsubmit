from applyburst.discovery import Board, normalize, refresh
from applyburst.catalog import Catalog
import httpx
from applyburst.enrichment import plain_text, enrich


def test_complete_lever_sections_are_searchable():
    job = normalize(Board("lever", "sample"), [{"id": "1", "text": "Backend Engineer", "applyUrl": "https://example.test",
        "descriptionPlain": "Company introduction", "categories": {"location": "Istanbul", "commitment": "Full-time"},
        "lists": [{"text": "Requirements", "content": "<li>Python and PostgreSQL required</li>"}],
        "additionalPlain": "We use Kafka", "workplaceType": "hybrid"}])[0]
    assert "Python" in job.description and "Kafka" in job.description
    assert {"Python", "PostgreSQL", "Kafka"}.issubset(job.skills)
    assert job.workplace == "hybrid" and job.seniority == "unknown"
    assert job.employment_type == "full-time"


def test_html_decoding_does_not_index_scripts():
    assert plain_text("&lt;p&gt;Python &amp;amp; Go&lt;/p&gt;<script>noise()</script>") == "Python & Go"


def test_inferred_and_unknown_fields_stay_distinct():
    assert enrich("Engineer", "We work with remote clients", "London")["workplace"] == "unknown"
    result = enrich("Senior Engineer", "Please go to our careers page", "Remote - US")
    assert result["seniority"] == "senior" and result["workplace"] == "remote"
    assert "Go" not in result["skills"]
    assert "Go" not in enrich("Engineer", "Go to our careers site", "London")["skills"]
    assert result["signals"]["workplace"]["method"] == "location_or_title"


async def test_content_variant_invalidates_conditional_processing_cache():
    catalog=Catalog(':memory:')
    def handler(request):
        assert 'if-none-match' not in request.headers
        content='Python requirements' if request.url.params.get('content')=='true' else ''
        return httpx.Response(200,headers={'ETag':'same-revision'},json={'jobs':[{'id':1,'internal_job_id':10,'title':'Engineer','location':{'name':'Remote'},'absolute_url':'https://example.test','content':content}]})
    transport=httpx.MockTransport(handler)
    await refresh(catalog,[Board('greenhouse','example',False)],transport=transport)
    assert not catalog.search('python')
    await refresh(catalog,[Board('greenhouse','example',True)],transport=transport)
    assert len(catalog.search('python'))==1
    catalog.close()
