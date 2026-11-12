import datetime
import hmac
import logging
import secrets
import time
from typing import Dict, Any, List, Optional
import anthropic
import openai

from backend.config import (
    CLAUDE_MODEL,
    MAX_ACTIVE_SESSIONS,
    MAX_CANDIDATE_TURNS,
    SESSION_TTL_SECONDS,
)
from backend.services.llm_client import LLMClient

logger = logging.getLogger(__name__)

INTERVIEW_STAGES = [
    "INTRODUCTION",
    "BACKGROUND_REVIEW",
    "CORE_TECHNICAL",
    "SCENARIO_PROBLEM_SOLVING",
    "BEHAVIORAL_TEAMWORK",
    "CANDIDATE_QUESTIONS",
    "COMPLETED"
]

INTERVIEW_MODES = {
    "standard": (
        "Balanced, realistic senior hiring panel. Probe for depth when answers are high-level, "
        "maintain polished British poise and subtle wit, and keep a natural conversational flow."
    ),
    "strict": (
        "Bar-raiser / principal interviewer mode. Be politely skeptical, challenge vague claims, "
        "demand concrete metrics, edge cases, failure modes, and architectural trade-offs."
    ),
    "coaching": (
        "Supportive practice-coach mode. After each candidate answer, give one concise sentence of "
        "constructive feedback (what landed well or what was missing) before asking your next question."
    ),
}

PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "candidate_name": {"type": "string"},
        "role_title": {"type": "string"},
        "topics": {"type": "array", "items": {"type": "string"}},
        "strengths_to_verify": {"type": "array", "items": {"type": "string"}},
        "gaps_to_probe": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["candidate_name", "role_title", "topics", "strengths_to_verify", "gaps_to_probe"],
}

STAGE_THRESHOLDS = ((0.2, 1), (0.45, 2), (0.7, 3), (0.9, 4))

FATAL_PROVIDER_ERRORS = (
    anthropic.AuthenticationError,
    anthropic.PermissionDeniedError,
    anthropic.NotFoundError,
    anthropic.APIConnectionError,
    openai.AuthenticationError,
    openai.PermissionDeniedError,
    openai.NotFoundError,
    openai.APIConnectionError,
)


