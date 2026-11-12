// VoxPrep Arc-Reactor HUD renderer
// States: idle | thinking | speaking | listening
// A level source (fn -> {level: 0..1, bins?: Uint8Array}) drives the animation in real time.

(function () {
  const COLORS = {
    idle: [0, 190, 255],
    thinking: [80, 220, 255],
    speaking: [0, 229, 255],
    listening: [255, 176, 40],
  };
  const SPIN = { idle: 1, thinking: 6, speaking: 1.8, listening: 1.3 };
  const TAU = Math.PI * 2;

  class Reactor {
    constructor(canvas, opts = {}) {
      this.c = canvas;
      this.ctx = canvas.getContext('2d');
      this.mini = !!opts.mini;
      this.state = 'idle';
      this.level = 0;
      this.source = null;
      this.nBars = this.mini ? 0 : 96;
      this.bars = new Float32Array(this.nBars);
      this.rot = [0, 0, 0, 0];
      this.ripples = [];
      this.spin = 1;
      this.color = COLORS.idle.slice();
      this.last = performance.now();
      this.t0 = this.last;
      this.w = 0; this.h = 0; this.dpr = 1;

      this.resize();
      if ('ResizeObserver' in window) new ResizeObserver(() => this.resize()).observe(canvas);
      this.frame = this.frame.bind(this);
      requestAnimationFrame(this.frame);
    }

    setState(s) { this.state = COLORS[s] ? s : 'idle'; }
    setSource(fn) { this.source = fn; }

    resize() {
      const r = this.c.getBoundingClientRect();
      if (!r.width || !r.height) return;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = r.width; this.h = r.height;
      this.c.width = Math.round(r.width * this.dpr);
      this.c.height = Math.round(r.height * this.dpr);
    }

    rgba(a) {
      const [r, g, b] = this.color;
      return `rgba(${r | 0},${g | 0},${b | 0},${Math.max(0, Math.min(1, a))})`;
    }

    arc(r, a0, a1, width, alpha, glow = 0) {
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.arc(0, 0, r, a0, a1);
      ctx.lineWidth = width;
      ctx.strokeStyle = this.rgba(alpha);
      ctx.shadowBlur = glow;
      ctx.shadowColor = this.rgba(0.9);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    frame(now) {
      requestAnimationFrame(this.frame);
      const dt = Math.min((now - this.last) / 1000, 0.05);
      this.last = now;
      const t = (now - this.t0) / 1000;
      if (!this.w) { this.resize(); if (!this.w) return; }

      // ----- level -----
      const src = this.source ? this.source() : null;
      let target;
      if (src && (this.state === 'speaking' || this.state === 'listening')) {
        target = src.level;
      } else if (this.state === 'thinking') {
        target = 0.22 + 0.08 * Math.sin(t * 7);
      } else {
        target = 0.06 + 0.04 * Math.sin(t * 1.6);
      }
      this.level += (target - this.level) * (target > this.level ? 0.4 : 0.12);

      // ----- spin + colour easing -----
      this.spin += (SPIN[this.state] - this.spin) * 0.05;
      const sp = [0.08, -0.22, 0.5, 0.12];
      for (let i = 0; i < 4; i++) this.rot[i] += dt * sp[i] * this.spin;
      const tc = COLORS[this.state];
      for (let i = 0; i < 3; i++) this.color[i] += (tc[i] - this.color[i]) * 0.08;

      if (!this.mini && (this.state === 'speaking' || this.state === 'listening') && this.level > 0.32) {
        const lastR = this.ripples[this.ripples.length - 1];
        if (!lastR || lastR.p > 0.28) this.ripples.push({ p: 0, amp: this.level });
      }
      for (let i = this.ripples.length - 1; i >= 0; i--) {
        this.ripples[i].p += dt * 1.15;
        if (this.ripples[i].p >= 1) this.ripples.splice(i, 1);
      }

      this.draw(t, src);
    }

    draw(t, src) {
      const { ctx, w, h, dpr } = this;
      const L = this.level;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(w / 2, h / 2);
      const R = Math.min(w, h) / 2 * 0.96;
      ctx.lineCap = 'butt';

      // ---- ambient bloom ----
      const bloom = ctx.createRadialGradient(0, 0, R * 0.1, 0, 0, R);
      bloom.addColorStop(0, this.rgba(0.10 + L * 0.25));
      bloom.addColorStop(1, this.rgba(0));
      ctx.fillStyle = bloom;
      ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();

      // ---- outer tick ring ----
      ctx.save();
      ctx.rotate(this.rot[0]);
      const ticks = this.mini ? 36 : 144;
      for (let i = 0; i < ticks; i++) {
        const major = i % (this.mini ? 3 : 6) === 0;
        const a = (i / ticks) * TAU;
        const r1 = R * 0.97, r2 = R * (major ? 0.9 : 0.94);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
        ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
        ctx.lineWidth = major ? 1.6 : 1;
        ctx.strokeStyle = this.rgba(major ? 0.55 : 0.25);
        ctx.stroke();
      }
      ctx.restore();

      // ---- segmented arcs (counter-rotating) ----
      ctx.save();
      ctx.rotate(this.rot[1]);
      const segW = R * (this.mini ? 0.07 : 0.028);
      [[0, 0.55], [0.7, 1.05], [1.2, 1.85]].forEach(([a, b]) =>
        this.arc(R * 0.85, a * Math.PI, b * Math.PI, segW, 0.55 + L * 0.4, this.mini ? 0 : 12));
      ctx.restore();

      if (!this.mini) {
        // thin guide circles
        this.arc(R * 0.79, 0, TAU, 1, 0.25);
        ctx.save();
        ctx.rotate(-this.rot[0] * 2);
        ctx.setLineDash([2, 10]);
        this.arc(R * 0.76, 0, TAU, 2, 0.45);
        ctx.setLineDash([]);
        ctx.restore();

        // ---- thinking scanner sweeps ----
        if (this.state === 'thinking' || this.spin > 2.5) {
          const k = Math.min((this.spin - 1) / 5, 1);
          ctx.save();
          ctx.rotate(t * 4.2);
          this.arc(R * 0.70, 0, Math.PI * 0.5, 3, 0.8 * k, 18);
          ctx.rotate(Math.PI);
          this.arc(R * 0.70, 0, Math.PI * 0.5, 3, 0.8 * k, 18);
          ctx.restore();
        }

        // ---- radial voice spectrum ----
        const N = this.nBars, r0 = R * 0.47, maxLen = R * 0.25;
        const bins = src && src.bins;
        for (let i = 0; i < N; i++) {
          const m = i < N / 2 ? i : N - 1 - i; // mirror for symmetry
          let v;
          if (bins && bins.length && (this.state === 'speaking' || this.state === 'listening')) {
            const idx = Math.floor((m / (N / 2)) * bins.length * 0.7);
            v = (bins[idx] / 255) * (0.6 + L * 0.8);
          } else {
            const wob = 0.5 + 0.5 * Math.sin(m * 0.55 + t * 7.5) * Math.sin(m * 0.21 - t * 3.3);
            v = L * (0.35 + 0.9 * wob) + 0.015;
          }
          this.bars[i] += (v - this.bars[i]) * 0.3;
        }
        ctx.save();
        ctx.rotate(-Math.PI / 2 + this.rot[3]);
        ctx.lineWidth = Math.max(1.5, (TAU * r0 / N) * 0.45);
        ctx.shadowBlur = 8;
        ctx.shadowColor = this.rgba(0.8);
        for (let i = 0; i < N; i++) {
          const a = (i / N) * TAU, len = R * 0.015 + Math.min(this.bars[i], 1.2) * maxLen;
          const c = Math.cos(a), s = Math.sin(a);
          ctx.beginPath();
          ctx.moveTo(c * r0, s * r0);
          ctx.lineTo(c * (r0 + len), s * (r0 + len));
          ctx.strokeStyle = this.rgba(0.35 + Math.min(this.bars[i], 1) * 0.65);
          ctx.stroke();
        }
        ctx.restore();

        // inner rim
        this.arc(R * 0.44, 0, TAU, 1.5, 0.6, 6);

        // ---- voice harmonic ripples ----
        for (const rp of this.ripples) {
          const rr = R * (0.24 + rp.p * 0.72);
          const alpha = (1 - rp.p) * 0.45 * rp.amp;
          this.arc(rr, 0, TAU, 1.5, alpha, 10);
        }
      }

      // ---- arc-reactor coils ----
      ctx.save();
      ctx.rotate(this.rot[2] * (this.mini ? 1 : 0.35));
      const coils = 10, ci = R * (this.mini ? 0.42 : 0.29), co = R * (this.mini ? 0.62 : 0.4);
      for (let i = 0; i < coils; i++) {
        const a = (i / coils) * TAU, half = (TAU / coils) * 0.32;
        ctx.beginPath();
        ctx.arc(0, 0, co, a - half, a + half);
        ctx.arc(0, 0, ci, a + half * 0.8, a - half * 0.8, true);
        ctx.closePath();
        ctx.fillStyle = this.rgba(0.18 + L * 0.5);
        ctx.strokeStyle = this.rgba(0.6 + L * 0.4);
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();

      // ---- core ----
      const rc = R * (this.mini ? 0.34 : 0.2) * (1 + L * 0.45);
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, rc * 1.9);
      core.addColorStop(0, 'rgba(255,255,255,0.98)');
      core.addColorStop(0.28, this.rgba(0.95));
      core.addColorStop(0.55, this.rgba(0.35 + L * 0.3));
      core.addColorStop(1, this.rgba(0));
      ctx.fillStyle = core;
      ctx.beginPath(); ctx.arc(0, 0, rc * 1.9, 0, TAU); ctx.fill();
      this.arc(rc * 1.08, 0, TAU, this.mini ? 1 : 2, 0.9, this.mini ? 4 : 20 + L * 30);

      ctx.restore();
    }
  }

  window.Reactor = Reactor;
})();

