// VoxPrep — AI Voice Interview Simulator (frontend logic)
// Flow: resume + job post  ->  boot sequence  ->  hands-free voice interview  ->  debrief report

const $ = (id) => document.getElementById(id);
const API_BASE = (window.VOXPREP_API_BASE || '').trim().replace(/\/+$/, '');
const apiUrl = (path) => `${API_BASE}${path}`;
function wsUrl(path) {
  if (API_BASE) return `${API_BASE.replace(/^http/i, 'ws')}${path}`;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}

const S = {
  status: { has_anthropic_key: false, has_openai_audio_key: false, has_neural_tts: false },
  sessionId: null,
  sessionToken: null,
  ws: null,
  pendingSend: null,
  uiState: 'idle',
  voices: [],
  lastLine: '',
  ttsToken: 0,
  currentAudio: null,
  currentSource: null,
  utterances: [],
  complete: false,
  finishing: false,
  startTime: 0,
  // audio graph
  audioCtx: null,
  micAnalyser: null,
  ttsAnalyser: null,
  freq: new Uint8Array(128),
  wave: new Uint8Array(256),
  micLevel: 0,
  synthBoost: 0,
  synthActive: false,
  // speech recognition
  recognition: null,
  listening: false,
  committed: '',
  sessionFinal: '',
  interim: '',
  silenceTimer: null,
  // ephemeral session-only memory (never written to localStorage or disk)
  creds: { anthropic: { token: '', baseUrl: '' }, openai: { token: '', baseUrl: '' }, gemini: { token: '', baseUrl: '' } },
  lastReport: null,
};

const SILENCE_MS = 3000;

// ---------------------------------------------------------------------------
// Reactors
// ---------------------------------------------------------------------------
const brandReactor = new Reactor($('brand-reactor'), { mini: true });
const bootReactor = new Reactor($('boot-reactor'));
const mainReactor = new Reactor($('main-reactor'));
[brandReactor, bootReactor, mainReactor].forEach((r) => r.setSource(levelSource));

function analyserLevel(an) {
  an.getByteFrequencyData(S.freq);
  an.getByteTimeDomainData(S.wave);
  let sum = 0;
  for (let i = 0; i < S.wave.length; i++) { const v = (S.wave[i] - 128) / 128; sum += v * v; }
  const rms = Math.sqrt(sum / S.wave.length);
  return { rms, level: Math.min(1, rms * 5), bins: S.freq };
}

// Feeds the reactor animation each frame
function levelSource() {
  if (S.uiState === 'listening' && S.micAnalyser) {
    const r = analyserLevel(S.micAnalyser);
    S.micLevel = r.rms;
    const meter = $('mic-meter');
    if (meter) meter.style.width = `${Math.round(r.level * 100)}%`;
    return r;
  }
  const meter = $('mic-meter');
  if (meter && meter.style.width !== '0%') meter.style.width = '0%';
  if (S.uiState === 'speaking') {
    if (S.ttsAnalyser && (S.currentSource || S.currentAudio)) return analyserLevel(S.ttsAnalyser);
    // Browser TTS exposes no audio stream: synthesize a voice-like envelope, kicked by word-boundary events
    const t = performance.now() / 1000;
    S.synthBoost *= 0.9;
    if (!S.synthActive) return { level: 0.08 + S.synthBoost * 0.3 };
    const base = 0.3 + 0.2 * Math.abs(Math.sin(t * 10.5) * Math.sin(t * 3.3)) + Math.random() * 0.12;
    return { level: Math.min(1, base + S.synthBoost) };
  }
  return null;
}