class InterviewSession:
    """Manages the lifecycle, gap analysis, and turns of an active VoxPrep voice interview."""

    def __init__(
        self,
        session_id: str,
        candidate_name: str,
        role_title: str,
        resume_text: str,
        job_description: str,
        model: str = CLAUDE_MODEL,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        mode: str = "standard",
        max_turns: int = MAX_CANDIDATE_TURNS,
    ):
        self.session_id = session_id
        self.session_secret = secrets.token_urlsafe(24)
        self.candidate_name = candidate_name
        self.role_title = role_title
        self.resume_text = resume_text
        self.job_description = job_description
        self.model = (model or CLAUDE_MODEL).strip()
        self.api_key = (api_key or "").strip()
        self.base_url = (base_url or "").strip()
        self.mode = mode if mode in INTERVIEW_MODES else "standard"
        self.max_turns = max(4, min(20, int(max_turns or MAX_CANDIDATE_TURNS)))
        self.llm = LLMClient(self.model, self.api_key, self.base_url) if self.api_key else None

        self.stage_idx = 0
        self.turns: List[Dict[str, Any]] = []
        self.interview_plan: List[str] = []
        self.strengths_to_verify: List[str] = []
        self.gaps_to_probe: List[str] = []
        self.created_at = datetime.datetime.now().isoformat()
        self.last_activity = time.monotonic()
        self.is_active = True

    def touch(self) -> None:
        self.last_activity = time.monotonic()

    @property
    def current_stage(self) -> str:
        if self.stage_idx < len(INTERVIEW_STAGES):
            return INTERVIEW_STAGES[self.stage_idx]
        return "COMPLETED"

    @property
    def candidate_turn_count(self) -> int:
        return sum(1 for t in self.turns if t["role"] == "candidate")

    @property
    def is_complete(self) -> bool:
        return self.current_stage == "COMPLETED"

    def _add_turn(self, role: str, text: str):
        self.turns.append({
            "role": role,
            "text": text,
            "stage": self.current_stage,
            "timestamp": datetime.datetime.now().isoformat()
        })

    def generate_interview_plan(self) -> List[str]:
        """Analyze resume vs job posting: infer name/role, topic blueprint, claims to verify, and gaps to probe."""
        default_plan = ["Relevant Experience", "Core Technical Skills", "Problem Solving", "Collaboration"]
        if not self.llm:
            self.interview_plan = default_plan
            self.candidate_name = self.candidate_name or "Candidate"
            self.role_title = self.role_title or "the target position"
            return self.interview_plan

        prompt = f"""You are preparing a realistic, high-signal job interview simulation.
Compare the candidate's resume carefully against the job posting.

Candidate Resume:
---
{self.resume_text[:6000]}
---

Job Posting:
---
{self.job_description[:4000] if self.job_description else "Not provided - infer a suitable target role from the resume."}
---

Return ONLY a JSON object with this exact shape:
{{"candidate_name": "<full name from resume, or empty>",
  "role_title": "<job title from the posting (or inferred from the resume)>",
  "topics": ["<4-5 concise focus topics where the posting's requirements meet or stretch the resume>"],
  "strengths_to_verify": ["<2-3 specific projects, metrics, or skills on the resume to test for real depth>"],
  "gaps_to_probe": ["<2-3 job requirements that are missing, brief, or unverified on the resume>"]}}"""

        try:
            data = self.llm.generate_json(prompt, PLAN_SCHEMA, max_tokens=700)
            self.interview_plan = [str(t) for t in data.get("topics", [])][:5] or default_plan
            self.strengths_to_verify = [str(s) for s in data.get("strengths_to_verify", [])][:3]
            self.gaps_to_probe = [str(g) for g in data.get("gaps_to_probe", [])][:3]
            if not self.candidate_name and data.get("candidate_name"):
                self.candidate_name = data["candidate_name"]
            if not self.role_title and data.get("role_title"):
                self.role_title = data["role_title"]
        except FATAL_PROVIDER_ERRORS:
            raise
        except Exception as e:
            logger.error(f"Failed to generate interview plan: {e}")
            self.interview_plan = default_plan

        self.candidate_name = self.candidate_name or "Candidate"
        self.role_title = self.role_title or "the target position"
        return self.interview_plan

    def _build_system_prompt(self) -> str:
        plan_str = ", ".join(self.interview_plan) if self.interview_plan else "Core Skills"
        verify_str = "; ".join(self.strengths_to_verify) if self.strengths_to_verify else "Key past projects"
        gaps_str = "; ".join(self.gaps_to_probe) if self.gaps_to_probe else "Role-specific edge cases"

        stage_guidance = {
            "INTRODUCTION": "Open warmly, briefly reference their background against the role, and ask an inviting opening question.",
            "BACKGROUND_REVIEW": "Probe one specific project or achievement on their resume that matters for this role—ask about their exact contribution and measurable impact.",
            "CORE_TECHNICAL": "Test depth on a core requirement from the job posting (especially a gap or claim to verify). Press for concrete mechanisms, not buzzwords.",
            "SCENARIO_PROBLEM_SOLVING": "Present a realistic, concrete problem they would face in this exact role and ask how they would diagnose or solve it, including trade-offs.",
            "BEHAVIORAL_TEAMWORK": "Ask a behavioral question (disagreement, failure, ownership, mentoring, or ambiguity) and look for a concrete STAR example.",
            "CANDIDATE_QUESTIONS": "Wrap up questioning and invite the candidate to ask one or two questions about the role or team; answer briefly and realistically.",
            "COMPLETED": "The simulation is complete. Thank the candidate, give one crisp sentence summarizing an impression, and tell them you are compiling their full performance debrief. Do NOT ask any question.",
        }.get(self.current_stage, "")

        mode_instruction = INTERVIEW_MODES[self.mode]
        coach_rule = (
            "5. Stay in character, but since Coaching mode is active, give 1 brief sentence of constructive feedback on their previous answer before your next question."
            if self.mode == "coaching"
            else "5. Stay strictly in character as the interviewer. Do not give the candidate answers or coach them mid-interview."
        )

        return f"""You are VoxPrep, a refined, composed, and perceptive British AI interviewer running a realistic job interview SIMULATION.

Candidate: {self.candidate_name}
Position: {self.role_title}
Turn: {self.candidate_turn_count} of {self.max_turns}
Current stage: {self.current_stage} — {stage_guidance}
Interview mode: {mode_instruction}

Blueprint:
- Focus topics: {plan_str}
- Claims to verify: {verify_str}
- Gaps to probe: {gaps_str}

Candidate resume:
---
{self.resume_text[:5000]}
---

Job posting:
---
{self.job_description[:3500] if self.job_description else "Not provided."}
---

Voice & questioning rules:
1. Your output is spoken aloud via TTS. Write 2 to 4 crisp, natural spoken sentences (no markdown, no bullets, no asterisks, no emojis, no code, no URLs).
2. Keep the VoxPrep voice: calm British precision, dry wit used sparingly, addressing the candidate by first name occasionally.
3. Acknowledge something specific the candidate just said before pivoting or probing. Ask EXACTLY ONE clear question per turn (zero questions when stage is COMPLETED).
4. Never repeat a question already asked. If their last answer was vague or brief, probe once for concrete specifics or numbers; if it was solid, advance to an uncovered topic or gap.
{coach_rule}"""

    def start(self) -> str:
        """Analyze materials, then open the interview with a VoxPrep-style greeting."""
        self.touch()
        self.generate_interview_plan()
        first_name = self.candidate_name.split()[0] if self.candidate_name else "there"

        fallback = (f"Good day, {first_name}. Welcome to VoxPrep — I shall be conducting your interview for the "
                    f"{self.role_title} position. I've reviewed your resume against the brief. "
                    f"To begin, could you walk me through the work you're most proud of recently?")

        if not self.llm:
            speech = fallback
        else:
            try:
                speech = self.llm.generate_text(
                    [{"role": "user", "content": (
                        "[SYSTEM: The simulation begins now. Introduce yourself briefly as VoxPrep, note one relevant detail "
                        "you spotted between their resume and the job posting, and ask a concise opening question.]"
                    )}],
                    system=self._build_system_prompt(),
                    max_tokens=300,
                )
            except FATAL_PROVIDER_ERRORS:
                raise
            except Exception as e:
                logger.error(f"Error in start turn: {e}")
                speech = fallback

        self._add_turn("interviewer", speech)
        self.stage_idx = 1
        return speech

    def _update_stage(self):
        n = self.candidate_turn_count
        if n >= self.max_turns:
            self.stage_idx = 6  # COMPLETED
            return
        progress = n / max(self.max_turns, 1)
        self.stage_idx = next((idx for cutoff, idx in STAGE_THRESHOLDS if progress < cutoff), 5)

    def process_turn(self, candidate_speech: str) -> str:
        """Record the candidate's answer, advance stage, and generate VoxPrep's next line."""
        self.touch()
        self._add_turn("candidate", candidate_speech)
        self._update_stage()

        if not self.llm:
            reply = ("Noted. Could you walk me through the specific trade-offs you weighed there?"
                     if not self.is_complete else
                     "Thank you. That concludes our simulation. I am now compiling your performance analysis.")
            self._add_turn("interviewer", reply)
            return reply

        history = [{"role": "assistant" if t["role"] == "interviewer" else "user", "content": t["text"]}
                   for t in self.turns]
        if history and history[0]["role"] == "assistant":
            history.insert(0, {"role": "user", "content": "[SYSTEM: The interview simulation is in progress.]"})

        try:
            reply = self.llm.generate_text(history, system=self._build_system_prompt(), max_tokens=350)
        except FATAL_PROVIDER_ERRORS:
            raise
        except Exception as e:
            logger.error(f"Error processing turn: {e}")
            reply = "My apologies, a momentary glitch in my systems. Could you elaborate on that last point with a concrete example?"

        self._add_turn("interviewer", reply)
        if self.is_complete:
            self.is_active = False
        return reply


