/* Thendral Text-to-Speech
   Photo → offline OCR (Tesseract) → paragraphs matched to the photo → audio.
   On the Windows app the Kokoro voice makes an MP3 per page and saves it to the Thendral folder;
   on the iPhone those pages are imported and played with lock-screen controls. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const base = new URL('.', location.href).href;
  const native = window.thendralNative || null;   // present only in the Windows app

  const VOICES = [
    { id: 'bella', name: 'Bella', sid: 1, desc: 'American · female · warm' },
    { id: 'sarah', name: 'Sarah', sid: 3, desc: 'American · female · clear' },
    { id: 'michael', name: 'Michael', sid: 6, desc: 'American · male' },
    { id: 'george', name: 'George', sid: 9, desc: 'British · male' },
  ];
  const STYLES = [
    { id: 'calm', name: 'Calm study', desc: 'Slower, with a long pause after each sentence', speed: 0.85, pause: 0.9, paraPause: 1.5 },
    { id: 'lecture', name: 'Lecture', desc: 'Normal pace, natural pauses', speed: 1.0, pause: 0.45, paraPause: 0.9 },
    { id: 'quick', name: 'Quick revision', desc: 'Faster, short pauses', speed: 1.2, pause: 0.15, paraPause: 0.4 },
  ];
  const RATES = [0.75, 1, 1.25, 1.5];

  // ---------- settings (small, per device) ----------
  const settings = {
    get(key, fallback) {
      try { const v = localStorage.getItem('thendral.' + key); return v === null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('thendral.' + key, JSON.stringify(value)); } catch { /* storage blocked */ }
    },
  };

  // ---------- saved pages (IndexedDB: holds photos and audio) ----------
  const db = (() => {
    let opening;
    const open = () => opening || (opening = new Promise((resolve, reject) => {
      const req = indexedDB.open('thendral', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('pages', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
    const run = async (mode, fn) => {
      const conn = await open();
      return new Promise((resolve, reject) => {
        const tx = conn.transaction('pages', mode);
        const out = fn(tx.objectStore('pages'));
        tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
        tx.onerror = () => reject(tx.error);
      });
    };
    return {
      put: (page) => run('readwrite', (s) => s.put(page)),
      all: () => run('readonly', (s) => s.getAll()),
      del: (id) => run('readwrite', (s) => s.delete(id)),
    };
  })();

  // ---------- state ----------
  let current = null;      // open page: {id, created, title, book, paras, photo, thumb, audio, timings, voice, style, pos}
  let units = [];          // sentences in reading order: {pi, text, tamil, el, words:[{el, start, b}]}
  let paraEls = [];
  let boxEls = [];
  let idx = 0;
  let stopAtPara = -1;
  let playing = false;
  let speakToken = 0;
  let rate = settings.get('rate2', 1);
  let voiceId = settings.get('kvoice', 'bella');
  let styleId = settings.get('style', 'calm');
  let deviceVoices = [];
  let wakeLock = null;
  let photoURL = null;
  let audioURL = null;
  let queue = [];          // page ids for continuous reading
  let qi = -1;
  let selecting = false;
  const selected = new Set();
  const audio = $('audio');

  const style = () => STYLES.find((s) => s.id === styleId) || STYLES[0];
  const voice = () => VOICES.find((v) => v.id === voiceId) || VOICES[0];
  const hasAudio = () => !!(current && current.audio && current.timings && current.timings.length === units.length);

  // ---------- helpers ----------
  const isTamil = (s) => {
    const letters = s.replace(/[\s\d\p{P}]/gu, '').length || 1;
    return ((s.match(/[஀-௿]/g) || []).length / letters) > 0.3;
  };
  const toast = (msg, ms = 2800) => {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, ms);
  };
  const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const fmtTime = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const paraText = (p) => p.tokens.map((k) => k.t).join(' ');
  const titleOf = (paras) => {
    const first = paras.length ? paraText(paras[0]) : 'Untitled page';
    return first.length > 70 ? first.slice(0, 68) + '…' : first;
  };
  const bookOf = (p) => (p.book && p.book.trim()) || 'My pages';
  const fileBase = (p) => {
    const d = new Date(p.created);
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    return `${stamp} ${p.title.replace(/[<>:"/\\|?*]/g, ' ').slice(0, 50)}`.trim();
  };

  const ABBREV = /^(?:e\.g|i\.e|etc|vs|Dr|Mr|Mrs|Ms|Prof|Fig|Figs|No|Vol|approx|Ch|Sec|Ref|St|Inc|Ltd|[A-Z])\.$/i;
  const endsSentence = (tok) => /[.!?।:;]["')\]]*$/.test(tok) && !ABBREV.test(tok.replace(/^[("'[]+/, ''));

  // Read medical shorthand the way a lecturer would say it.
  const spokenForm = (s) => s
    .replace(/\be\.g\./gi, 'for example')
    .replace(/\bi\.e\./gi, 'that is')
    .replace(/\bvs\.?(?=\s)/gi, 'versus')
    .replace(/\bFigs?\.\s*/g, 'Figure ')
    .replace(/(\d)\s*mmHg\b/g, '$1 millimetres of mercury')
    .replace(/(\d)\s*mg\b/g, '$1 milligrams')
    .replace(/(\d)\s*mcg\b|(\d)\s*µg\b/g, '$1$2 micrograms')
    .replace(/(\d)\s*ml\b/gi, '$1 millilitres')
    .replace(/(\d)\s*kg\b/g, '$1 kilograms')
    .replace(/(\d)\s*cm\b/g, '$1 centimetres')
    .replace(/(\d)\s*mm\b/g, '$1 millimetres')
    .replace(/(\d)\s*IU\b/g, '$1 international units')
    .replace(/(\d)\s*%/g, '$1 percent')
    .replace(/\bIM\b/g, 'intramuscularly')
    .replace(/\bIV\b/g, 'intravenously')
    .replace(/\s+/g, ' ')
    .trim();

  // ---------- image handling ----------
  const loadBitmap = async (blob) => {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
    catch {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    }
  };
  const draw = (src, maxSide, filter) => {
    const k = Math.min(1, maxSide / Math.max(src.width, src.height));
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * k);
    c.height = Math.round(src.height * k);
    const ctx = c.getContext('2d');
    if (filter) ctx.filter = filter;
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  };
  const toBlob = (canvas, q) => new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));

  // ---------- status bar ----------
  const setProgress = (label, p) => {
    $('status').hidden = false;
    $('status-text').textContent = label;
    $('status-pct').textContent = p > 0 ? Math.round(p * 100) + '%' : '';
    $('meter-fill').style.width = Math.round((p || 0) * 100) + '%';
  };
  const hideProgress = () => { $('status').hidden = true; };

  // ---------- OCR ----------
  let worker = null;
  let workerLangs = '';
  const getWorker = async (langs) => {
    if (worker && workerLangs === langs) return worker;
    if (worker) { await worker.terminate(); worker = null; }
    worker = await Tesseract.createWorker(langs.split('+'), 1 /* LSTM only */, {
      workerPath: base + 'vendor/worker.min.js',
      corePath: base + 'vendor/core',
      langPath: base + 'lang',
      workerBlobURL: false,
      cacheMethod: 'none',
      logger: (m) => {
        if (m.status === 'recognizing text') setProgress('Reading the page…', 0.3 + m.progress * 0.7);
        else if (m.status) setProgress('Preparing the reader…', (m.progress || 0) * 0.3);
      },
    });
    workerLangs = langs;
    return worker;
  };

  // Group OCR lines into paragraphs the way they sit on the printed page:
  // a new paragraph starts at a larger-than-usual gap, a first-line indent, a heading-sized line, or a new column.
  const buildParas = (blocks, W, H) => {
    const lines = [];
    for (const b of blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
      const words = (l.words || []).filter((w) => w.text && w.text.trim() && w.confidence > 15);
      if (words.length) lines.push({ bbox: l.bbox, words });
    }
    if (!lines.length) return [];
    const hs = lines.map((l) => l.bbox.y1 - l.bbox.y0).sort((a, b) => a - b);
    const medH = hs[Math.floor(hs.length / 2)] || 20;
    const lefts = lines.map((l) => l.bbox.x0).sort((a, b) => a - b);
    const leftEdge = lefts[Math.floor(lefts.length * 0.2)];
    const groups = [];
    let g = null;
    lines.forEach((l, i) => {
      const prev = lines[i - 1];
      const heading = (l.bbox.y1 - l.bbox.y0) > medH * 1.3;
      let split = !g;
      if (prev && g) {
        const gap = l.bbox.y0 - prev.bbox.y1;
        const overlapX = Math.min(l.bbox.x1, prev.bbox.x1) - Math.max(l.bbox.x0, prev.bbox.x0);
        const indented = l.bbox.x0 - leftEdge > medH * 0.9 && prev.bbox.x0 - leftEdge < medH * 0.5;
        if (gap > medH * 0.75 || gap < -medH || overlapX < 0 || indented || heading !== g.heading) split = true;
      }
      if (split) { g = { lines: [], heading }; groups.push(g); }
      g.lines.push(l);
    });
    const norm = (bb) => [bb.x0 / W, bb.y0 / H, bb.x1 / W, bb.y1 / H].map((v) => Math.round(v * 10000) / 10000);
    return groups.map((grp) => {
      const tokens = [];
      for (const l of grp.lines) {
        l.words.forEach((w, wi) => {
          const t = w.text.trim();
          const last = tokens[tokens.length - 1];
          if (last && last.hy && /^[a-z]/.test(t)) {        // re-join a word hyphenated across the line end
            last.t = last.t.slice(0, -1) + t;
            delete last.hy;
            return;
          }
          tokens.push({ t, b: norm(w.bbox), hy: (wi === l.words.length - 1 && /[A-Za-z]-$/.test(t)) || undefined });
        });
      }
      tokens.forEach((k) => delete k.hy);
      const box = norm({
        x0: Math.min(...grp.lines.map((l) => l.bbox.x0)), y0: Math.min(...grp.lines.map((l) => l.bbox.y0)),
        x1: Math.max(...grp.lines.map((l) => l.bbox.x1)), y1: Math.max(...grp.lines.map((l) => l.bbox.y1)),
      });
      return { tokens, box, heading: grp.heading && grp.lines.length <= 2 };
    }).filter((p) => p.tokens.length);
  };

  const handleFile = async (file) => {
    if (!file || !file.type.startsWith('image/')) { toast('Please choose a photo or image file.'); return; }
    stop();
    const langs = $('lang').value;
    setProgress('Preparing the photo…', 0.02);
    try {
      const bmp = await loadBitmap(file);
      const photo = await toBlob(draw(bmp, 2000), 0.85);
      const thumb = await toBlob(draw(bmp, 200), 0.7);
      const ocrCanvas = draw(bmp, 2600, 'grayscale(1) contrast(1.2)');
      const w = await getWorker(langs);
      const { data } = await w.recognize(ocrCanvas, {}, { blocks: true, text: true });
      const paras = buildParas(data.blocks, ocrCanvas.width, ocrCanvas.height);
      if (!paras.length) { setProgress('No text found. Try again closer to the page, in brighter light.', 0); return; }
      const page = {
        id: String(Date.now()),
        created: Date.now(),
        title: titleOf(paras),
        book: settings.get('lastBook', 'My pages'),
        paras, lang: langs, photo, thumb, pos: 0,
        confidence: Math.round(data.confidence || 0),
      };
      await db.put(page);
      hideProgress();
      openPage(page);
      go({ screen: 'page', pageId: page.id });
      renderLibrary();
      if (page.confidence && page.confidence < 60) toast('Some words may be wrong. Retake in better light, or fix them with Edit text.', 4000);
      if (native && nativeInfo && nativeInfo.voiceReady) makeAudio(page);
      else toast('Saved to your library. Tap ▶ or tap any paragraph.');
    } catch (err) {
      console.error(err);
      setProgress('Could not read this photo. Try another one.', 0);
    }
  };

  // ---------- sentences ----------
  const buildUnits = (paras) => {
    const out = [];
    paras.forEach((para, pi) => {
      let sent = [];
      const flush = () => { if (sent.length) out.push({ pi, toks: sent }); sent = []; };
      for (const k of para.tokens) {
        sent.push(k);
        if (endsSentence(k.t) || sent.length > 45) flush();
      }
      flush();
    });
    return out;
  };

  // ---------- page view ----------
  const openPage = (page, { keepQueue = false } = {}) => {
    stop();
    if (!keepQueue) { queue = []; qi = -1; }
    if (!page.paras && page.text) {   // pages saved by the first version kept only text
      page.paras = page.text.split(/\n\s*\n/).map((t) => ({ tokens: t.trim().split(/\s+/).map((x) => ({ t: x, b: null })), box: null }));
    }
    current = page;
    $('page-title').textContent = page.title;
    $('page-meta').textContent = `Saved ${fmtDate(page.created)} · ${page.paras.length} paragraph${page.paras.length === 1 ? '' : 's'}`;
    $('doc').hidden = false;
    $('doc-tools').hidden = false;
    $('book-input').value = bookOf(page);
    $('edit-toggle').textContent = 'Edit text';
    $('editbox').hidden = true;
    $('readview').hidden = false;
    if (photoURL) URL.revokeObjectURL(photoURL);
    photoURL = page.photo ? URL.createObjectURL(page.photo) : null;
    $('photo').src = photoURL || '';
    $('photo-wrap').hidden = !photoURL;
    $('photo-empty').hidden = !!photoURL;
    renderText();
    renderBoxes();
    loadAudio();
    updateAudioChip();
    renderLibrary();
    updateBanner();
    $('np-title').textContent = page.title;
  };

  const renderText = () => {
    const view = $('readview');
    view.textContent = '';
    units = [];
    paraEls = [];
    if (!current) {
      $('doc').hidden = true;
      updateWhere();
      return;
    }
    const built = buildUnits(current.paras);
    const tamilVoice = !!pickDeviceVoice(true);
    let skipped = 0;
    const pEls = current.paras.map((para, pi) => {
      const p = document.createElement('p');
      p.className = 'para' + (para.heading ? ' heading' : '');
      p.addEventListener('click', (e) => {
        const s = e.target.closest('.s');
        startAt(s ? Number(s.dataset.u) : firstUnitOf(pi), pi);
      });
      return p;
    });
    built.forEach((b) => {
      const text = b.toks.map((k) => k.t).join(' ');
      const tamil = isTamil(text);
      const span = document.createElement('span');
      span.className = 's' + (tamil ? ' ta' : '');
      if (tamil) span.lang = 'ta';
      if (tamil && !tamilVoice) { span.classList.add('skip'); skipped++; }
      span.dataset.u = units.length;
      const words = [];
      let offset = 0;
      b.toks.forEach((k) => {
        const w = document.createElement('span');
        w.className = 'w';
        w.textContent = k.t;
        span.append(w, ' ');
        words.push({ el: w, start: offset, b: k.b });
        offset += k.t.length + 1;
      });
      units.push({ pi: b.pi, text, tamil, el: span, words, len: offset });
      pEls[b.pi].append(span);
    });
    pEls.forEach((p) => view.append(p));
    paraEls = pEls;
    const note = $('voice-note');
    note.hidden = !skipped;
    note.textContent = skipped ? `${skipped} Tamil sentence${skipped > 1 ? 's are' : ' is'} shown but not read, because this device has no Tamil voice.` : '';
    idx = Math.min(current.pos || 0, Math.max(0, units.length - 1));
    mark();
  };

  const renderBoxes = () => {
    const wrap = $('boxes');
    wrap.textContent = '';
    boxEls = [];
    if (!current) return;
    current.paras.forEach((para, pi) => {
      if (!para.box) { boxEls.push(null); return; }
      const [x0, y0, x1, y1] = para.box;
      const pad = 0.006;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pbox';
      b.setAttribute('aria-label', `Read paragraph ${pi + 1}`);
      Object.assign(b.style, { left: (x0 - pad) * 100 + '%', top: (y0 - pad) * 100 + '%', width: (x1 - x0 + pad * 2) * 100 + '%', height: (y1 - y0 + pad * 2) * 100 + '%' });
      b.addEventListener('click', () => startAt(firstUnitOf(pi), pi));
      wrap.append(b);
      boxEls.push(b);
    });
    const wb = document.createElement('div');
    wb.className = 'wbox';
    wb.id = 'wbox';
    wb.hidden = true;
    wrap.append(wb);
  };

  const firstUnitOf = (pi) => Math.max(0, units.findIndex((u) => u.pi === pi));

  let lastMarked = '';
  const mark = (wordIdx = -1) => {
    const key = `${idx}:${wordIdx}:${playing}`;
    if (key === lastMarked) return;
    lastMarked = key;
    const u = units[idx];
    const active = playing || idx > 0;
    units.forEach((x, i) => x.el.classList.toggle('now', active && i === idx));
    document.querySelectorAll('.w.now').forEach((w) => w.classList.remove('now'));
    paraEls.forEach((p, i) => p.classList.toggle('now', !!(active && u && i === u.pi)));
    boxEls.forEach((b, i) => b && b.classList.toggle('now', !!(active && u && i === u.pi)));
    const wbox = $('wbox');
    if (wbox) wbox.hidden = true;
    if (u && wordIdx >= 0 && u.words[wordIdx]) {
      const w = u.words[wordIdx];
      w.el.classList.add('now');
      if (w.b && wbox) {
        const [x0, y0, x1, y1] = w.b;
        Object.assign(wbox.style, { left: x0 * 100 + '%', top: y0 * 100 + '%', width: (x1 - x0) * 100 + '%', height: (y1 - y0) * 100 + '%' });
        wbox.hidden = false;
      }
    }
    updateWhere();
  };

  const updateWhere = () => {
    const total = current ? current.paras.length : 0;
    const u = units[idx];
    const q = queue.length > 1 ? ` · page ${qi + 1} of ${queue.length}` : '';
    $('np-sub').textContent = total ? `Paragraph ${u ? u.pi + 1 : 1} of ${total}${q}` : 'Take a photo to begin';
  };

  // keep the spoken paragraph in view in the text and on the photo
  let lastFollowed = -1;
  const follow = () => {
    const u = units[idx];
    if (!u || idx === lastFollowed) return;
    lastFollowed = idx;
    const r = u.el.getBoundingClientRect();
    const topH = document.querySelector('.top').offsetHeight;
    const bottomH = document.querySelector('.player').offsetHeight;
    const visBottom = window.innerHeight - bottomH;
    if (r.top < topH + 10 || r.bottom > visBottom - 10) {
      window.scrollTo({ top: Math.max(0, window.scrollY + r.top - topH - Math.max(20, (visBottom - topH - r.height) / 3)), behavior: 'smooth' });
    }
    const box = boxEls[u.pi];
    const sc = $('photo-scroll');
    if (box && sc.scrollHeight > sc.clientHeight) sc.scrollTo({ top: Math.max(0, box.offsetTop - sc.clientHeight / 3), behavior: 'smooth' });
  };

  // ---------- audio (laptop-made MP3) ----------
  const loadAudio = () => {
    audio.pause();
    if (audioURL) { URL.revokeObjectURL(audioURL); audioURL = null; }
    if (hasAudio()) {
      audioURL = URL.createObjectURL(current.audio);
      audio.src = audioURL;
      audio.load();
    } else {
      audio.removeAttribute('src');
      audio.load();
    }
    $('seek').value = 0;
    $('t-now').textContent = '0:00';
    $('t-total').textContent = hasAudio() ? fmtTime(lastEnd()) : '0:00';
    $('seek').disabled = !hasAudio();
  };
  const lastEnd = () => {
    const t = current && current.timings ? current.timings.filter(Boolean) : [];
    return t.length ? t[t.length - 1][1] : 0;
  };
  const timeOf = (i) => {
    for (let j = i; j < current.timings.length; j++) if (current.timings[j]) return current.timings[j][0];
    return 0;
  };
  const unitAt = (t) => {
    let found = 0;
    current.timings.forEach((tm, i) => { if (tm && tm[0] <= t + 0.05) found = i; });
    return found;
  };

  audio.addEventListener('timeupdate', () => {
    if (!hasAudio()) return;
    const t = audio.currentTime;
    const dur = audio.duration || lastEnd();
    $('t-now').textContent = fmtTime(t);
    $('t-total').textContent = fmtTime(dur);
    if (!seeking) $('seek').value = dur ? Math.round((t / dur) * 1000) : 0;
    const i = unitAt(t);
    if (stopAtPara >= 0 && units[i] && units[i].pi !== stopAtPara && t > timeOf(firstUnitOf(stopAtPara))) { pause(); stopAtPara = -1; return; }
    idx = i;
    const tm = current.timings[i];
    let wi = -1;
    if (tm && t <= tm[1]) {
      const frac = (t - tm[0]) / Math.max(0.01, tm[1] - tm[0]);
      const u = units[i];
      const pos = frac * u.len;
      wi = 0;
      while (wi + 1 < u.words.length && u.words[wi + 1].start <= pos) wi++;
    }
    mark(wi);
    follow();
    updatePositionState();
  });
  audio.addEventListener('ended', () => { playing = false; setPlayIcon(); idx = 0; savePos(); nextInQueue(); });
  audio.addEventListener('pause', () => { if (playing && hasAudio() && !audio.ended) { playing = false; setPlayIcon(); savePos(); keepAwake(false); } });
  audio.addEventListener('play', () => { if (!playing) { playing = true; setPlayIcon(); } });

  let seeking = false;
  $('seek').addEventListener('input', () => {
    seeking = true;
    const dur = audio.duration || lastEnd();
    $('t-now').textContent = fmtTime((Number($('seek').value) / 1000) * dur);
  });
  $('seek').addEventListener('change', () => {
    const dur = audio.duration || lastEnd();
    audio.currentTime = (Number($('seek').value) / 1000) * dur;
    seeking = false;
  });

  // ---------- device voice (pages without laptop audio) ----------
  const deviceQuality = (v) => (/premium|neural|natural/i.test(v.name) ? 3 : /enhanced|siri|google/i.test(v.name) ? 2 : 1);
  const loadDeviceVoices = () => {
    deviceVoices = speechSynthesis.getVoices().filter((v) => /^(en|ta)/i.test(v.lang))
      .sort((a, b) => (deviceQuality(b) - deviceQuality(a)) || (b.localService - a.localService));
    if (current) renderText();
  };
  const pickDeviceVoice = (tamil) => deviceVoices.find((v) => (tamil ? /^ta/i : /^en/i).test(v.lang)) || null;

  const speakCurrent = () => {
    const token = ++speakToken;
    speechSynthesis.cancel();
    while (idx < units.length && units[idx].tamil && !pickDeviceVoice(true)) idx++;
    if (idx >= units.length || (stopAtPara >= 0 && units[idx].pi !== stopAtPara)) { endOfPage(); return; }
    const s = units[idx];
    const u = new SpeechSynthesisUtterance(s.tamil ? s.text : spokenForm(s.text));
    const v = pickDeviceVoice(s.tamil);
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = s.tamil ? 'ta-IN' : 'en-IN';
    u.rate = style().speed * rate;
    u.onboundary = (e) => {
      if (token !== speakToken || (e.name && e.name !== 'word') || s.tamil) return;
      const frac = e.charIndex / Math.max(1, u.text.length);
      let wi = 0;
      while (wi + 1 < s.words.length && s.words[wi + 1].start <= frac * s.len) wi++;
      mark(wi);
    };
    u.onend = () => {
      if (token !== speakToken || !playing) return;
      const nextPi = units[idx + 1] ? units[idx + 1].pi : -1;
      const gap = (nextPi !== s.pi ? style().paraPause : style().pause) / rate;
      idx++;
      savePos();
      setTimeout(() => { if (token === speakToken && playing) speakCurrent(); }, gap * 1000);
    };
    u.onerror = (e) => {
      if (token !== speakToken || e.error === 'interrupted' || e.error === 'canceled') return;
      idx++;
      speakCurrent();
    };
    mark(0);
    follow();
    setTimeout(() => { if (token === speakToken) speechSynthesis.speak(u); }, 60);
  };

  const endOfPage = () => {
    playing = false;
    stopAtPara = -1;
    idx = 0;
    setPlayIcon();
    keepAwake(false);
    savePos();
    mark();
    nextInQueue();
  };

  // ---------- transport ----------
  const setPlayIcon = () => {
    $('ico-play').hidden = playing;
    $('ico-pause').hidden = !playing;
    $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  };

  const begin = () => {
    playing = true;
    lastFollowed = -1;
    setPlayIcon();
    keepAwake(true);
    setMediaSession();
    if (hasAudio()) {
      audio.playbackRate = rate;
      audio.play().catch(() => { playing = false; setPlayIcon(); });
    } else {
      speakCurrent();
    }
  };

  const startAt = (unitIdx, pi) => {
    if (!units.length) return;
    idx = unitIdx;
    stopAtPara = document.querySelector('input[name="tapmode"]:checked').value === 'one' ? pi : -1;
    if (hasAudio()) audio.currentTime = timeOf(idx);
    begin();
  };

  const play = () => {
    if (!units.length) { toast('Take a photo first.'); return; }
    if (idx >= units.length) idx = 0;
    stopAtPara = -1;
    if (hasAudio() && (audio.ended || audio.currentTime === 0)) audio.currentTime = timeOf(idx);
    begin();
  };

  const pause = () => {
    if (!playing) return;
    playing = false;
    speakToken++;
    speechSynthesis.cancel();
    audio.pause();
    setPlayIcon();
    keepAwake(false);
    savePos();
    mark();
  };
  const stop = () => pause();

  const step = (d) => {
    if (!units.length) return;
    const pi = units[idx] ? units[idx].pi : 0;
    const target = Math.max(0, Math.min(current.paras.length - 1, pi + d));
    idx = firstUnitOf(target);
    stopAtPara = -1;
    if (hasAudio()) { audio.currentTime = timeOf(idx); if (!playing) mark(); }
    else if (playing) speakCurrent();
    else mark();
    lastFollowed = -1;
    follow();
  };

  const savePos = () => {
    if (!current) return;
    current.pos = idx;
    db.put(current).catch(() => {});
  };

  const setRate = (r, apply = true) => {
    rate = Math.round(Math.max(0.5, Math.min(2, r)) * 100) / 100;
    $('rate-out').textContent = (Number.isInteger(rate * 2) ? rate.toFixed(1) : rate.toFixed(2)) + '×';
    settings.set('rate2', rate);
    audio.playbackRate = rate;
    if (apply && playing && !hasAudio()) speakCurrent();
  };

  const keepAwake = async (on) => {
    try {
      if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch { wakeLock = null; }
  };

  // ---------- lock screen / notification controls ----------
  let thumbArt = null;
  const setMediaSession = () => {
    if (!('mediaSession' in navigator) || !current) return;
    if (thumbArt) URL.revokeObjectURL(thumbArt);
    thumbArt = current.thumb ? URL.createObjectURL(current.thumb) : null;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: current.title,
        artist: 'Thendral · ' + bookOf(current),
        album: bookOf(current),
        artwork: thumbArt ? [{ src: thumbArt, sizes: '200x200', type: 'image/jpeg' }] : [{ src: base + 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
    } catch { /* older browsers */ }
  };
  const updatePositionState = () => {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState || !audio.duration) return;
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration) }); } catch { /* ignore */ }
  };
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const on = (a, f) => { try { ms.setActionHandler(a, f); } catch { /* unsupported action */ } };
    on('play', () => play());
    on('pause', () => pause());
    on('previoustrack', () => (queue.length > 1 && qi > 0 ? goQueue(qi - 1) : step(-1)));
    on('nexttrack', () => (queue.length > 1 && qi < queue.length - 1 ? goQueue(qi + 1) : step(1)));
    on('seekbackward', (e) => { if (hasAudio()) audio.currentTime = Math.max(0, audio.currentTime - (e.seekOffset || 10)); });
    on('seekforward', (e) => { if (hasAudio()) audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (e.seekOffset || 10)); });
    on('seekto', (e) => { if (hasAudio() && e.seekTime != null) audio.currentTime = e.seekTime; });
  }

  // ---------- continuous reading ----------
  const playQueue = async (ids) => {
    if (!ids.length) { toast('No pages to play.'); return; }
    queue = ids;
    await goQueue(0);
  };
  const goQueue = async (i) => {
    const pages = await db.all();
    const page = pages.find((p) => p.id === queue[i]);
    if (!page) return;
    qi = i;
    page.pos = 0;
    openPage(page, { keepQueue: true });
    if (nav.stack[nav.i].screen !== 'page') go({ screen: 'page', pageId: page.id });
    else nav.stack[nav.i] = { screen: 'page', pageId: page.id };
    idx = 0;
    if (hasAudio()) audio.currentTime = 0;
    begin();
  };
  const nextInQueue = () => {
    if (queue.length && qi < queue.length - 1) goQueue(qi + 1);
    else if (queue.length > 1) { toast('Finished all pages.'); queue = []; qi = -1; updateWhere(); }
  };

  // ---------- making & saving audio ----------
  let nativeInfo = null;
  let making = false;
  const makeAudio = async (page) => {
    if (!native || making) return;
    making = true;
    $('save-page').disabled = true;
    const built = buildUnits(page.paras);
    const st = style();
    const v = voice();
    const job = {
      id: page.id + ':' + Date.now(),
      units: built.map((b, i) => {
        const text = b.toks.map((k) => k.t).join(' ');
        return { text: spokenForm(text), speak: !isTamil(text), paraEnd: !built[i + 1] || built[i + 1].pi !== b.pi };
      }),
      sid: v.sid, speed: st.speed, pause: st.pause, paraPause: st.paraPause,
    };
    const t0 = Date.now();
    setProgress(`Making audio with ${v.name} · ${st.name}…`, 0.01);
    try {
      const res = await native.makeAudio(job, (p) => {
        const left = p.done ? ((Date.now() - t0) / p.done) * (p.total - p.done) / 1000 : 0;
        setProgress(`Making audio with ${v.name} · ${st.name} — sentence ${p.done} of ${p.total}${left > 5 ? `, about ${Math.ceil(left / 60)} min left` : ''}`, p.done / p.total);
      });
      page.audio = new Blob([res.mp3], { type: 'audio/mpeg' });
      page.timings = res.timings;
      page.voice = v.id;
      page.style = st.id;
      await db.put(page);
      const saved = await saveToFolder(page);
      hideProgress();
      if (current && current.id === page.id) { current = page; loadAudio(); updateAudioChip(); }
      renderLibrary();
      toast(saved ? `Audio saved to Thendral › ${bookOf(page)}` : 'Audio ready.', 4000);
    } catch (err) {
      console.error(err);
      setProgress('Could not make the audio: ' + (err.message || err), 0);
    } finally {
      making = false;
      $('save-page').disabled = false;
    }
  };

  const bundleJSON = (p) => JSON.stringify({
    app: 'thendral', v: 1, id: p.id, title: p.title, book: bookOf(p), created: p.created, lang: p.lang,
    paras: p.paras, timings: p.timings || null, voice: p.voice || null, style: p.style || null,
    audioFile: p.audio ? fileBase(p) + '.mp3' : null, photoFile: p.photo ? fileBase(p) + '.jpg' : null,
  });

  const pageText = (p) => p.title + '\n\n' + p.paras.map(paraText).join('\n\n') + '\n';

  const saveToFolder = async (p) => {
    if (!native) return false;
    await native.savePage({
      book: bookOf(p),
      base: fileBase(p),
      mp3: p.audio ? new Uint8Array(await p.audio.arrayBuffer()) : null,
      photo: p.photo ? new Uint8Array(await p.photo.arrayBuffer()) : null,
      json: bundleJSON(p),
      text: pageText(p),
    });
    return true;
  };


  // ---------- save text / photo ----------
  const shareFile = async (files) => {
    if (navigator.canShare && navigator.canShare({ files })) {
      try { await navigator.share({ files, title: current.title }); return true; } catch { return false; }
    }
    return null;   // this browser cannot hand files to the share sheet
  };
  // one button: photo + text + audio together
  const savePage = async () => {
    if (!current) return;
    if (native) {
      if (hasAudio() && current.voice === voiceId && current.style === styleId) {
        await saveToFolder(current);
        toast(`Saved to Thendral › ${bookOf(current)}: photo, text and audio`, 4000);
      } else {
        makeAudio(current);   // records with the chosen voice, then saves everything
      }
      return;
    }
    const files = [new File([pageText(current)], fileBase(current) + '.txt', { type: 'text/plain' })];
    if (current.photo) files.unshift(new File([current.photo], fileBase(current) + '.jpg', { type: 'image/jpeg' }));
    if (current.audio) files.push(new File([current.audio], fileBase(current) + '.mp3', { type: 'audio/mpeg' }));
    const r = await shareFile(files);
    if (r === null) toast('This browser cannot save files here. On the laptop app, Save page puts everything in your Thendral folder.', 5000);
    else if (r && !current.audio) toast('Saved photo and text. Audio comes from the laptop app.', 4000);
  };

  const updateAudioChip = () => {
    const chip = $('audio-chip');
        if (!current) return;
    if (hasAudio()) {
      const v = VOICES.find((x) => x.id === current.voice);
      const s = STYLES.find((x) => x.id === current.style);
      chip.className = 'chip ok';
      chip.textContent = `● Audio saved${v ? ' · ' + v.name : ''}${s ? ' · ' + s.name : ''}`;
    } else {
      chip.className = 'chip';
      chip.textContent = native ? 'No audio yet' : 'Phone voice (make audio on laptop)';
    }
    const label = $('save-page-label');
    if (native) label.textContent = !hasAudio() ? 'Save page' : (current.voice !== voiceId || current.style !== styleId) ? `Save page with ${voice().name}` : 'Save page';
    else label.textContent = 'Save page';
    $('save-where').textContent = native
      ? `Photo, text and ${voice().name}'s audio go into your Thendral folder › ${bookOf(current)}`
      : 'Opens the share sheet. Choose “Save to Files” to keep the photo, text and audio together.';
    updateBanner();
  };

  // ---------- import (iPhone: pages from the Thendral folder) ----------
  const importFiles = async (files) => {
    const list = [...files];
    const jsons = list.filter((f) => /\.json$/i.test(f.name));
    if (!jsons.length) { toast('Choose the .thendral.json files together with their .mp3 and .jpg files.', 4500); return; }
    let count = 0;
    let first = null;
    setProgress('Importing pages…', 0.05);
    for (const jf of jsons) {
      try {
        const data = JSON.parse(await jf.text());
        if (data.app !== 'thendral') continue;
        const stem = jf.name.replace(/\.thendral\.json$/i, '').replace(/\.json$/i, '');
        const find = (name, ext) => list.find((f) => f.name === name) || list.find((f) => f.name.toLowerCase() === (stem + ext).toLowerCase());
        const mp3 = find(data.audioFile, '.mp3');
        const jpg = find(data.photoFile, '.jpg');
        let thumb = null;
        if (jpg) { try { thumb = await toBlob(draw(await loadBitmap(jpg), 200), 0.7); } catch { /* keep going */ } }
        const rec = {
          id: data.id, created: data.created, title: data.title, book: data.book, lang: data.lang, paras: data.paras,
          timings: mp3 ? data.timings : null, voice: data.voice, style: data.style,
          audio: mp3 ? new Blob([await mp3.arrayBuffer()], { type: 'audio/mpeg' }) : null,
          photo: jpg ? new Blob([await jpg.arrayBuffer()], { type: 'image/jpeg' }) : null,
          thumb, pos: 0,
        };
        await db.put(rec);
        if (!first || rec.created < first.created) first = rec;
        count++;
        setProgress(`Importing pages… ${count} of ${jsons.length}`, count / jsons.length);
      } catch (err) { console.error(err); }
    }
    hideProgress();
    if (first) { openPage(first); go({ screen: 'page', pageId: first.id }); } else await renderLibrary();
    toast(count ? `Imported ${count} page${count > 1 ? 's' : ''}. They now play offline.` : 'Nothing could be imported from those files.', 4000);
  };

  // ---------- editing ----------
  const toggleEdit = () => {
    if (!current) return;
    if ($('editbox').hidden) {
      pause();
      $('editview').value = current.paras.map(paraText).join('\n\n');
      $('editbox').hidden = false;
      $('readview').hidden = true;
      $('edit-toggle').textContent = 'Done';
      return;
    }
    const texts = $('editview').value.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);
    const changed = texts.join('\n\n') !== current.paras.map(paraText).join('\n\n');
    current.paras = texts.map((t, i) => {
      const old = current.paras[i];
      if (old && paraText(old) === t) return old;     // unchanged: keep word positions
      return { tokens: t.split(/\s+/).map((x) => ({ t: x, b: null })), box: old ? old.box : null, heading: old ? old.heading : false };
    });
    if (changed) { current.audio = null; current.timings = null; }   // audio no longer matches the text
    current.title = titleOf(current.paras);
    current.pos = 0;
    db.put(current).then(renderLibrary);
    $('page-title').textContent = current.title;
    $('editbox').hidden = true;
    $('readview').hidden = false;
    $('edit-toggle').textContent = 'Edit text';
    renderText();
    renderBoxes();
    loadAudio();
    updateAudioChip();
    if (changed && native) toast('Text changed. Tap “Save page” at the bottom to update the recording.', 4000);
  };

  // ---------- library ----------
  const thumbURLs = [];
  let ordered = [];
  const renderLibrary = async () => {
    let pages = [];
    try { pages = await db.all(); } catch { /* storage blocked */ }
    pages.sort((a, b) => bookOf(a).localeCompare(bookOf(b)) || a.created - b.created);
    ordered = pages;
    thumbURLs.splice(0).forEach((u) => URL.revokeObjectURL(u));
    const list = $('library-list');
    list.textContent = '';
    $('library-empty').hidden = pages.length > 0;
    $('play-all').hidden = !pages.length;
    $('select-mode').hidden = !pages.length;
    const books = new Map();
    for (const p of pages) { if (!books.has(bookOf(p))) books.set(bookOf(p), []); books.get(bookOf(p)).push(p); }
    $('book-names').innerHTML = '';
    for (const [name, items] of books) {
      const opt = document.createElement('option');
      opt.value = name;
      $('book-names').append(opt);
      const sec = document.createElement('section');
      sec.className = 'book';
      const head = document.createElement('div');
      head.className = 'book-head';
      const b = document.createElement('b');
      b.textContent = `${name} · ${items.length}`;
      const pa = document.createElement('button');
      pa.type = 'button';
      pa.className = 'book-play';
      pa.textContent = '▶ Play folder';
      pa.addEventListener('click', () => playQueue(items.map((x) => x.id)));
      head.append(b, pa);
      sec.append(head);
      for (const page of items) {
        const row = document.createElement('div');
        row.className = 'item' + (current && current.id === page.id ? ' on' : '');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.hidden = !selecting;
        cb.checked = selected.has(page.id);
        cb.setAttribute('aria-label', 'Select ' + page.title);
        cb.addEventListener('change', () => { cb.checked ? selected.add(page.id) : selected.delete(page.id); updateSelectBar(); });
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'open';
        const img = document.createElement('img');
        img.className = 'thumb';
        img.alt = '';
        if (page.thumb) { const u = URL.createObjectURL(page.thumb); thumbURLs.push(u); img.src = u; }
        const label = document.createElement('span');
        const t = document.createElement('b');
        t.textContent = page.title;
        const small = document.createElement('small');
        if (page.audio) { const d = document.createElement('span'); d.className = 'dot'; small.append(d, 'Audio · '); }
        small.append(fmtDate(page.created));
        label.append(t, small);
        open.append(img, label);
        open.addEventListener('click', () => { if (selecting) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); } else { openPage(page); go({ screen: 'page', pageId: page.id }); } });
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'del';
        del.textContent = 'Delete';
        del.hidden = selecting;
        del.addEventListener('click', async () => {
          if (del.dataset.armed !== '1') {
            del.dataset.armed = '1';
            del.textContent = 'Confirm';
            setTimeout(() => { del.dataset.armed = ''; del.textContent = 'Delete'; }, 3000);
            return;
          }
          await db.del(page.id);
          if (current && current.id === page.id) location.reload(); else renderLibrary();
        });
        row.append(cb, open, del);
        sec.append(row);
      }
      list.append(sec);
    }
  };
  const updateSelectBar = () => {
    $('select-bar').hidden = !selecting;
    $('select-count').textContent = `${selected.size} selected`;
    $('play-selected').disabled = !selected.size;
  };
  // ---------- screens with Back / Forward ----------
  const nav = { stack: [{ screen: 'page', pageId: null }], i: 0 };
  const inFrame = window.top !== window;
  const applyScreen = (e) => {
    const changed = document.body.dataset.screen !== e.screen;
    document.body.dataset.screen = e.screen;
    $('nav-back').disabled = nav.i === 0;
    $('nav-fwd').disabled = nav.i >= nav.stack.length - 1;
    const title = e.screen === 'library' ? 'Library' : e.screen === 'settings' ? 'Settings' : '';
    $('screen-title').textContent = title;
    $('screen-title').hidden = !title;
    $('open-library').setAttribute('aria-expanded', String(e.screen === 'library'));
    $('open-settings').setAttribute('aria-expanded', String(e.screen === 'settings'));
    if (changed) window.scrollTo(0, 0);
  };
  const show = async (e) => {
    if (e.pageId && (!current || current.id !== e.pageId)) {
      const p = (await db.all()).find((x) => x.id === e.pageId);
      if (p) openPage(p);
    }
    applyScreen(e);
  };
  const go = (entry) => {
    const cur = nav.stack[nav.i];
    if (cur.screen === entry.screen && (entry.pageId === undefined || cur.pageId === entry.pageId)) { applyScreen(cur); return; }
    if (entry.pageId === undefined) entry.pageId = current ? current.id : null;
    nav.stack = nav.stack.slice(0, nav.i + 1);
    nav.stack.push(entry);
    nav.i++;
    show(entry);
    if (!inFrame) { try { history.pushState({ thendral: nav.i }, ''); } catch { /* ignore */ } }
  };
  const back = () => { if (nav.i > 0) { nav.i--; show(nav.stack[nav.i]); } };
  const forward = () => { if (nav.i < nav.stack.length - 1) { nav.i++; show(nav.stack[nav.i]); } };
  window.addEventListener('popstate', (ev) => {   // phone back gesture in the installed app
    const target = ev.state && typeof ev.state.thendral === 'number' ? ev.state.thendral : 0;
    if (target !== nav.i && target >= 0 && target < nav.stack.length) { nav.i = target; show(nav.stack[nav.i]); }
  });
  $('nav-back').addEventListener('click', () => (inFrame ? back() : history.back()));
  $('nav-fwd').addEventListener('click', () => (inFrame ? forward() : history.forward()));
  if (!inFrame) { try { history.replaceState({ thendral: 0 }, ''); } catch { /* ignore */ } }

  // ---------- "your voice comes from the laptop" notice ----------
  const updateBanner = () => {
    const show = !native && !!current && !hasAudio() && !settings.get('bannerOk', false);
    $('voice-banner').hidden = !show;
    if (show) {
      const v = voice();
      const t = $('voice-banner-text');
      t.textContent = '';
      const b = document.createElement('b');
      b.textContent = `You are hearing your phone's own voice, not ${v.name}.`;
      t.append(b, ` ${v.name} and the other voices you chose are made by the Thendral laptop app. Once it is installed, each page you photograph comes with ${v.name}'s audio, and you import it here.`);
    }
  };
  $('voice-banner-ok').addEventListener('click', () => { settings.set('bannerOk', true); updateBanner(); });

  // ---------- settings ----------
  let previewAudio = null;
  const renderChoices = () => {
    const sl = $('style-list');
    sl.textContent = '';
    for (const s of STYLES) {
      const c = document.createElement('div');
      c.className = 'choice' + (s.id === styleId ? ' on' : '');
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'pick';
      pick.setAttribute('role', 'radio');
      pick.setAttribute('aria-checked', String(s.id === styleId));
      pick.innerHTML = '<b></b><small></small>';
      pick.querySelector('b').textContent = s.name;
      pick.querySelector('small').textContent = s.desc;
      pick.addEventListener('click', () => {
        styleId = s.id;
        settings.set('style', styleId);
        renderChoices();
        if (playing && !hasAudio()) speakCurrent();
        if (native && current && hasAudio() && current.style !== styleId) { toast('Tap “Save page” to record this page in the new style.', 3500); updateAudioChip(); }
      });
      c.append(pick);
      sl.append(c);
    }
    const vl = $('voice-list');
    vl.textContent = '';
    for (const v of VOICES) {
      const c = document.createElement('div');
      c.className = 'choice' + (v.id === voiceId ? ' on' : '');
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'pick';
      pick.setAttribute('role', 'radio');
      pick.setAttribute('aria-checked', String(v.id === voiceId));
      pick.innerHTML = '<b></b><small></small>';
      pick.querySelector('b').textContent = v.name;
      pick.querySelector('small').textContent = v.desc;
      pick.addEventListener('click', () => {
        voiceId = v.id;
        settings.set('kvoice', voiceId);
        renderChoices();
        updateBanner();
        if (native && current && hasAudio() && current.voice !== voiceId) { toast('Tap “Save page” to record this page with ' + v.name + '.', 3500); updateAudioChip(); }
      });
      const listen = document.createElement('button');
      listen.type = 'button';
      listen.className = 'listen';
      listen.textContent = '▶';
      listen.setAttribute('aria-label', 'Listen to ' + v.name);
      listen.addEventListener('click', () => {
        pause();
        if (previewAudio) previewAudio.pause();
        previewAudio = new Audio(base + 'voices/' + v.id + '.mp3');
        previewAudio.play().catch(() => toast('Could not play the sample.'));
      });
      c.append(pick, listen);
      vl.append(c);
    }
    $('voice-where').textContent = native
      ? 'Audio is made on this laptop and saved into your Thendral folder, ready for your iPhone.'
      : 'These voices are made by the Thendral app on your laptop. Pages without laptop audio use this device’s own voice.';
  };

  // ---------- wiring ----------
  $('camera').addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });
  $('picker').addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });
  $('importer').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
  $('import-btn').addEventListener('click', () => $('importer').click());

  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    if (files.some((f) => /\.json$/i.test(f.name))) importFiles(files); else handleFile(files[0]);
  });
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) handleFile(item.getAsFile());
  });

  $('lang').value = settings.get('lang', 'eng');
  $('lang').addEventListener('change', () => settings.set('lang', $('lang').value));
  const tapSaved = settings.get('tapmode', 'on');
  document.querySelectorAll('input[name="tapmode"]').forEach((r) => {
    r.checked = r.value === tapSaved;
    r.addEventListener('change', () => settings.set('tapmode', r.value));
  });

  $('open-library').addEventListener('click', () => (document.body.dataset.screen === 'library' ? back() : go({ screen: 'library' })));
  $('close-library').addEventListener('click', back);
  $('open-settings').addEventListener('click', () => (document.body.dataset.screen === 'settings' ? back() : go({ screen: 'settings' })));
  $('close-settings').addEventListener('click', back);
  $('edit-toggle').addEventListener('click', toggleEdit);
  $('save-page').addEventListener('click', () => savePage());

  // ---------- voice & style menu (⋮) ----------
  const menuOpen = (open) => {
    $('voice-menu').hidden = !open;
    $('more').setAttribute('aria-expanded', String(open));
  };
  $('more').addEventListener('click', (e) => { e.stopPropagation(); menuOpen($('voice-menu').hidden); });
  document.addEventListener('click', (e) => { if (!$('voice-menu').hidden && !e.target.closest('#voice-menu, #more')) menuOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menuOpen(false); });
  $('book-input').addEventListener('change', async () => {
    if (!current) return;
    current.book = $('book-input').value.trim() || 'My pages';
    settings.set('lastBook', current.book);
    await db.put(current);
    renderLibrary();
    if (native && current.audio) saveToFolder(current);
  });

  $('play-all').addEventListener('click', () => playQueue(ordered.map((p) => p.id)));
  $('select-mode').addEventListener('click', () => {
    selecting = !selecting;
    selected.clear();
    $('select-mode').textContent = selecting ? 'Cancel' : 'Select pages';
    updateSelectBar();
    renderLibrary();
  });
  $('play-selected').addEventListener('click', () => {
    const ids = ordered.filter((p) => selected.has(p.id)).map((p) => p.id);
    selecting = false;
    $('select-mode').textContent = 'Select pages';
    updateSelectBar();
    playQueue(ids);
  });

  document.querySelectorAll('.vt').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  const setView = (v) => {
    document.querySelectorAll('.vt').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    $('panes').className = 'panes view-' + v;
    settings.set('view', v);
  };
  setView(settings.get('view', 'both'));

  $('play').addEventListener('click', () => (playing ? pause() : play()));
  $('back').addEventListener('click', () => step(-1));
  $('fwd').addEventListener('click', () => step(1));
  $('slower').addEventListener('click', () => setRate(rate - 0.1));
  $('faster').addEventListener('click', () => setRate(rate + 0.1));
  $('rate-out').addEventListener('click', () => {
    const next = RATES.find((r) => r > rate + 0.01);
    setRate(next || RATES[0]);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('textarea, input, select')) return;
    if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
    if (e.code === 'ArrowDown' || e.code === 'ArrowRight') step(1);
    if (e.code === 'ArrowUp' || e.code === 'ArrowLeft') step(-1);
  });

  // keep page content clear of the docked player and toolbar, whatever their height
  const player = document.querySelector('.player');
  const topbar = document.querySelector('.top');
  const syncBars = () => {
    document.documentElement.style.setProperty('--player-h', player.offsetHeight + 'px');
    document.documentElement.style.setProperty('--top-h', topbar.offsetHeight + 'px');
  };
  if ('ResizeObserver' in window) { const ro = new ResizeObserver(syncBars); ro.observe(player); ro.observe(topbar); }
  syncBars();

  if ('speechSynthesis' in window) {
    loadDeviceVoices();
    speechSynthesis.addEventListener?.('voiceschanged', loadDeviceVoices);
  }

  if (native) {
    $('import-btn').hidden = true;
    $('folder-group').hidden = false;
    native.info().then((info) => {
      nativeInfo = info;
      $('folder-path').textContent = info.folder;
      if (!info.voiceReady) toast('The voice files are missing from this install, so the device voice is used.', 5000);
    });
    $('change-folder').addEventListener('click', async () => { const r = await native.chooseFolder(); $('folder-path').textContent = r.folder; });
    $('open-folder').addEventListener('click', () => native.openFolder(current ? bookOf(current) : ''));
  }

  applyScreen(nav.stack[0]);
  setRate(rate, false);
  renderChoices();
  renderText();
  renderLibrary().then(async () => {
    try {
      const pages = (await db.all()).sort((a, b) => b.created - a.created);
      if (pages[0] && !current) { openPage(pages[0]); nav.stack[0].pageId = pages[0].id; }
    } catch { /* storage blocked */ }
  });

  // ---------- offline install ----------
  if ('serviceWorker' in navigator && location.protocol === 'https:' && !/claude\.ai|claudeusercontent/.test(location.host)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