function setUiState(state) {
  S.uiState = state;
  mainReactor.setState(state);
  brandReactor.setState(state);
  bootReactor.setState(state === 'idle' ? 'thinking' : state);
  const label = $('state-label');
  label.textContent = { idle: 'STANDBY', thinking: 'PROCESSING', speaking: 'VOXPREP SPEAKING', listening: 'LISTENING' }[state];
  label.classList.toggle('listening', state === 'listening');
  $('btn-mic').classList.toggle('live', state === 'listening');
  $('btn-mic').disabled = state === 'thinking';
  const hint = $('mic-hint');
  if (state === 'listening') {
    hint.textContent = $('auto-listen').checked ? 'Pause 3s to send · SPACE to send now' : 'SPACE or mic to send';
  } else if (state === 'speaking') {
    hint.textContent = 'SPACE to interrupt and answer';
  } else if (state === 'thinking') {
    hint.textContent = 'VoxPrep is processing…';
  } else {
    hint.textContent = 'Press SPACE or the mic to answer';
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  onModelChange();
  updateWordCounts();

  loadStatus();
  initVoices();
  initDropzone();
  initRecognition();
  setInterval(tickClock, 1000);
  tickClock();
  setUiState('idle');

  $('model-select').addEventListener('change', () => { clearSetupError(); onModelChange(); });
  $('custom-model').addEventListener('input', () => { clearSetupError(); syncModelPlaceholders(); });
  $('api-token').addEventListener('input', () => { clearSetupError(); saveInMemoryCreds(); });
  $('base-url').addEventListener('input', saveInMemoryCreds);
  $('btn-toggle-token').addEventListener('click', toggleTokenVisibility);
  $('resume-text').addEventListener('input', () => { clearSetupError(); updateWordCounts(); });
  $('job-description').addEventListener('input', () => { clearSetupError(); updateWordCounts(); });
  $('btn-engage').addEventListener('click', engage);
  $('audio-mode').addEventListener('change', refreshVoiceSelect);
  $('btn-mic').addEventListener('click', toggleMic);
  $('btn-replay').addEventListener('click', () => S.lastLine && speak(S.lastLine));
  $('btn-keyboard').addEventListener('click', () => {
    $('type-form').classList.toggle('hidden');
    if (!$('type-form').classList.contains('hidden')) $('type-input').focus();
  });
  $('type-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('type-input').value.trim();
    if (!text || S.uiState === 'thinking') return;
    $('type-input').value = '';
    interruptSpeech();
    stopListening();
    sendAnswer(text);
  });
  $('btn-test-voice').addEventListener('click', previewVoice);
  const endDialog = $('end-confirm-dialog');
  $('btn-end').addEventListener('click', () => {
    if (!S.finishing && endDialog && typeof endDialog.showModal === 'function') endDialog.showModal();
    else finishInterview();
  });
  if (endDialog) {
    endDialog.addEventListener('close', () => {
      const action = endDialog.returnValue;
      endDialog.returnValue = '';
      if (action === 'confirm') finishInterview();
    });
  }
  $('btn-download').addEventListener('click', downloadReport);
  $('btn-print').addEventListener('click', () => window.print());
  $('btn-restart').addEventListener('click', resetAll);

  document.addEventListener('keydown', (e) => {
    if (!$('interview-screen').classList.contains('active')) return;
    if (endDialog && endDialog.open) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
    if (e.code === 'Space') { e.preventDefault(); toggleMic(); }
    if (e.code === 'Escape' && S.listening) { stopListening(); setUiState('idle'); }
  });
});

function selectedModel() {
  const sel = $('model-select').value;
  return sel === 'custom' ? $('custom-model').value.trim() : sel;
}

function modelProvider(model) {
  const m = (model || '').toLowerCase();
  if (m.startsWith('claude')) return 'anthropic';
  if (m.startsWith('gemini')) return 'gemini';
  return 'openai';
}

function syncModelPlaceholders() {
  const p = modelProvider(selectedModel());
  const defaults = {
    anthropic: 'Optional — blank uses https://api.anthropic.com',
    openai: 'Optional — blank uses https://api.openai.com/v1',
    gemini: 'Optional — blank uses Google Gemini default API',
  };
  const tokHints = {
    anthropic: 'Required — Anthropic or gateway token',
    openai: 'Required — OpenAI or gateway token',
    gemini: 'Required — Google AI Studio (AIza…) or gateway token',
  };
  $('base-url').placeholder = defaults[p];
  $('api-token').placeholder = tokHints[p];
}

function countWords(s) {
  return (s || '').trim().split(/\s+/).filter(Boolean).length;
}

function updateWordCounts() {
  const rw = countWords($('resume-text').value);
  const jw = countWords($('job-description').value);
  const rb = $('resume-words');
  const jb = $('jd-words');
  rb.textContent = `${rw} WORDS`;
  jb.textContent = `${jw} WORDS`;
  rb.classList.toggle('ready', rw > 15);
  jb.classList.toggle('ready', jw > 15);
}

function toggleTokenVisibility() {
  const inp = $('api-token');
  const btn = $('btn-toggle-token');
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.textContent = show ? 'HIDE' : 'SHOW';
  btn.setAttribute('aria-pressed', String(show));
  btn.setAttribute('aria-label', show ? 'Hide API token' : 'Show API token');
}

function saveInMemoryCreds() {
  const p = modelProvider(selectedModel());
  S.creds[p] = { token: $('api-token').value, baseUrl: $('base-url').value };
}

function onModelChange() {
  const isCustom = $('model-select').value === 'custom';
  $('custom-model').classList.toggle('hidden', !isCustom);
  if (isCustom && !$('custom-model').value) $('custom-model').focus();
  const p = modelProvider(selectedModel());
  const c = S.creds[p] || { token: '', baseUrl: '' };
  $('api-token').value = c.token;
  $('base-url').value = c.baseUrl;
  syncModelPlaceholders();
}