# Session Registry (strictly in-memory)
_active_sessions: Dict[str, InterviewSession] = {}


def cleanup_expired_sessions() -> None:
    """Purge inactive sessions beyond TTL and enforce an in-memory session cap."""
    now = time.monotonic()
    expired = [
        sid for sid, sess in _active_sessions.items()
        if (now - sess.last_activity) > SESSION_TTL_SECONDS
    ]
    for sid in expired:
        remove_session(sid)

    while len(_active_sessions) >= MAX_ACTIVE_SESSIONS:
        oldest_sid = min(_active_sessions, key=lambda sid: _active_sessions[sid].last_activity)
        remove_session(oldest_sid)


def create_session(
    candidate_name: str,
    role_title: str,
    resume_text: str,
    job_description: str,
    model: str = CLAUDE_MODEL,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    mode: str = "standard",
    max_turns: int = MAX_CANDIDATE_TURNS,
) -> InterviewSession:
    cleanup_expired_sessions()
    sess_id = secrets.token_urlsafe(18)
    session = InterviewSession(
        session_id=sess_id,
        candidate_name=candidate_name,
        role_title=role_title,
        resume_text=resume_text,
        job_description=job_description,
        model=model,
        api_key=api_key,
        base_url=base_url,
        mode=mode,
        max_turns=max_turns,
    )
    _active_sessions[sess_id] = session
    return session


def get_session(session_id: str) -> Optional[InterviewSession]:
    cleanup_expired_sessions()
    return _active_sessions.get(session_id)


def verify_session_secret(session: Optional[InterviewSession], token: Optional[str]) -> bool:
    if not session or not token:
        return False
    return hmac.compare_digest(session.session_secret, token.strip())


def remove_session(session_id: str) -> None:
    """Purge a completed session, credentials, resume, and transcript from memory."""
    session = _active_sessions.pop(session_id, None)
    if session:
        session.is_active = False
        session.api_key = ""
        session.session_secret = ""
        session.resume_text = ""
        session.job_description = ""
        session.turns.clear()
        session.llm = None
