import asyncio
import logging
import re
from typing import Optional
from urllib.parse import urlparse

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException, Header, Request
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

from backend.config import (
    ALLOWED_ORIGINS,
    ANTHROPIC_API_KEY,
    CLAUDE_MODEL,
    FRONTEND_DIR,
    HOST,
    MAX_RESUME_UPLOAD_BYTES,
    PORT,
)
from backend.services.resume_loader import parse_resume_bytes, SUPPORTED_EXTENSIONS
from backend.services.interview_engine import (
    create_session,
    get_session,
    remove_session,
    verify_session_secret,
)
from backend.services.llm_client import summarize_provider_error, validate_base_url
from backend.services.audio_service import audio_service
from backend.services.scorecard import generate_interview_scorecard

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("voice_interviewer")

app = FastAPI(title="VoxPrep Interview Simulator", version="2.0.0")

VOICE_ID_RE = re.compile(r"^[A-Za-z0-9-]+$")


def _allowed_origins() -> list[str]:
    origins = {
        f"http://{HOST}:{PORT}",
        f"http://127.0.0.1:{PORT}",
        f"http://localhost:{PORT}",
    }
    origins.update(ALLOWED_ORIGINS)
    return sorted(origins)


app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-Session-Token"],
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data: blob:; "
        "media-src 'self' blob:; "
        "connect-src 'self' ws: wss:; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "frame-ancestors 'none'"
    )
    return response


# ----------------- Models -----------------
class StartSessionRequest(BaseModel):
    resume_text: str = Field(..., max_length=50000)
    job_description: str = Field(..., max_length=30000)
    model: str = Field(default=CLAUDE_MODEL, max_length=120)
    api_key: str = Field(..., max_length=512)
    base_url: Optional[str] = Field(default="", max_length=512)
    mode: Optional[str] = Field(default="standard", max_length=32)
    max_turns: Optional[int] = Field(default=10, ge=4, le=20)
    candidate_name: Optional[str] = Field(default="", max_length=120)
    role_title: Optional[str] = Field(default="", max_length=150)


class TurnRequest(BaseModel):
    message: str = Field(..., max_length=2000)
    engine: Optional[str] = Field(default="neural", max_length=16)
    voice: Optional[str] = Field(default="", max_length=64)
    session_id: Optional[str] = Field(default="", max_length=64)


def _require_session(session_id: str, session_token: Optional[str]):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Interview session not found.")
    if not verify_session_secret(session, session_token):
        raise HTTPException(status_code=403, detail="Invalid or missing session token.")
    session.touch()
    return session


# ----------------- REST Endpoints -----------------
@app.get("/api/status")
def get_system_status():
    return {
        "status": "healthy",
        "model": CLAUDE_MODEL,
        "has_anthropic_key": bool(ANTHROPIC_API_KEY),
        "has_openai_audio_key": audio_service.has_backend_tts,
        "has_neural_tts": audio_service.has_neural_tts,
    }


@app.post("/api/parse-resume")
async def parse_resume(file: UploadFile = File(...)):
    """Parse an uploaded resume in memory (nothing is written to disk)."""
    name = file.filename or "resume.txt"
    ext = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Supported formats: PDF, TXT, MD.")

    chunks = []
    total = 0
    while True:
        chunk = await file.read(65536)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_RESUME_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Resume file exceeds 5 MB limit.")
        chunks.append(chunk)

    info = parse_resume_bytes(name, b"".join(chunks))
    if not info["text"]:
        raise HTTPException(status_code=422, detail="Could not extract text from this file. Try pasting the resume text instead.")
    return {"success": True, **info}


