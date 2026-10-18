import argparse
import asyncio
import json
from pathlib import Path

from .catalog import Catalog
from .discovery import load_boards, refresh


async def main(args):
    Path(args.db).parent.mkdir(parents=True, exist_ok=True)
    catalog = Catalog(args.db)
    try:
        if args.command == "refresh":
            report = await refresh(catalog, load_boards(args.boards, args.preset))
            print(json.dumps(report, indent=2))
        elif args.command == "search":
            print(json.dumps(catalog.search(args.query, args.limit, args.max_age, scope=args.scope),
                             indent=2, ensure_ascii=False))
        else:
            print(json.dumps(catalog.stats(), indent=2))
    finally:
        catalog.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=".data/catalog.sqlite")
    sub = parser.add_subparsers(dest="command", required=True)
    fetch = sub.add_parser("refresh")
    fetch.add_argument("--boards", default="config/boards.json")
    fetch.add_argument("--preset", choices=["international", "turkey"])
    search = sub.add_parser("search")
    search.add_argument("query")
    search.add_argument("--limit", type=int, default=50)
    search.add_argument("--max-age", type=float, default=3600)
    search.add_argument("--scope", choices=["title", "all"], default="title")
    sub.add_parser("stats")
    asyncio.run(main(parser.parse_args()))
