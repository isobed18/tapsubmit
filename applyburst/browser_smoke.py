"""Interactive browser execution against our own synthetic receiver only."""
import argparse
import asyncio
import json
from pathlib import Path

from .browser import run_browser
from .fixture import make_fixture
from .harness import serve

async def main(args):
    fixture=make_fixture(100)
    async with serve(fixture) as url:
        ids=[f"portal-browser-{i}" for i in range(50)]
        result=await run_browser(url,ids,concurrency=2)
        result['receiver_count']=len(fixture.state.receipts)
        assert result['confirmed']==result['receiver_count']==50
        result.update(scope='50 synthetic applications in real Chromium; loopback receiver; GPU disabled; no employer writes',gpu_enabled=False)
    Path(args.output).write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps({key:value for key,value in result.items() if key!='results'}))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True)
    asyncio.run(main(parser.parse_args()))