@app.post("/api/session/start")
async def api_start_session(req: StartSessionRequest):
    """Initialize an interview simulation and get VoxPrep's opening line."""
    model = (req.model or "").strip()
    effective_key = (req.api_key or "").strip()
    for val, msg in (
        (model, "Please select an AI model."),
        (effective_key, "API token is required."),
        (req.resume_text.strip(), "A resume is required."),
        (req.job_description.strip(), "A job description is required."),
    ):
        if not val:
            raise HTTPException(status_code=400, detail=msg)

    try:
        base_url = validate_base_url(req.base_url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    session = create_session(
        candidate_name=(req.candidate_name or "").strip(),
        role_title=(req.role_title or "").strip(),
        resume_text=req.resume_text,
        job_description=req.job_description,
        model=model,
        api_key=effective_key,
        base_url=base_url,
        mode=(req.mode or "standard").strip(),
        max_turns=req.max_turns or 10,
    )

    try:
        opening_speech = await asyncio.to_thread(session.start)
    except Exception as e:
        remove_session(session.session_id)
        logger.error(f"Failed to start session with model={model}: {e}")
        raise HTTPException(status_code=400, detail=summarize_provider_error(e))

    return {
        "session_id": session.session_id,
        "session_token": session.session_secret,
        "model": session.model,
        "mode": session.mode,
        "max_turns": session.max_turns,
        "candidate_name": session.candidate_name,
        "role_title": session.role_title,
        "stage": session.current_stage,
        "plan": session.interview_plan,
        "gaps": session.gaps_to_probe,
        "opening_turn": opening_speech
    }


@app.get("/api/session/{session_id}")
def api_get_session(session_id: str, x_session_token: Optional[str] = Header(default=None)):
    session = _require_session(session_id, x_session_token)
    return {
        "session_id": session.session_id,
        "candidate_name": session.candidate_name,
        "role_title": session.role_title,
        "stage": session.current_stage,
        "plan": session.interview_plan,
        "turns": session.turns,
        "is_active": session.is_active
    }


@app.post("/api/session/{session_id}/end")
async def api_end_session(session_id: str, x_session_token: Optional[str] = Header(default=None)):
    session = _require_session(session_id, x_session_token)

    session.is_active = False
    try:
        scorecard = await asyncio.to_thread(generate_interview_scorecard, session)
        remove_session(session_id)
        return {"success": True, "scorecard": scorecard}
    except Exception as e:
        logger.error(f"Scorecard generation failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to compile debrief scorecard.")


@app.post("/api/audio/synthesize")
async def api_synthesize_speech(req: TurnRequest, x_session_token: Optional[str] = Header(default=None)):
    """Server-side HD TTS synthesis endpoint (MP3) via Neural HD or OpenAI tts-1-hd."""
    text = (req.message or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Message text is required for synthesis.")
    voice = (req.voice or "").strip()
    if voice and not VOICE_ID_RE.match(voice):
        raise HTTPException(status_code=400, detail="Invalid voice identifier.")

    engine = (req.engine or "neural").lower()
    if engine == "openai":
        # Guard server-side paid OpenAI TTS behind an active authenticated interview session
        if not req.session_id or not verify_session_secret(get_session(req.session_id), x_session_token):
            raise HTTPException(status_code=403, detail="OpenAI TTS requires an active authenticated session.")
        if not audio_service.has_backend_tts:
            raise HTTPException(status_code=400, detail="OpenAI TTS not configured.")
        try:
            audio_bytes = await asyncio.to_thread(audio_service.synthesize_openai_hd, text, voice or "onyx")
            return Response(content=audio_bytes, media_type="audio/mpeg")
        except Exception as e:
            logger.error(f"OpenAI TTS synthesis failed: {e}")
            raise HTTPException(status_code=500, detail="OpenAI TTS synthesis failed.")

    if not audio_service.has_neural_tts:
        raise HTTPException(status_code=400, detail="Neural TTS package (edge-tts) not installed.")
    try:
        audio_bytes = await audio_service.synthesize_neural(text, voice or "en-GB-RyanNeural")
        return Response(content=audio_bytes, media_type="audio/mpeg")
    except Exception as e:
        logger.error(f"Neural TTS synthesis failed: {e}")
        raise HTTPException(status_code=500, detail="Neural TTS synthesis failed.")


def _ws_origin_allowed(websocket: WebSocket) -> bool:
    origin = (websocket.headers.get("origin") or "").rstrip("/")
    if not origin:
        return True
    if origin in _allowed_origins():
        return True
    host = websocket.headers.get("host", "")
    parsed = urlparse(origin)
    return bool(host and parsed.scheme in {"http", "https"} and parsed.netloc == host)


# ----------------- WebSocket Live Interview Endpoint -----------------
@app.websocket("/ws/interview/{session_id}")
async def websocket_interview_endpoint(websocket: WebSocket, session_id: str):
    if not _ws_origin_allowed(websocket):
        await websocket.close(code=1008)
        return

    await websocket.accept()
    session = get_session(session_id)
    if not session:
        await websocket.send_json({"type": "error", "message": "Session not found."})
        await websocket.close(code=4404)
        return

    try:
        auth_msg = await asyncio.wait_for(websocket.receive_json(), timeout=10.0)
    except Exception:
        await websocket.close(code=4401)
        return

    if auth_msg.get("type") != "auth" or not verify_session_secret(session, auth_msg.get("token")):
        await websocket.send_json({"type": "error", "message": "Unauthorized session."})
        await websocket.close(code=4401)
        return

    session.touch()
    logger.info("WebSocket connected and authenticated for active session.")
    try:
        while True:
            data = await websocket.receive_json()
            if data.get("type") != "candidate_speech":
                continue

            speech_text = str(data.get("text", "")).strip()[:12000]
            if not speech_text:
                continue

            await websocket.send_json({"type": "interviewer_thinking", "stage": session.current_stage})

            reply = await asyncio.to_thread(session.process_turn, speech_text)

            await websocket.send_json({
                "type": "interviewer_speech",
                "text": reply,
                "stage": session.current_stage,
                "stage_index": session.stage_idx,
                "turns_count": len(session.turns),
                "candidate_turns": session.candidate_turn_count,
                "max_turns": session.max_turns,
                "is_complete": session.is_complete
            })

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected for session.")
    except Exception as e:
        logger.error(f"WebSocket error in active session: {e}")
        try:
            await websocket.send_json({"type": "error", "message": summarize_provider_error(e)})
        except Exception:
            pass


# ----------------- Static Frontend Mount -----------------
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
