import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env file
load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ANTHROPIC_BASE_URL = os.getenv("ANTHROPIC_BASE_URL", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "")

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))
ALLOWED_ORIGINS = [
    o.strip().rstrip("/") for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()
]

# Interactive API docs (/docs, /redoc, /openapi.json) are disabled unless explicitly enabled.
ENABLE_API_DOCS = os.getenv("ENABLE_API_DOCS", "").strip().lower() in {"1", "true", "yes"}

CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-5-5")
CLAUDE_EFFORT = os.getenv("CLAUDE_EFFORT", "medium")

# Interview length & security bounds
MAX_CANDIDATE_TURNS = int(os.getenv("MAX_CANDIDATE_TURNS", "10"))
SESSION_TTL_SECONDS = int(os.getenv("SESSION_TTL_SECONDS", "1800"))
MAX_ACTIVE_SESSIONS = int(os.getenv("MAX_ACTIVE_SESSIONS", "50"))
MAX_RESUME_UPLOAD_BYTES = int(os.getenv("MAX_RESUME_UPLOAD_BYTES", str(5 * 1024 * 1024)))
