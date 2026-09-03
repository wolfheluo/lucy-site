// =====================================================================
//  音效引擎：互動音效用 Web Audio API 合成，氛圍音樂使用外部音檔。
//  互動音效：click / hover / decode / boot / line
//  氛圍音樂：public/bgm.mp3（預設關閉，由 UI 開關啟動）
// =====================================================================
class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private music: HTMLAudioElement | null = null;
  private musicFadeTimer: number | null = null;
  /** 是否已收到首次使用者手勢（autoplay 政策解鎖） */
  private unlocked = false;

  muted = false;

  constructor() {
    // 首次手勢（點/按/觸）才建立 AudioContext —— 消除非手勢初始化警告
    if (typeof window === "undefined") return;
    const unlock = () => {
      this.unlocked = true;
      this.ensure();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    window.addEventListener("touchstart", unlock);
  }

  /** lazy init; 未手勢前不建立 ctx（靜默，無警告） */
  private ensure(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!this.unlocked && !this.ctx) return null;
    if (!this.ctx) {
      const AC: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.8;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.02);
    }
    if (this.music) this.music.volume = m ? 0 : 0.16;
  }

  /** small blip on click — short square pitch-up + noise tick */
  click() {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(1560, t + 0.06);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.09);

    this.tick(ctx, t, 0.05);
  }

  /** ultra-subtle hover tick */
  hover() {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1900, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.02, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.05);
  }

  /** glitch decode sweep — sawtooth glissando through a bandpass */
  decode() {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(2400, t + 0.32);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(4200, t + 0.32);
    bp.Q.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
    osc.connect(bp).connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.4);
  }

  /** boot power-on surge */
  boot() {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(60, t);
    osc.frequency.exponentialRampToValueAtTime(320, t + 0.5);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    osc.connect(lp).connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 1);
  }

  /** terminal line blip */
  line() {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    this.tick(ctx, ctx.currentTime, 0.03);
  }

  /** 存取被拒 buzz — 低頻 saw 下墜 + 雜訊爆音 */
  denied() {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.28);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.14, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.35);
    this.tick(ctx, t, 0.1);
  }

  /** 授權通過 — 上行雙音（解鎖成功） */
  granted() {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime;
    const notes = [523.25, 784, 1046.5]; // C5 G5 C6
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = f;
      const g = ctx.createGain();
      const st = t + i * 0.07;
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.12, st + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.3);
      osc.connect(g).connect(this.master!);
      osc.start(st);
      osc.stop(st + 0.35);
    });
    this.tick(ctx, t + 0.1, 0.04);
  }

  /** 完成 ping（上傳成功 / 分享建立） */
  ping() {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime;
    [880, 1320].forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      const g = ctx.createGain();
      const st = t + i * 0.05;
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.09, st + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.22);
      osc.connect(g).connect(this.master!);
      osc.start(st);
      osc.stop(st + 0.25);
    });
  }

  private tick(ctx: AudioContext, t: number, vol: number) {
    if (!this.master) return;
    const src = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.02, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2600;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(hp).connect(g).connect(this.master);
    src.start(t);
  }

  // ---------------- ambient pad ----------------

  get ambientPlaying() {
    return this.music !== null;
  }

  /** loop the homepage BGM (off by default) */
  startAmbient() {
    if (typeof window === "undefined" || this.music) return;
    const music = new Audio("/bgm.mp3");
    music.loop = true;
    music.volume = 0;
    this.music = music;
    void music.play().then(() => {
      this.fadeMusic(music, this.muted ? 0 : 0.16, 1200);
    });
  }

  stopAmbient() {
    if (!this.music) return;
    const music = this.music;
    this.music = null;
    this.fadeMusic(music, 0, 700, () => {
      music.pause();
      music.currentTime = 0;
    });
  }

  private fadeMusic(
    music: HTMLAudioElement,
    target: number,
    duration: number,
    onComplete?: () => void,
  ) {
    if (this.musicFadeTimer) window.clearInterval(this.musicFadeTimer);
    const start = music.volume;
    const startedAt = performance.now();
    this.musicFadeTimer = window.setInterval(() => {
      const progress = Math.min(1, (performance.now() - startedAt) / duration);
      music.volume = start + (target - start) * progress;
      if (progress >= 1) {
        if (this.musicFadeTimer) window.clearInterval(this.musicFadeTimer);
        this.musicFadeTimer = null;
        onComplete?.();
      }
    }, 50);
  }
}

export const sfx = new SoundEngine();
