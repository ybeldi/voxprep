import io
import logging
from typing import Optional
from backend.config import OPENAI_API_KEY, OPENAI_BASE_URL

logger = logging.getLogger(__name__)

DEFAULT_NEURAL_VOICE = "en-GB-RyanNeural"


def _has_edge_tts() -> bool:
    try:
        import edge_tts  # noqa: F401
        return True
    except ImportError:
        return False


class AudioService:
    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None):
        self.api_key = api_key or OPENAI_API_KEY
        self.base_url = (base_url or OPENAI_BASE_URL or "").strip()
        self._openai_client = None
        if self.api_key:
            try:
                from openai import OpenAI
                kwargs = {"api_key": self.api_key}
                if self.base_url:
                    kwargs["base_url"] = self.base_url
                self._openai_client = OpenAI(**kwargs)
            except Exception as e:
                logger.warning(f"Failed to initialize OpenAI client for audio: {e}")

    @property
    def has_backend_tts(self) -> bool:
        return self._openai_client is not None

    @property
    def has_neural_tts(self) -> bool:
        return _has_edge_tts()

    def transcribe_audio_bytes(self, audio_bytes: bytes, filename: str = "audio.wav") -> str:
        """Transcribe audio bytes using OpenAI Whisper API if available."""
        if not self._openai_client:
            raise RuntimeError("OpenAI API key not configured for server-side Whisper transcription.")

        audio_file = io.BytesIO(audio_bytes)
        audio_file.name = filename
        transcription = self._openai_client.audio.transcriptions.create(
            model="whisper-1",
            file=audio_file
        )
        return transcription.text

    def synthesize_openai_hd(self, text: str, voice: str = "onyx") -> bytes:
        """Generate HD MP3 speech using OpenAI tts-1-hd."""
        if not self._openai_client:
            raise RuntimeError("OpenAI API key not configured for OpenAI TTS.")

        response = self._openai_client.audio.speech.create(
            model="tts-1-hd",
            voice=voice,
            input=text,
            response_format="mp3",
        )
        return response.content

    async def synthesize_neural(self, text: str, voice: str = DEFAULT_NEURAL_VOICE) -> bytes:
        """Generate smooth, studio-grade neural MP3 speech via edge-tts (no API key needed)."""
        import edge_tts

        communicate = edge_tts.Communicate(text=text, voice=voice, rate="+0%", pitch="+0Hz")
        buf = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                buf.write(chunk["data"])
        audio_bytes = buf.getvalue()
        if not audio_bytes:
            raise RuntimeError("Neural TTS returned empty audio stream.")
        return audio_bytes


audio_service = AudioService()
