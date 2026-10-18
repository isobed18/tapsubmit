"""Extract a local PDF/DOCX/TXT as private text; never export it to the public corpus."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from applyburst.resume import main

if __name__ == '__main__':
    main()