function setConnectionStatus(text, ok = true) {
  const link = $('hud-link');
  link.textContent = text;
  link.className = ok ? 'link-ok' : 'link-bad';
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function loadStatus() {
  const maxAttempts = API_BASE ? 6 : 1;
  if (API_BASE) setConnectionStatus('● WAKING BACKEND…', true);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchWithTimeout(apiUrl('/api/status'), {}, 12000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      S.status = await res.json();
      if (S.status.has_neural_tts) $('audio-mode').value = 'neural';
      else if (S.status.has_openai_audio_key) $('audio-mode').value = 'openai';
      else $('audio-mode').value = 'browser';
      refreshVoiceSelect();
      setConnectionStatus('● SYSTEMS ONLINE', true);
      return;
    } catch {
      if (attempt < maxAttempts) {
        setConnectionStatus(`● WAKING BACKEND (${attempt}/${maxAttempts})…`, true);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  setConnectionStatus('● SERVER OFFLINE', false);
}

function tickClock() {
  $('hud-clock').textContent = new Date().toLocaleTimeString([], { hour12: false });
  if (S.startTime) {
    const s = Math.floor((Date.now() - S.startTime) / 1000);
    $('elapsed').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
}

const NEURAL_VOICES = [
  { id: 'en-GB-RyanNeural', label: 'Ryan — British Male (Smooth, Studio)' },
  { id: 'en-GB-ThomasNeural', label: 'Thomas — British Male (Calm)' },
  { id: 'en-US-AndrewMultilingualNeural', label: 'Andrew — Warm Natural Male' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia — British Female' },
];
const OPENAI_VOICES = [
  { id: 'onyx', label: 'Onyx — Deep Smooth Male (HD)' },
  { id: 'fable', label: 'Fable — British Expressive (HD)' },
  { id: 'echo', label: 'Echo — Warm Male (HD)' },
  { id: 'alloy', label: 'Alloy — Balanced (HD)' },
];

function refreshVoiceSelect() {
  const mode = $('audio-mode').value;
  const sel = $('voice-select');
  const current = sel.value;
  sel.innerHTML = '';

  if (mode === 'neural' || mode === 'openai') {
    const list = mode === 'neural' ? NEURAL_VOICES : OPENAI_VOICES;
    list.forEach((v) => {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.label;
      sel.appendChild(o);
    });
    if (list.some((v) => v.id === current)) sel.value = current;
    return;
  }

  const preferred = ['Microsoft Ryan', 'Microsoft Libby', 'Google UK English Male', 'Google UK English Female', 'Google US English', 'Arthur', 'Oliver', 'Daniel'];
  const en = S.voices.filter((v) => v.lang.startsWith('en'));
  en.sort((a, b) => {
    const aNat = /Natural|Google|Premium|Enhanced/i.test(a.name) ? 1 : 0;
    const bNat = /Natural|Google|Premium|Enhanced/i.test(b.name) ? 1 : 0;
    if (bNat !== aNat) return bNat - aNat;
    return (b.lang === 'en-GB') - (a.lang === 'en-GB');
  });
  en.forEach((v) => {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = `${v.name} (${v.lang})`;
    sel.appendChild(o);
  });
  const pick = (en.some((v) => v.name === current) && current) ||
    (preferred.map((p) => en.find((v) => v.name.includes(p))).find(Boolean) || en[0] || {}).name;
  if (pick) sel.value = pick;
}

function initVoices() {
  refreshVoiceSelect();
  if (!('speechSynthesis' in window)) return;
  const update = () => {
    S.voices = speechSynthesis.getVoices();
    if ($('audio-mode').value === 'browser') refreshVoiceSelect();
  };
  update();
  speechSynthesis.onvoiceschanged = update;
}

function initDropzone() {
  const dz = $('dropzone');
  $('resume-file').addEventListener('change', (e) => e.target.files[0] && parseResume(e.target.files[0]));
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => e.dataTransfer.files[0] && parseResume(e.dataTransfer.files[0]));
}

async function parseResume(file) {
  $('dz-file').textContent = 'PARSING…';
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch(apiUrl('/api/parse-resume'), { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Parse failed');
    $('resume-text').value = data.text;
    if (!$('candidate-name').value && data.candidate_name) $('candidate-name').value = data.candidate_name;
    $('dz-file').textContent = `✓ ${data.file_name}`;
    updateWordCounts();
  } catch (err) {
    $('dz-file').textContent = '';
    showSetupError('Could not read resume: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Audio graph
// ---------------------------------------------------------------------------
async function initAudio() {
  if (!S.audioCtx) S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (S.audioCtx.state === 'suspended') await S.audioCtx.resume();
  if (S.micAnalyser) return true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const src = S.audioCtx.createMediaStreamSource(stream);
    S.micAnalyser = S.audioCtx.createAnalyser();
    S.micAnalyser.fftSize = 256;
    S.micAnalyser.smoothingTimeConstant = 0.7;
    src.connect(S.micAnalyser);
    return true;
  } catch (err) {
    console.warn('Microphone unavailable:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Engage: boot sequence + session start
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bootLine(text) {
  const div = document.createElement('div');
  div.textContent = text;
  $('boot-log').appendChild(div);
  return div;
}

const MODE_LABELS = { standard: 'Panel', strict: 'Bar Raiser', coaching: 'Coach' };

function showSetupError(msg) {
  const el = $('setup-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearSetupError() {
  const el = $('setup-error');
  if (el) el.classList.add('hidden');
}

async function engage() {
  clearSetupError();
  interruptSpeech();
  const resume = $('resume-text').value.trim();
  const jd = $('job-description').value.trim();
  const model = selectedModel();
  const apiToken = $('api-token').value.trim();
  const baseUrl = $('base-url').value.trim();
  if (!resume) { $('resume-text').focus(); return showSetupError('Please upload or paste your resume.'); }
  if (!jd) { $('job-description').focus(); return showSetupError('Please paste the job description.'); }
  if (!model) { $('custom-model').focus(); return showSetupError('Please enter a model ID.'); }
  if (!apiToken) { $('api-token').focus(); return showSetupError('API Token is mandatory. Please enter your token.'); }
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'https:') throw new Error('Custom Base URL must start with https://.');
    } catch (e) {
      $('base-url').focus();
      return showSetupError(e.message && e.message.startsWith('Custom Base URL') ? e.message : 'Invalid Base URL (expected https://...).');
    }
  }
  saveInMemoryCreds();

  $('btn-engage').disabled = true;
  const micOk = await initAudio();
  // Prime speech synthesis inside the user gesture (required by some browsers)
  if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(''));

  $('boot-log').innerHTML = '';
  $('boot-progress').style.width = '5%';
  $('boot-overlay').classList.add('active');
  setUiState('thinking');

  const request = fetch(apiUrl('/api/session/start'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resume_text: resume,
      job_description: jd,
      model,
      api_key: apiToken,
      base_url: baseUrl,
      mode: $('interview-mode').value,
      max_turns: parseInt($('max-turns').value, 10) || 10,
      candidate_name: $('candidate-name').value.trim(),
      role_title: $('role-title').value.trim(),
    }),
  }).then(async (res) => {
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to start interview');
    return data;
  });

  const steps = [
    'Initializing VoxPrep interview protocol',
    `Engaging neural core — ${model}${baseUrl ? ' (custom endpoint)' : ' (default API)'}`,
    `Parsing subject dossier — ${countWords(resume)} words`,
    `Decrypting mission brief — ${countWords(jd)} words`,
    `Audio subsystems — ${micOk ? 'microphone linked' : 'microphone unavailable, keyboard mode'}`,
    'Cross-referencing competencies against requirements',
  ];
  try {
    for (let i = 0; i < steps.length; i++) {
      bootLine(steps[i]).classList.add('ok');
      $('boot-progress').style.width = `${Math.round(((i + 1) / (steps.length + 2)) * 100)}%`;
      await sleep(380);
    }
    const pending = bootLine('Synthesizing interview blueprint');
    const data = await request;
    pending.classList.add('ok');
    $('boot-progress').style.width = '92%';
    bootLine(`Subject identified: ${data.candidate_name} — ${data.role_title}`).classList.add('ok');
    await sleep(420);
    $('boot-progress').style.width = '100%';
    bootLine('All systems nominal. Engaging.');
    await sleep(600);
    enterInterview(data, micOk);
  } catch (err) {
    bootLine(`ERROR: ${err.message}`);
    await sleep(1600);
    $('boot-overlay').classList.remove('active');
    setUiState('idle');
    showSetupError(`Could not start interview: ${err.message}`);
  } finally {
    $('btn-engage').disabled = false;
  }
}

function enterInterview(data, micOk) {
  S.sessionId = data.session_id;
  S.sessionToken = data.session_token || null;
  S.complete = false;
  S.finishing = false;
  S.startTime = Date.now();
  $('hud-session').textContent = `SESSION: ${data.session_id.slice(0, 8).toUpperCase()}`;
  $('live-name').textContent = data.candidate_name;
  $('live-role').textContent = data.role_title;
  const modeTag = MODE_LABELS[data.mode] || data.mode || 'Panel';
  $('live-model').textContent = `${(data.model || selectedModel()).toUpperCase()} · ${modeTag.toUpperCase()}`;
  updateTurnProgress(0, data.max_turns || parseInt($('max-turns').value, 10) || 10);
  $('topics').innerHTML = '';
  (data.plan || []).forEach((t) => {
    const s = document.createElement('span');
    s.textContent = t;
    $('topics').appendChild(s);
  });
  $('log').innerHTML = '';
  $('turn-count').textContent = '0';
  updateStage(data.stage);
  if (!micOk || !S.recognition) $('type-form').classList.remove('hidden');

  $('boot-overlay').classList.remove('active');
  $('setup-screen').classList.remove('active');
  $('interview-screen').classList.add('active');

  connectWs();
  appendLog('jarvis', data.opening_turn);
  speak(data.opening_turn);
}

function updateTurnProgress(done, total) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  $('turn-progress-label').textContent = `${done} / ${total}`;
  $('turn-progress-fill').style.width = `${pct}%`;
}

function updateStage(stage) {
  const items = [...$('stage-list').querySelectorAll('li')];
  const idx = items.findIndex((li) => li.dataset.stage === stage);
  items.forEach((li, i) => {
    li.classList.toggle('active', i === idx);
    li.classList.toggle('done', i < idx);
  });
}

function buildMessageNode(speaker, meta, text, isUser) {
  const div = document.createElement('div');
  div.className = `msg ${isUser ? 'user' : ''}`;
  const whoEl = document.createElement('div');
  whoEl.className = 'who';
  whoEl.appendChild(document.createTextNode(speaker));
  const span = document.createElement('span');
  span.textContent = meta || '';
  whoEl.appendChild(span);
  const body = document.createElement('div');
  body.textContent = text;
  div.appendChild(whoEl);
  div.appendChild(body);
  return div;
}

function appendLog(who, text) {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const div = buildMessageNode(who === 'user' ? 'YOU' : 'VOXPREP', time, text, who === 'user');
  $('log').appendChild(div);
  $('log').scrollTop = $('log').scrollHeight;
  $('turn-count').textContent = $('log').children.length;
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
function connectWs() {
  const sid = S.sessionId;
  if (!sid) return;
  const ws = new WebSocket(wsUrl(`/ws/interview/${sid}`));
  S.ws = ws;
  ws.onopen = () => {
    setConnectionStatus('● SYSTEMS ONLINE', true);
    ws.send(JSON.stringify({ type: 'auth', token: S.sessionToken || '' }));
    if (S.pendingSend) { ws.send(S.pendingSend); S.pendingSend = null; }
  };
  ws.onmessage = (e) => handleServer(JSON.parse(e.data));
  ws.onclose = (e) => {
    if (S.ws === ws) S.ws = null;
    if (S.sessionId === sid && !S.complete && !S.finishing) {
      if ([4401, 4404, 1008].includes(e.code)) {
        setConnectionStatus('● SESSION EXPIRED', false);
        setUiState('idle');
        renderSubtitle('Session expired or backend restarted. Click End to return to Setup.');
        revealAll();
        return;
      }
      setConnectionStatus('● RECONNECTING', false);
      setTimeout(() => {
        if (S.sessionId === sid && !S.complete && !S.finishing && !S.ws) connectWs();
      }, 1200);
    }
  };
}

function handleServer(data) {
  if (data.type === 'interviewer_thinking') {
    setUiState('thinking');
  } else if (data.type === 'interviewer_speech') {
    updateStage(data.stage);
    if (typeof data.candidate_turns === 'number') {
      updateTurnProgress(data.candidate_turns, data.max_turns || 10);
    }
    appendLog('jarvis', data.text);
    S.complete = !!data.is_complete;
    speak(data.text);
  } else if (data.type === 'error') {
    setUiState('idle');
    renderSubtitle(`System fault: ${data.message}`);
    revealAll();
  }
}

function sendAnswer(text) {
  appendLog('user', text);
  $('live-user').textContent = '';
  setUiState('thinking');
  renderSubtitle('');
  const payload = JSON.stringify({ type: 'candidate_speech', text });
  if (S.ws && S.ws.readyState === WebSocket.OPEN) {
    S.ws.send(payload);
  } else {
    S.pendingSend = payload;
    if (!S.ws || S.ws.readyState > WebSocket.OPEN) connectWs();
  }
}

// ---------------------------------------------------------------------------
// Subtitles (word-by-word reveal synced to speech)
// ---------------------------------------------------------------------------
function renderSubtitle(text) {
  const box = $('subtitle');
  box.innerHTML = '';
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) {
    const span = document.createElement('span');
    span.className = 'w';
    span.dataset.start = m.index;
    span.textContent = m[0];
    box.appendChild(span);
    box.appendChild(document.createTextNode(' '));
  }
}

function revealUpTo(charIndex) {
  $('subtitle').querySelectorAll('.w:not(.on)').forEach((w) => {
    if (+w.dataset.start <= charIndex) w.classList.add('on');
  });
}
function revealAll() { revealUpTo(Infinity); }

// ---------------------------------------------------------------------------
// Speech output
// ---------------------------------------------------------------------------
function cleanForSpeech(text) {
  return text.replace(/[*_#`>]/g, '');
}

async function playSpeechAudio(text, token) {
  const mode = $('audio-mode').value;
  const voice = $('voice-select').value;
  let done = false;

  if (mode === 'neural' && S.status.has_neural_tts) {
    try { await speakServer(text, token, 'neural', voice); done = true; }
    catch (e) { console.warn('Neural TTS failed, trying fallback', e); }
  } else if (mode === 'openai' && S.status.has_openai_audio_key) {
    try { await speakServer(text, token, 'openai', voice); done = true; }
    catch (e) { console.warn('OpenAI TTS failed, trying neural fallback', e); }
    if (!done && token === S.ttsToken && S.status.has_neural_tts) {
      try { await speakServer(text, token, 'neural', 'en-GB-RyanNeural'); done = true; }
      catch (e) { console.warn('Neural fallback failed, using browser voice', e); }
    }
  }

  if (!done && token === S.ttsToken) await speakBrowser(text, token);
}

async function previewVoice() {
  const btn = $('btn-test-voice');
  interruptSpeech();
  const token = ++S.ttsToken;
  if (!S.audioCtx) S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (S.audioCtx.state === 'suspended') await S.audioCtx.resume();
  btn.disabled = true;
  btn.textContent = '…';
  try {
    await playSpeechAudio('Good day. All VoxPrep audio subsystems are calibrated and online.', token);
  } finally {
    btn.disabled = false;
    btn.textContent = 'TEST';
  }
}

async function speak(text) {
  stopListening();
  interruptSpeech();
  const token = ++S.ttsToken;
  S.lastLine = text;
  renderSubtitle(text);
  setUiState('speaking');

  await playSpeechAudio(text, token);
  if (token !== S.ttsToken) return; // interrupted
  revealAll();
  onSpeechDone();
}

function onSpeechDone() {
  if (S.complete) { setTimeout(finishInterview, 600); return; }
  setUiState('idle');
  if ($('auto-listen').checked && S.micAnalyser && S.recognition) startListening();
}

function interruptSpeech() {
  S.ttsToken++;
  S.synthActive = false;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (S.currentSource) {
    try { S.currentSource.stop(); } catch (_) {}
    try { S.currentSource.disconnect(); } catch (_) {}
    S.currentSource = null;
  }
  if (S.currentAudio) { S.currentAudio.pause(); S.currentAudio = null; }
  revealAll();
}

function speakBrowser(text, token) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    speechSynthesis.cancel();
    const en = S.voices.filter((v) => v.lang.startsWith('en'));
    const selectedName = $('voice-select').value;
    const voice = en.find((v) => v.name === selectedName) ||
      en.find((v) => /Google UK English Male|Microsoft Ryan|Natural/i.test(v.name)) ||
      en.find((v) => v.lang === 'en-GB') ||
      en[0];

    const u = new SpeechSynthesisUtterance(cleanForSpeech(text));
    if (voice) u.voice = voice;
    u.rate = 0.98;
    u.pitch = 1.0; // avoid pitch-shift vocoder artifacts

    let fallbackTimer = null;
    const words = text.split(/\s+/).filter(Boolean);
    const finish = () => {
      clearInterval(fallbackTimer);
      S.synthActive = false;
      resolve();
    };

    u.onstart = () => {
      if (token !== S.ttsToken) return;
      S.synthActive = true;
      S.synthBoost = 0.35;
      let i = 0, pos = 0;
      fallbackTimer = setInterval(() => {
        if (token !== S.ttsToken || i >= words.length) return clearInterval(fallbackTimer);
        pos = text.indexOf(words[i], pos);
        revealUpTo(pos);
        i++;
      }, 340);
    };
    u.onboundary = (e) => {
      if (token !== S.ttsToken) return;
      S.synthBoost = 0.4;
      revealUpTo(e.charIndex);
    };
    u.onend = finish;
    u.onerror = finish;
    S.utterances = [u]; // keep reference (Chrome GC bug drops events otherwise)
    speechSynthesis.speak(u);
  });
}

async function speakServer(text, token, engine, voice) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.sessionToken) headers['X-Session-Token'] = S.sessionToken;
  const res = await fetch(apiUrl('/api/audio/synthesize'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      message: cleanForSpeech(text),
      engine,
      voice,
      session_id: S.sessionId || '',
    }),
  });
  if (!res.ok) throw new Error('TTS unavailable');
  const arrayBuffer = await res.arrayBuffer();
  if (token !== S.ttsToken) return;

  if (S.audioCtx) {
    if (S.audioCtx.state === 'suspended') await S.audioCtx.resume();
    if (!S.ttsAnalyser) {
      S.ttsAnalyser = S.audioCtx.createAnalyser();
      S.ttsAnalyser.fftSize = 256;
      S.ttsAnalyser.smoothingTimeConstant = 0.72;
      S.ttsAnalyser.connect(S.audioCtx.destination);
    }
    const decoded = await S.audioCtx.decodeAudioData(arrayBuffer);
    if (token !== S.ttsToken) return;

    const src = S.audioCtx.createBufferSource();
    src.buffer = decoded;
    src.connect(S.ttsAnalyser);
    S.currentSource = src;

    const duration = decoded.duration || 1;
    const t0 = S.audioCtx.currentTime;
    const subTimer = setInterval(() => {
      if (token !== S.ttsToken) return clearInterval(subTimer);
      const frac = Math.min(1, (S.audioCtx.currentTime - t0) / duration);
      revealUpTo(Math.floor(text.length * frac) + 2);
    }, 60);

    await new Promise((resolve) => {
      src.onended = resolve;
      src.start(0);
    });
    clearInterval(subTimer);
    if (S.currentSource === src) S.currentSource = null;
    return;
  }

  const url = URL.createObjectURL(new Blob([arrayBuffer], { type: 'audio/mpeg' }));
  const audio = new Audio(url);
  S.currentAudio = audio;
  audio.ontimeupdate = () => {
    if (audio.duration) revealUpTo(Math.floor(text.length * (audio.currentTime / audio.duration)) + 2);
  };
  await new Promise((resolve) => {
    audio.onended = resolve;
    audio.onerror = resolve;
    audio.onpause = resolve;
    audio.play().catch(resolve);
  });
  URL.revokeObjectURL(url);
  if (S.currentAudio === audio) S.currentAudio = null;
}

