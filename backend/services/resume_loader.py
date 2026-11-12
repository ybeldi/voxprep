import io
import re
import logging
from pathlib import Path
from typing import Dict, Any

logger = logging.getLogger(__name__)

SUPPORTED_EXTENSIONS = {".pdf", ".txt", ".md"}


def extract_text_from_pdf_bytes(data: bytes) -> str:
    """Extract plain text from PDF bytes using pypdf."""
    try:
        import pypdf
        reader = pypdf.PdfReader(io.BytesIO(data))
        parts = [t for t in (page.extract_text() for page in reader.pages) if t]
        return "\n\n".join(parts)
    except Exception as e:
        logger.error(f"Failed to parse PDF: {e}")
        return ""


def guess_candidate_name(text: str, fallback: str = "") -> str:
    """Heuristic: the first short line of a resume is usually the candidate's name."""
    for line in (l.strip() for l in text.splitlines()):
        if not line:
            continue
        cleaned = re.sub(r"^[#*\s]+", "", line).strip()
        if (
            0 < len(cleaned) < 40
            and not any(k in cleaned.lower() for k in ["resume", "cv", "curriculum", "@", "http"])
            and not any(ch.isdigit() for ch in cleaned)
        ):
            return cleaned
        break
    return fallback


def parse_resume_bytes(filename: str, data: bytes) -> Dict[str, Any]:
    """Extract text and a best-guess candidate name from an uploaded resume (kept in memory only)."""
    ext = Path(filename).suffix.lower()
    if ext == ".pdf":
        text = extract_text_from_pdf_bytes(data)
    else:
        text = data.decode("utf-8", errors="ignore")

    fallback = Path(filename).stem.replace("_", " ").replace("-", " ").title()
    return {
        "file_name": filename,
        "candidate_name": guess_candidate_name(text, fallback),
        "text": text.strip(),
    }
