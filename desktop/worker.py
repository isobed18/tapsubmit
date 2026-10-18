"""Packaged worker entry point. stdout/stdin remain the local JSON-lines protocol."""
import sys

def main():
    # Keep the pipe protocol independent of the launcher's environment and Windows code page.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    if sys.argv[1:3]==['--worker','companion']:
        from applyburst.companion import main as companion
        companion(sys.argv[3:])
    elif sys.argv[1:3]==['--worker','live_search']:
        # Only the signed-in LinkedIn path needs Python in the desktop package.
        from applyburst.live_search import main as search
        sys.argv=[sys.argv[0],*sys.argv[3:]];search()
    elif sys.argv[1:3]==['--worker','import_resume']:
        from applyburst.resume import main as import_resume
        import_resume(sys.argv[3:])
    elif sys.argv[1:2]==['--install-browser']:
        from playwright.__main__ import main as playwright
        sys.argv=['playwright','install','chromium'];playwright()
    elif sys.argv[1:2]==['--diagnose']:
        import json
        from applyburst.companion import installed_browser
        channel,path=installed_browser()
        print(json.dumps({'worker':'ok','installed_browser':channel,'models_required':False,'gpu_required':False}))
    else:raise SystemExit('Unknown local worker task.')

if __name__=='__main__':main()
