"""
Vercel entrypoint for FastAPI.

Vercel auto-detects FastAPI apps exposed as `app` in the repository root
(`app.py` or `index.py`). We import the real app from `app/main.py` to keep
the existing package layout intact.
"""

from app.main import app