// ---------------------------------------------------------------------------
// Speech input (Web Speech API) with silence-based auto-send
// ---------------------------------------------------------------------------
function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';

  rec.onresult = (e) => {
    if (!S.listening) return; // ignore late results after we've stopped
    let fin = '', interim = '';
    for (let i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) fin += e.results[i][0].transcript + ' ';
      else interim += e.results[i][0].transcript;
    }
    S.sessionFinal = fin;
    S.interim = interim;
    $('live-user').textContent = currentAnswer() || '…';
    armSilence();
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      S.recognition = null;
      stopListening();
      setUiState('idle');
      $('type-form').classList.remove('hidden');
    }
  };
  rec.onend = () => {
    // Chrome ends sessions periodically; keep what we heard and resume
    S.committed += S.sessionFinal + (S.interim ? S.interim + ' ' : '');
    S.sessionFinal = '';
    S.interim = '';
    if (S.listening) { try { rec.start(); } catch (_) {} }
  };
  S.recognition = rec;

  // Treat ongoing voice energy as "still talking" so we don't cut people off mid-thought
  setInterval(() => {
    if (S.listening && S.micLevel > 0.035 && currentAnswer()) armSilence();
  }, 150);
}

function currentAnswer() {
  return (S.committed + S.sessionFinal + S.interim).replace(/\s+/g, ' ').trim();
}

