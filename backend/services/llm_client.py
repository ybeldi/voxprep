import ipaddress
import json
import logging
import socket
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse
import anthropic
import openai

from backend.config import CLAUDE_EFFORT

logger = logging.getLogger(__name__)

ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com"
OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"
GEMINI_DEFAULT_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"

BLOCKED_HOSTNAMES = {"localhost", "localhost.localdomain", "metadata.google.internal"}


def validate_base_url(base_url: Optional[str]) -> str:
    """Validate optional custom API base_url: HTTPS only and reject local/private/metadata targets."""
    url = (base_url or "").strip()
    if not url:
        return ""
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError("Custom Base URL must use https://.")
    if parsed.username or parsed.password:
        raise ValueError("Custom Base URL must not include embedded credentials.")
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if not host:
        raise ValueError("Custom Base URL is missing a valid hostname.")
    if host in BLOCKED_HOSTNAMES or host.endswith((".localhost", ".local", ".internal")):
        raise ValueError("Custom Base URL cannot point to a local or internal host.")

    def _check_ip(raw_ip: str):
        ip = ipaddress.ip_address(raw_ip)
        if not ip.is_global:
            raise ValueError("Custom Base URL cannot resolve to a private, loopback, or link-local IP.")

    try:
        _check_ip(host)
    except ValueError as e:
        if "private, loopback" in str(e):
            raise
        # Hostname rather than IP literal — resolve DNS if online and check returned IPs
        try:
            infos = socket.getaddrinfo(host, parsed.port or 443, type=socket.SOCK_STREAM)
        except socket.gaierror:
            infos = []
        for info in infos:
            _check_ip(info[4][0].split("%")[0])
    return url


def summarize_provider_error(exc: Exception) -> str:
    """Return a concise user-facing error without leaking upstream headers or internal URLs."""
    if isinstance(exc, ValueError):
        return str(exc)
    if isinstance(exc, (anthropic.AuthenticationError, openai.AuthenticationError)):
        return "Authentication failed — check your API token."
    if isinstance(exc, (anthropic.PermissionDeniedError, openai.PermissionDeniedError)):
        return "Permission denied for this model or API endpoint."
    if isinstance(exc, (anthropic.NotFoundError, openai.NotFoundError)):
        return "Model or endpoint not found — verify the model ID and Base URL."
    if isinstance(exc, (anthropic.RateLimitError, openai.RateLimitError)):
        return "Rate limit or quota exceeded on your API key."
    if isinstance(exc, (anthropic.APIConnectionError, openai.APIConnectionError)):
        return "Could not connect to the model API endpoint."
    if isinstance(exc, (anthropic.BadRequestError, openai.BadRequestError)):
        return "The provider rejected the request parameters or model ID."
    return "Upstream AI service error. Verify your model, token, and Base URL."


def detect_provider(model: str) -> str:
    m = (model or "").strip().lower()
    if m.startswith("claude"):
        return "anthropic"
    if m.startswith("gemini"):
        return "gemini"
    return "openai"


def _extract_json_object(raw: str) -> Dict[str, Any]:
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError("Model response did not contain a JSON object.")
    return json.loads(raw[start:end + 1])


def _anthropic_text(res) -> str:
    return "".join(b.text for b in res.content if b.type == "text").strip()


class LLMClient:
    """Unified wrapper across Anthropic (Claude), OpenAI (GPT), and Google (Gemini)."""

    def __init__(self, model: str, api_key: str, base_url: Optional[str] = None):
        self.model = (model or "").strip()
        self.api_key = (api_key or "").strip()
        self.base_url = validate_base_url(base_url)
        if not self.model:
            raise ValueError("Model ID is required.")
        if not self.api_key:
            raise ValueError("API token is required.")
        self.provider = detect_provider(self.model)

        if self.provider == "anthropic":
            self._client = anthropic.Anthropic(
                api_key=self.api_key,
                base_url=self.base_url or ANTHROPIC_DEFAULT_BASE_URL,
            )
        else:
            effective_url = self.base_url or (
                GEMINI_DEFAULT_OPENAI_BASE_URL if self.provider == "gemini" else OPENAI_DEFAULT_BASE_URL
            )
            self._client = openai.OpenAI(
                api_key=self.api_key,
                base_url=effective_url,
            )

    def _anthropic_call(
        self,
        messages: List[Dict[str, str]],
        max_tokens: int,
        system: str = "",
        schema: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Invoke Anthropic beta messages with effort/schema, falling back to standard messages."""
        kwargs: Dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_tokens,
            "messages": messages,
        }
        if system:
            kwargs["system"] = system
        output_config: Dict[str, Any] = {"effort": CLAUDE_EFFORT}
        if schema:
            output_config["format"] = {"type": "json_schema", "schema": schema}

        try:
            res = self._client.beta.messages.create(**kwargs, output_config=output_config)
            return _anthropic_text(res)
        except (anthropic.BadRequestError, TypeError):
            if schema and messages:
                fallback_msgs = list(messages)
                last = dict(fallback_msgs[-1])
                last["content"] = (
                    f"{last['content']}\n\nReturn ONLY a valid JSON object matching this schema:\n"
                    f"{json.dumps(schema)}"
                )
                fallback_msgs[-1] = last
                kwargs["messages"] = fallback_msgs
            res = self._client.messages.create(**kwargs)
            return _anthropic_text(res)

    def generate_text(
        self,
        messages: List[Dict[str, str]],
        system: str = "",
        max_tokens: int = 350,
    ) -> str:
        if self.provider == "anthropic":
            return self._anthropic_call(messages, max_tokens=max_tokens, system=system)

        full_messages = ([{"role": "system", "content": system}] if system else []) + messages
        return self._openai_chat(full_messages, max_tokens=max_tokens)

    def generate_json(
        self,
        prompt: str,
        schema: Dict[str, Any],
        max_tokens: int = 2500,
    ) -> Dict[str, Any]:
        messages = [{"role": "user", "content": prompt}]
        if self.provider == "anthropic":
            return _extract_json_object(self._anthropic_call(messages, max_tokens=max_tokens, schema=schema))

        try:
            raw = self._openai_chat(
                messages,
                max_tokens=max_tokens,
                response_format={
                    "type": "json_schema",
                    "json_schema": {"name": "response", "schema": schema},
                },
            )
            return _extract_json_object(raw)
        except (openai.BadRequestError, ValueError):
            raw = self._openai_chat(
                [{
                    "role": "user",
                    "content": f"{prompt}\n\nReturn ONLY a valid JSON object matching this schema:\n{json.dumps(schema)}",
                }],
                max_tokens=max_tokens,
                response_format={"type": "json_object"},
            )
            return _extract_json_object(raw)

    def _openai_chat(
        self,
        messages: List[Dict[str, str]],
        max_tokens: int,
        response_format: Optional[Dict[str, Any]] = None,
    ) -> str:
        kwargs: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens,
        }
        if response_format:
            kwargs["response_format"] = response_format

        for _ in range(3):
            try:
                res = self._client.chat.completions.create(**kwargs)
                return (res.choices[0].message.content or "").strip()
            except openai.BadRequestError as e:
                err_msg = str(e)
                if "max_completion_tokens" in err_msg and "max_tokens" in kwargs:
                    kwargs.pop("max_tokens", None)
                    kwargs["max_completion_tokens"] = max_tokens
                elif "response_format" in kwargs and "response_format" in err_msg.lower():
                    kwargs.pop("response_format", None)
                else:
                    raise
        res = self._client.chat.completions.create(**kwargs)
        return (res.choices[0].message.content or "").strip()
