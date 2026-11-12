# VoxPrep — AI Voice Interview Simulator

> Upload your **resume** and a **job posting**, choose your AI model and interview style, and run a hands-free **voice interview simulation** powered by a live voice-reactive reactor HUD and an evidence-based performance debrief.

Supports **Anthropic Claude** (Sonnet 5.5, Haiku 5.5), **OpenAI GPT-6** (`gpt-6-sol`, `gpt-6-astra`), **Google Gemini 3.8 Flash**, or any **custom model ID** with an optional `https://` Base URL gateway.

---

## How It Works

1. **Setup** — Upload your resume (PDF, TXT, or MD) or paste it, add the job description, choose your model, interview style (**Realistic Panel**, **Bar Raiser**, or **Practice Coach**), length (`6` / `10` / `14` turns), and enter your API token.
2. **Blueprint** — VoxPrep compares your resume against the posting to identify target topics, claims to verify, and gaps to probe.
3. **Live Voice Interview** — VoxPrep speaks using **HD Neural Voice** (`edge-tts`, default `en-GB-RyanNeural`) while the reactor animates to its waveform. When it finishes, auto-listen activates in amber and captures your spoken response (or press **Space** / use the **⌨** keyboard toggle).
4. **Debrief** — Receive an overall score, hire recommendation, 5-category ratings, transcript-grounded strengths, concrete framing rewrites, follow-up prep questions, and a collapsible transcript review.

**Zero Persistence:** Nothing is saved to disk, a database, `localStorage`, or `sessionStorage`. Closing or refreshing the tab clears your resume, token, transcript, and report.

---

## Architecture

```
voice-interviewer/
├── backend/
│   ├── main.py                  # FastAPI: REST + authenticated WebSocket + security headers
│   ├── config.py                # Env settings, CORS origins, TTL & size caps
│   └── services/
│       ├── llm_client.py        # Multi-provider LLM client + Base URL SSRF validator
│       ├── interview_engine.py  # Stage pacing, interview modes, ephemeral session store
│       ├── scorecard.py         # Structured JSON scorecard generation
│       ├── resume_loader.py     # In-memory PDF/TXT/MD parsing
│       └── audio_service.py     # HD Neural TTS (edge-tts) & optional OpenAI tts-1-hd
├── frontend/
│   ├── index.html
│   ├── config.js                # Split-hosting backend URL for Vercel deployment
│   ├── vercel.json              # Security headers & CSP for Vercel static hosting
│   ├── reactor.js               # Voice-reactive Canvas HUD renderer
│   ├── app.js                   # Web Speech input, audio pipeline, UI state
│   └── style.css                # HUD styling
├── render.yaml                  # One-click Render backend blueprint
├── requirements.txt
└── run.sh
```

---

## Local Development

```bash
cp .env.example .env
./run.sh
```

Open **http://127.0.0.1:8000** in **Chrome or Edge** and allow microphone access.

---

## Deploying Split Hosting (Vercel Frontend + Render Backend)

Because VoxPrep uses live WebSockets (`/ws/interview/{id}`) and ephemeral in-memory sessions, deploy the backend on **Render** and the static UI on **Vercel**:

1. **Deploy Backend on Render:**
   - Connect your repo to Render (auto-configured by `render.yaml`, or set Build Command `pip install -r requirements.txt` and Start Command `uvicorn backend.main:app --host 0.0.0.0 --port $PORT --proxy-headers`).
   - **Without GitHub:** Build and push `Dockerfile` to Docker Hub (`docker build --platform linux/amd64 -t <user>/voxprep-api:latest . && docker push <user>/voxprep-api:latest`), then create a Render Web Service using **Existing Image**.
   - Note your Render URL, e.g. `https://voxprep-api.onrender.com`.
2. **Configure Frontend for Vercel:**
   - Set `window.VOXPREP_API_BASE = 'https://voxprep-api.onrender.com';` inside [`frontend/config.js`](frontend/config.js).
   - Deploy `frontend/` as the **Root Directory** on Vercel (or directly via CLI without GitHub: `npx vercel --prod frontend`).
3. **Link CORS & WebSocket Origin:**
   - On Render, set environment variable `ALLOWED_ORIGINS=https://your-app.vercel.app` (no trailing slash).