function armSilence() {
  clearTimeout(S.silenceTimer);
  if (!S.listening || !$('auto-listen').checked || !currentAnswer()) return;
  S.silenceTimer = setTimeout(submitAnswer, SILENCE_MS);
}

function startListening() {
  if (!S.recognition || S.listening || S.uiState === 'thinking' || S.finishing) return;
  interruptSpeech();
  S.listening = true;
  S.committed = S.sessionFinal = S.interim = '';
  $('live-user').textContent = '…';
  setUiState('listening');
  try { S.recognition.start(); } catch (_) {}
}

function stopListening() {
  clearTimeout(S.silenceTimer);
  if (!S.listening) return;
  S.listening = false;
  try { S.recognition.stop(); } catch (_) {}
}

function submitAnswer() {
  const text = currentAnswer();
  stopListening();
  if (text) sendAnswer(text);
  else { $('live-user').textContent = ''; setUiState('idle'); }
}

function toggleMic() {
  if (S.uiState === 'thinking' || S.finishing) return;
  if (!S.recognition) { $('type-form').classList.remove('hidden'); $('type-input').focus(); return; }
  if (S.listening) submitAnswer();
  else startListening();
}

// ---------------------------------------------------------------------------
// Debrief
// ---------------------------------------------------------------------------
async function finishInterview() {
  if (S.finishing || !S.sessionId) return;
  S.finishing = true;
  stopListening();
  interruptSpeech();
  setUiState('thinking');
  renderSubtitle('Compiling your performance analysis…');
  revealAll();
  try {
    const res = await fetch(apiUrl(`/api/session/${S.sessionId}/end`), {
      method: 'POST',
      headers: { 'X-Session-Token': S.sessionToken || '' },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Analysis failed');
    showReport(data.scorecard);
  } catch (err) {
    S.finishing = false;
    setUiState('idle');
    renderSubtitle(`Analysis failed: ${err.message}`);
    revealAll();
  }
}

const CATEGORY_LABELS = {
  role_expertise: 'Role Expertise',
  experience_relevance: 'Experience Relevance',
  problem_solving: 'Problem Solving',
  communication: 'Communication',
  behavioral_fit: 'Behavioral Fit',
};
const VERDICT_COLORS = {
  'Strong Hire': 'var(--green)', 'Hire': 'var(--green)', 'Lean Hire': 'var(--cyan)',
  'Lean No Hire': 'var(--amber)', 'No Hire': 'var(--red)',
};

function fillList(id, items) {
  const ul = $(id);
  ul.innerHTML = '';
  (items || []).forEach((t) => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
}

function showReport(sc) {
  if (S.ws) { try { S.ws.close(); } catch (_) {} }
  S.sessionToken = null;
  S.startTime = 0;
  S.lastReport = sc;
  setUiState('idle');
  $('interview-screen').classList.remove('active');
  $('report-screen').classList.add('active');
  $('report-screen').scrollTop = 0;
  const trReview = document.querySelector('.transcript-review');
  if (trReview) trReview.open = false;

  const modeTag = sc.mode ? (MODE_LABELS[sc.mode] || sc.mode) : '';
  const meta = [sc.role_title, sc.model, modeTag].filter(Boolean);
  $('r-name').textContent = sc.candidate_name;
  $('r-role').textContent = meta.join(' · ');
  $('r-verdict').textContent = sc.recommendation;
  $('r-verdict').style.color = VERDICT_COLORS[sc.recommendation] || 'var(--cyan)';
  $('r-summary').textContent = sc.executive_summary || '';
  fillList('r-strengths', sc.key_strengths);
  fillList('r-improve', sc.areas_for_improvement);
  fillList('r-followups', sc.recommended_follow_ups);

  const trBox = $('r-transcript');
  trBox.innerHTML = '';
  (sc.transcript || []).forEach((t) => {
    const div = buildMessageNode(
      t.role === 'candidate' ? 'YOU' : 'VOXPREP',
      t.stage || '',
      t.text,
      t.role === 'candidate'
    );
    trBox.appendChild(div);
  });

  const bars = $('r-bars');
  bars.innerHTML = '';
  Object.entries(sc.category_scores || {}).forEach(([k, v]) => {
    const val = Math.max(0, Math.min(10, parseFloat(v) || 0));
    const row = document.createElement('div');
    row.className = 'bar-row';
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = CATEGORY_LABELS[k] || k;
    const scoreB = document.createElement('b');
    scoreB.textContent = val.toFixed(1);
    lbl.appendChild(nameSpan);
    lbl.appendChild(scoreB);
    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    track.appendChild(fill);
    row.appendChild(lbl);
    row.appendChild(track);
    bars.appendChild(row);
    requestAnimationFrame(() => setTimeout(() => { fill.style.width = `${val * 10}%`; }, 100));
  });

  const score = Math.max(0, Math.min(100, sc.overall_score || 0));
  const ring = $('r-ring');
  ring.style.strokeDashoffset = 540.35;
  setTimeout(() => { ring.style.strokeDashoffset = 540.35 * (1 - score / 100); }, 100);
  const t0 = performance.now();
  const count = (now) => {
    const p = Math.min((now - t0) / 1600, 1);
    $('r-score').textContent = Math.round(score * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(count);
  };
  requestAnimationFrame(count);
}

function downloadReport() {
  if (!S.lastReport) return;
  const blob = new Blob([JSON.stringify(S.lastReport, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `voxprep-debrief-${(S.lastReport.session_id || 'report').slice(0, 8)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function resetAll() {
  stopListening();
  interruptSpeech();
  clearSetupError();
  if (S.ws) { try { S.ws.close(); } catch (_) {} }
  Object.assign(S, {
    sessionId: null, sessionToken: null, ws: null, pendingSend: null, complete: false,
    finishing: false, startTime: 0, lastLine: '', lastReport: null,
  });
  $('hud-session').textContent = 'SESSION: ——';
  $('subtitle').innerHTML = '';
  $('live-user').textContent = '';
  $('elapsed').textContent = '00:00';
  $('mic-meter').style.width = '0%';
  $('type-input').value = '';
  $('type-form').classList.add('hidden');
  $('r-transcript').innerHTML = '';
  updateTurnProgress(0, parseInt($('max-turns').value, 10) || 10);
  setConnectionStatus('● SYSTEMS ONLINE', true);
  $('report-screen').classList.remove('active');
  $('interview-screen').classList.remove('active');
  $('setup-screen').classList.add('active');
  setUiState('idle');
}
