import logging
from typing import Dict, Any

from backend.services.llm_client import LLMClient

logger = logging.getLogger(__name__)

SCORECARD_SCHEMA = {
    "type": "object",
    "properties": {
        "candidate_name": {"type": "string"},
        "role_title": {"type": "string"},
        "overall_score": {"type": "integer", "description": "Score out of 100"},
        "recommendation": {
            "type": "string",
            "enum": ["Strong Hire", "Hire", "Lean Hire", "Lean No Hire", "No Hire"]
        },
        "category_scores": {
            "type": "object",
            "properties": {
                "role_expertise": {"type": "number", "description": "Score out of 10: technical/domain knowledge required by the job posting"},
                "experience_relevance": {"type": "number", "description": "Score out of 10: how convincingly past experience maps to the role"},
                "problem_solving": {"type": "number", "description": "Score out of 10"},
                "communication": {"type": "number", "description": "Score out of 10: clarity, structure, conciseness"},
                "behavioral_fit": {"type": "number", "description": "Score out of 10: teamwork, ownership, STAR answers"}
            },
            "required": ["role_expertise", "experience_relevance", "problem_solving", "communication", "behavioral_fit"]
        },
        "key_strengths": {
            "type": "array",
            "items": {"type": "string"},
            "description": "3-4 specific strengths demonstrated in the interview"
        },
        "areas_for_improvement": {
            "type": "array",
            "items": {"type": "string"},
            "description": "2-4 actionable coaching tips: what was weak and how to answer better next time"
        },
        "executive_summary": {
            "type": "string",
            "description": "1-2 paragraph assessment, addressed to the candidate, of how they would likely fare in the real interview"
        },
        "recommended_follow_ups": {
            "type": "array",
            "items": {"type": "string"},
            "description": "3 questions the candidate should prepare for before the real interview"
        }
    },
    "required": ["candidate_name", "role_title", "overall_score", "recommendation", "category_scores",
                 "key_strengths", "areas_for_improvement", "executive_summary", "recommended_follow_ups"]
}


def _fallback_scorecard(session, error: Exception) -> Dict[str, Any]:
    return {
        "candidate_name": session.candidate_name,
        "role_title": session.role_title,
        "overall_score": 0,
        "recommendation": "Lean No Hire",
        "category_scores": {
            "role_expertise": 0,
            "experience_relevance": 0,
            "problem_solving": 0,
            "communication": 0,
            "behavioral_fit": 0,
        },
        "key_strengths": [],
        "areas_for_improvement": [],
        "executive_summary": f"Analysis could not be completed: {error}",
        "recommended_follow_ups": [],
    }


def generate_interview_scorecard(session) -> Dict[str, Any]:
    """Generate a rigorous, evidence-based evaluation report of the simulated interview."""
    llm = session.llm
    if not llm:
        if not session.api_key:
            raise ValueError("API token required to generate interview scorecard.")
        llm = LLMClient(session.model, session.api_key, session.base_url)

    transcript_lines = []
    for t in session.turns:
        speaker = "VoxPrep (Interviewer)" if t["role"] == "interviewer" else f"{session.candidate_name} (Candidate)"
        transcript_lines.append(f"[{t['stage']}] {speaker}: {t['text']}")
    full_transcript = "\n\n".join(transcript_lines)

    prompt = f"""You are a seasoned hiring manager reviewing a practice interview simulation.
Evaluate the candidate objectively for the role of {session.role_title}.

Candidate: {session.candidate_name}
Interview Mode: {session.mode}
Planned Focus Topics: {", ".join(session.interview_plan)}
Gaps Flagged to Probe: {", ".join(session.gaps_to_probe) or "None"}

Candidate Resume:
---
{session.resume_text[:4000]}
---

Job Posting:
---
{session.job_description[:3000] if session.job_description else "Not provided."}
---

Full Interview Transcript:
========================================
{full_transcript}
========================================

Evaluation rules:
1. Ground every strength and coaching point in specific answers or quotes from the transcript—never give generic praise.
2. Note how well the candidate addressed the role's key requirements and any gaps from their resume.
3. If the candidate gave few or very short/evasive answers, score strictly and explain why.
4. For areas_for_improvement, give concrete rewrites or framing advice ("When asked about X, mention Y metric/trade-off").
Return a JSON object matching the required schema."""

    try:
        data = llm.generate_json(prompt, SCORECARD_SCHEMA, max_tokens=2500)
    except Exception as e:
        logger.error(f"Scorecard generation error: {e}")
        data = _fallback_scorecard(session, e)

    data["session_id"] = session.session_id
    data["model"] = session.model
    data["mode"] = session.mode
    data["max_turns"] = session.max_turns
    data["turn_count"] = len(session.turns)
    data["transcript"] = session.turns

    return data
