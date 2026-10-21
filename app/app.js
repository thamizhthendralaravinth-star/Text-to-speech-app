/* Thendral Text-to-Speech: photo → offline OCR (Tesseract) → paragraphs matched to the photo → device voice. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const base = new URL('.', location.href).href;

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

  // ---------- saved pages (IndexedDB: holds photos too) ----------
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
  let current = null;      // open page record: {id, created, title, paras:[{tokens:[{t,b}], box, heading}], photo, thumb, rate, voiceURI, pos}
  let units = [];          // sentences in reading order: {pi, text, tamil, el, words:[{el, start, b}]}
  let paraEls = [];        // text paragraph elements
  let boxEls = [];         // photo paragraph boxes
  let idx = 0;             // sentence being read
  let stopAtPara = -1;     // "read only that paragraph"
  let playing = false;
  let speakToken = 0;
  let rate = settings.get('rate', 1);
  let voiceURI = settings.get('voice', null);
  let voices = [];
  let wakeLock = null;
  let photoURL = null;

  // ---------- helpers ----------
  const isTamil = (s) => {
    const letters = s.replace(/[\s\d\p{P}]/gu, '').length || 1;
    return ((s.match(/[஀-௿]/g) || []).length / letters) > 0.3;
  };

  const toast = (msg) => {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2800);
  };

  const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const paraText = (p) => p.tokens.map((k) => k.t).join(' ');
  const titleOf = (paras) => {
    const first = paras.length ? paraText(paras[0]) : 'Untitled page';
    return first.length > 70 ? first.slice(0, 68) + '…' : first;
  };

  const ABBREV = /^(?:e\.g|i\.e|etc|vs|Dr|Mr|Mrs|Ms|Prof|Fig|Figs|No|Vol|approx|Ch|Sec|Ref|St|Inc|Ltd|[A-Z])\.$/i;
  const endsSentence = (tok) => /[.!?।:;]["')\]]*$/.test(tok) && !ABBREV.test(tok.replace(/^[("'[]+/, ''));

  // ---------- image handling ----------
  const loadBitmap = async (file) => {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch {
      const url = URL.createObjectURL(file);
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

  // ---------- OCR ----------
  let worker = null;
  let workerLangs = '';

  const setProgress = (label, p) => {
    $('status-text').textContent = label;
    $('meter-fill').style.width = Math.round((p || 0) * 100) + '%';
  };

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
    for (const b of blocks || []) {
      for (const p of b.paragraphs || []) {
        for (const l of p.lines || []) {
          const words = (l.words || []).filter((w) => w.text && w.text.trim() && w.confidence > 15);
          if (words.length) lines.push({ bbox: l.bbox, words });
        }
      }
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
      const h = l.bbox.y1 - l.bbox.y0;
      const heading = h > medH * 1.3;
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
        for (const w of l.words) {
          const t = w.text.trim();
          const last = tokens[tokens.length - 1];
          // re-join a word hyphenated across the line end
          if (last && last.hy && /^[a-z]/.test(t)) {
            last.t = last.t.slice(0, -1) + t;
            last.b2 = norm(w.bbox);
            delete last.hy;
            continue;
          }
          tokens.push({ t, b: norm(w.bbox), hy: w === l.words[l.words.length - 1] && /[A-Za-z]-$/.test(t) || undefined });
        }
      }
      tokens.forEach((k) => delete k.hy);
      const x0 = Math.min(...grp.lines.map((l) => l.bbox.x0));
      const y0 = Math.min(...grp.lines.map((l) => l.bbox.y0));
      const x1 = Math.max(...grp.lines.map((l) => l.bbox.x1));
      const y1 = Math.max(...grp.lines.map((l) => l.bbox.y1));
      return { tokens, box: norm({ x0, y0, x1, y1 }), heading: grp.heading && grp.lines.length <= 2 };
    }).filter((p) => p.tokens.length);
  };

  const handleFile = async (file) => {
    if (!file || !file.type.startsWith('image/')) { toast('Please choose a photo or image file.'); return; }
    stop();
    const langs = $('lang').value;
    $('status').hidden = false;
    setProgress('Preparing the photo…', 0.02);

    try {
      const bmp = await loadBitmap(file);
      const photoCanvas = draw(bmp, 2000);
      const photo = await toBlob(photoCanvas, 0.85);
      const thumb = await toBlob(draw(bmp, 200), 0.7);
      const ocrCanvas = draw(bmp, 2600, 'grayscale(1) contrast(1.2)');

      const w = await getWorker(langs);
      const { data } = await w.recognize(ocrCanvas, {}, { blocks: true, text: true });
      const paras = buildParas(data.blocks, ocrCanvas.width, ocrCanvas.height);

      if (!paras.length) {
        setProgress('No text found. Try again closer to the page, in brighter light.', 0);
        return;
      }
      const page = {
        id: String(Date.now()),
        created: Date.now(),
        title: titleOf(paras),
        paras,
        lang: langs,
        photo,
        thumb,
        rate,
        voiceURI,
        pos: 0,
        confidence: Math.round(data.confidence || 0),
      };
      await db.put(page);
      $('status').hidden = true;
      openPage(page);
      renderLibrary();
      toast(page.confidence && page.confidence < 60
        ? 'Saved. Some words may be wrong: retake in better light, or fix them with Edit text.'
        : 'Saved to your library. Tap ▶ or tap any paragraph.');
    } catch (err) {
      console.error(err);
      setProgress('Could not read this photo. Try another one.', 0);
    }
  };

  // ---------- page view ----------
  const openPage = (page) => {
    stop();
    // pages saved by the first version kept only text
    if (!page.paras && page.text) {
      page.paras = page.text.split(/\n\s*\n/).map((t) => ({ tokens: t.trim().split(/\s+/).map((x) => ({ t: x, b: null })), box: null }));
    }
    current = page;
    $('page-title').textContent = page.title;
    $('page-meta').textContent = `Saved ${fmtDate(page.created)} · ${page.paras.length} paragraph${page.paras.length === 1 ? '' : 's'}`;
    $('edit-toggle').hidden = false;
    $('edit-toggle').textContent = 'Edit text';
    $('editbox').hidden = true;
    $('readview').hidden = false;
    if (photoURL) URL.revokeObjectURL(photoURL);
    photoURL = page.photo ? URL.createObjectURL(page.photo) : null;
    $('photo').src = photoURL || '';
    $('photo-wrap').hidden = !photoURL;
    $('photo-empty').hidden = !!photoURL;
    if (page.rate) setRate(page.rate, false);
    if (page.voiceURI) { voiceURI = page.voiceURI; renderVoices(); }
    renderText();
    renderBoxes();
    closeLibrary();
    renderLibrary();
  };

  const renderText = () => {
    const view = $('readview');
    view.textContent = '';
    units = [];
    paraEls = [];
    if (!current) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'The text of your page appears here, laid out in the same paragraphs as the photo. Tap ▶ to hear it from the top, or tap any paragraph to hear just that part.';
      view.append(p);
      updateWhere();
      return;
    }
    const tamilVoice = !!pickVoice(true);
    let skipped = 0;
    current.paras.forEach((para, pi) => {
      const p = document.createElement('p');
      p.className = 'para' + (para.heading ? ' heading' : '');
      p.addEventListener('click', (e) => {
        const s = e.target.closest('.s');
        startAt(s ? Number(s.dataset.u) : firstUnitOf(pi), pi);
      });
      // split the paragraph's words into sentences
      let sent = [];
      const flush = () => {
        if (!sent.length) return;
        const text = sent.map((k) => k.t).join(' ');
        const span = document.createElement('span');
        const tamil = isTamil(text);
        span.className = 's' + (tamil ? ' ta' : '');
        if (tamil) span.lang = 'ta';
        if (tamil && !tamilVoice) { span.classList.add('skip'); skipped++; }
        span.dataset.u = units.length;
        const words = [];
        let offset = 0;
        sent.forEach((k, i) => {
          const w = document.createElement('span');
          w.className = 'w';
          w.textContent = k.t;
          span.append(w, i < sent.length - 1 ? ' ' : ' ');
          words.push({ el: w, start: offset, b: k.b, b2: k.b2 });
          offset += k.t.length + 1;
        });
        units.push({ pi, text, tamil, el: span, words });
        p.append(span);
        sent = [];
      };
      for (const k of para.tokens) {
        sent.push(k);
        if (endsSentence(k.t) || sent.length > 45) flush();
      }
      flush();
      paraEls.push(p);
      view.append(p);
    });
    const note = $('voice-note');
    note.hidden = !skipped;
    note.textContent = skipped
      ? `This device has no Tamil voice, so ${skipped} Tamil sentence${skipped > 1 ? 's are' : ' is'} shown but skipped. See Settings for how to add one.`
      : '';
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
      Object.assign(b.style, {
        left: (x0 - pad) * 100 + '%', top: (y0 - pad) * 100 + '%',
        width: (x1 - x0 + pad * 2) * 100 + '%', height: (y1 - y0 + pad * 2) * 100 + '%',
      });
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

  const mark = (wordIdx = -1) => {
    const u = units[idx];
    const active = playing || idx > 0;
    units.forEach((x, i) => x.el.classList.toggle('now', active && i === idx));
    document.querySelectorAll('.w.now').forEach((w) => w.classList.remove('now'));
    paraEls.forEach((p, i) => p.classList.toggle('now', active && u && i === u.pi));
    boxEls.forEach((b, i) => b && b.classList.toggle('now', active && u && i === u.pi));
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
    $('where').textContent = total ? `Paragraph ${u ? u.pi + 1 : 1} of ${total}` : 'No page open';
  };

  // keep the spoken paragraph in view in both panes
  const follow = () => {
    const u = units[idx];
    if (!u) return;
    // scroll the page itself (scrollIntoView can also shift the fixed bars on some browsers)
    const r = u.el.getBoundingClientRect();
    const topH = document.querySelector('.top').offsetHeight;
    const photoH = window.matchMedia('(max-width: 760px)').matches ? document.querySelector('.photo-pane').offsetHeight : 0;
    const bottomH = document.querySelector('.player').offsetHeight;
    const visTop = topH + photoH, visBottom = window.innerHeight - bottomH;
    if (r.top < visTop + 10 || r.bottom > visBottom - 10) {
      const target = window.scrollY + r.top - visTop - Math.max(20, (visBottom - visTop - r.height) / 3);
      window.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }
    const box = boxEls[u.pi];
    const sc = $('photo-scroll');
    if (box && sc.scrollHeight > sc.clientHeight) {
      const top = box.offsetTop - sc.clientHeight / 3;
      sc.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  };

  // ---------- voices ----------
  const quality = (v) => {
    const n = v.name;
    if (/premium|neural|natural/i.test(n)) return 3;
    if (/enhanced|siri|google/i.test(n)) return 2;
    if (/compact|eloquence|espeak/i.test(n) || /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Ralph|Kathy|Grandma|Grandpa|Rocko|Shelley|Flo|Eddy|Reed|Sandy)\b/.test(n)) return 0;
    return 1;
  };
  const qualityLabel = ['Basic', 'Standard', 'Enhanced', 'Premium'];

  const loadVoices = () => {
    voices = speechSynthesis.getVoices()
      .filter((v) => /^(en|ta)/i.test(v.lang))
      .sort((a, b) => (quality(b) - quality(a)) || (b.localService - a.localService) || (/en-(IN|GB)/i.test(b.lang) - /en-(IN|GB)/i.test(a.lang)) || a.name.localeCompare(b.name));
    const english = voices.filter((v) => /^en/i.test(v.lang));
    if (!english.some((v) => v.voiceURI === voiceURI)) voiceURI = english[0] ? english[0].voiceURI : null;
    renderVoices();
    if (current) renderText();
  };

  const renderVoices = () => {
    const list = $('voice-list');
    list.textContent = '';
    if (!voices.length) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="voice-pick"><b>Device default voice</b><small>No other voices reported by this device</small></span>';
      list.append(li);
      return;
    }
    for (const v of voices) {
      const li = document.createElement('li');
      li.classList.toggle('on', v.voiceURI === voiceURI);
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'voice-pick';
      pick.setAttribute('role', 'radio');
      pick.setAttribute('aria-checked', String(v.voiceURI === voiceURI));
      const q = quality(v);
      const name = document.createElement('b');
      name.textContent = v.name.replace(/\s*\((Premium|Enhanced)\)/i, '');
      const meta = document.createElement('small');
      meta.textContent = `${v.lang}${v.localService ? '' : ' · needs internet'} `;
      const tag = document.createElement('span');
      tag.className = 'q' + (q === 3 ? ' best' : '');
      tag.textContent = qualityLabel[q];
      meta.append(tag);
      pick.append(name, meta);
      pick.addEventListener('click', () => {
        if (/^ta/i.test(v.lang)) { toast('Tamil voices are used automatically for Tamil sentences.'); return; }
        voiceURI = v.voiceURI;
        settings.set('voice', voiceURI);
        savePos();
        renderVoices();
        if (playing) speakCurrent();
        else toast(`Voice set to ${name.textContent}`);
      });
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'voice-play';
      play.setAttribute('aria-label', `Listen to ${v.name}`);
      play.textContent = '▶';
      play.addEventListener('click', () => preview(v));
      li.append(pick, play);
      list.append(li);
    }
  };

  const preview = (v) => {
    pause();
    speechSynthesis.cancel();
    const sample = /^ta/i.test(v.lang)
      ? 'வணக்கம். இது தென்றல் உரை வாசிப்பான்.'
      : (units[0] ? units.slice(0, 2).map((u) => u.text).join(' ').slice(0, 200) : 'Postpartum haemorrhage is the leading cause of maternal mortality worldwide.');
    const u = new SpeechSynthesisUtterance(sample);
    u.voice = v;
    u.lang = v.lang;
    u.rate = rate;
    speechSynthesis.speak(u);
  };

  const pickVoice = (tamil) => {
    if (tamil) return voices.find((v) => /^ta/i.test(v.lang)) || null;
    return voices.find((v) => v.voiceURI === voiceURI) || null;
  };

  // ---------- playback ----------
  const setPlayIcon = () => {
    $('ico-play').hidden = playing;
    $('ico-pause').hidden = !playing;
    $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  };

  const speakCurrent = () => {
    const token = ++speakToken;
    speechSynthesis.cancel();
    while (idx < units.length && units[idx].tamil && !pickVoice(true)) idx++;
    if (idx >= units.length || (stopAtPara >= 0 && units[idx].pi !== stopAtPara)) { finish(); return; }

    const s = units[idx];
    const u = new SpeechSynthesisUtterance(s.text);
    const v = pickVoice(s.tamil);
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = s.tamil ? 'ta-IN' : 'en-IN';
    u.rate = rate;
    u.onboundary = (e) => {
      if (token !== speakToken || e.name && e.name !== 'word') return;
      let wi = 0;
      while (wi + 1 < s.words.length && s.words[wi + 1].start <= e.charIndex) wi++;
      mark(wi);
    };
    u.onend = () => {
      if (token !== speakToken || !playing) return;
      idx++;
      savePos();
      speakCurrent();
    };
    u.onerror = (e) => {
      if (token !== speakToken || e.error === 'interrupted' || e.error === 'canceled') return;
      idx++;
      speakCurrent();
    };
    mark(0);
    follow();
    // a short pause after cancel() avoids a dropped first utterance in Chrome/Electron
    setTimeout(() => { if (token === speakToken) speechSynthesis.speak(u); }, 60);
  };

  const startAt = (unitIdx, pi) => {
    if (!units.length) return;
    idx = unitIdx;
    const tapMode = document.querySelector('input[name="tapmode"]:checked').value;
    stopAtPara = tapMode === 'one' ? pi : -1;
    playing = true;
    setPlayIcon();
    keepAwake(true);
    speakCurrent();
  };

  const play = () => {
    if (!units.length) { toast('Take a photo first.'); return; }
    if (idx >= units.length) idx = 0;
    stopAtPara = -1;
    playing = true;
    setPlayIcon();
    keepAwake(true);
    speakCurrent();
  };

  const pause = () => {
    if (!playing) return;
    playing = false;
    speakToken++;
    speechSynthesis.cancel();
    setPlayIcon();
    keepAwake(false);
    savePos();
    mark();
  };

  const stop = () => pause();

  const finish = () => {
    playing = false;
    if (idx >= units.length) idx = 0;
    stopAtPara = -1;
    setPlayIcon();
    keepAwake(false);
    savePos();
    mark();
  };

  // previous / next paragraph
  const step = (d) => {
    if (!units.length) return;
    const pi = units[idx] ? units[idx].pi : 0;
    const target = Math.max(0, Math.min(current.paras.length - 1, pi + d));
    idx = firstUnitOf(target);
    if (playing) { stopAtPara = -1; speakCurrent(); } else { mark(); follow(); }
  };

  const savePos = () => {
    if (!current) return;
    current.pos = idx;
    current.rate = rate;
    current.voiceURI = voiceURI;
    db.put(current).catch(() => {});
  };

  const setRate = (r, restart = true) => {
    rate = Math.round(Math.max(0.5, Math.min(2, r)) * 100) / 100;
    $('rate-out').textContent = (Number.isInteger(rate * 2) ? rate.toFixed(1) : rate.toFixed(2)) + '×';
    document.querySelectorAll('.presets button').forEach((b) => b.classList.toggle('on', Number(b.dataset.rate) === rate));
    settings.set('rate', rate);
    if (restart && playing) speakCurrent();
    if (restart) savePos();
  };

  const keepAwake = async (on) => {
    try {
      if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch { wakeLock = null; }
  };

  // ---------- editing ----------
  const toggleEdit = () => {
    if (!current) return;
    const editing = $('editbox').hidden;
    if (editing) {
      pause();
      $('editview').value = current.paras.map(paraText).join('\n\n');
      $('editbox').hidden = false;
      $('readview').hidden = true;
      $('edit-toggle').textContent = 'Done';
      return;
    }
    const texts = $('editview').value.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);
    current.paras = texts.map((t, i) => {
      const old = current.paras[i];
      if (old && paraText(old) === t) return old;            // unchanged: keep word positions
      return { tokens: t.split(/\s+/).map((x) => ({ t: x, b: null })), box: old ? old.box : null, heading: old ? old.heading : false };
    });
    current.title = titleOf(current.paras);
    current.pos = 0;
    db.put(current).then(renderLibrary);
    $('page-title').textContent = current.title;
    $('editbox').hidden = true;
    $('readview').hidden = false;
    $('edit-toggle').textContent = 'Edit text';
    renderText();
    renderBoxes();
  };

  // ---------- library ----------
  const thumbURLs = [];
  const renderLibrary = async () => {
    let pages = [];
    try { pages = (await db.all()).sort((a, b) => b.created - a.created); } catch { /* storage blocked */ }
    thumbURLs.splice(0).forEach((u) => URL.revokeObjectURL(u));
    const list = $('history-list');
    list.textContent = '';
    $('history-empty').hidden = pages.length > 0;
    for (const page of pages) {
      const li = document.createElement('li');
      li.classList.toggle('on', !!current && current.id === page.id);
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'open';
      const img = document.createElement('img');
      img.className = 'thumb';
      img.alt = '';
      if (page.thumb) { const u = URL.createObjectURL(page.thumb); thumbURLs.push(u); img.src = u; }
      const label = document.createElement('span');
      const b = document.createElement('b');
      b.textContent = page.title;
      const small = document.createElement('small');
      small.textContent = `${fmtDate(page.created)} · ${page.rate || 1}×${page.pos ? ' · resumes' : ''}`;
      label.append(b, small);
      open.append(img, label);
      open.addEventListener('click', () => openPage(page));

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        if (del.dataset.armed !== '1') {
          del.dataset.armed = '1';
          del.textContent = 'Confirm';
          setTimeout(() => { del.dataset.armed = ''; del.textContent = 'Delete'; }, 3000);
          return;
        }
        await db.del(page.id);
        if (current && current.id === page.id) location.reload();
        else renderLibrary();
      });
      li.append(open, del);
      list.append(li);
    }
  };

  const openLibrary = () => { $('library').classList.add('open'); $('open-library').setAttribute('aria-expanded', 'true'); };
  const closeLibrary = () => { $('library').classList.remove('open'); $('open-library').setAttribute('aria-expanded', 'false'); };

  // ---------- wiring ----------
  $('camera').addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });
  $('picker').addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });

  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); });
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

  $('open-library').addEventListener('click', () => ($('library').classList.contains('open') ? closeLibrary() : openLibrary()));
  $('close-library').addEventListener('click', closeLibrary);
  $('open-settings').addEventListener('click', () => {
    const s = $('settings');
    s.hidden = !s.hidden;
    $('open-settings').setAttribute('aria-expanded', String(!s.hidden));
  });
  $('edit-toggle').addEventListener('click', toggleEdit);

  $('play').addEventListener('click', () => (playing ? pause() : play()));
  $('back').addEventListener('click', () => step(-1));
  $('fwd').addEventListener('click', () => step(1));
  $('slower').addEventListener('click', () => setRate(rate - 0.1));
  $('faster').addEventListener('click', () => setRate(rate + 0.1));
  document.querySelectorAll('.presets button').forEach((b) => b.addEventListener('click', () => setRate(Number(b.dataset.rate))));

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('textarea, input, select')) return;
    if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
    if (e.code === 'ArrowDown' || e.code === 'ArrowRight') step(1);
    if (e.code === 'ArrowUp' || e.code === 'ArrowLeft') step(-1);
  });

  // keep page content clear of the docked player, whatever its height
  const player = document.querySelector('.player');
  const topbar = document.querySelector('.top');
  const syncPlayerHeight = () => {
    document.documentElement.style.setProperty('--player-h', player.offsetHeight + 'px');
    document.documentElement.style.setProperty('--top-h', topbar.offsetHeight + 'px');
  };
  if ('ResizeObserver' in window) { const ro = new ResizeObserver(syncPlayerHeight); ro.observe(player); ro.observe(topbar); }
  syncPlayerHeight();

  if ('speechSynthesis' in window) {
    loadVoices();
    speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
  } else {
    $('play').disabled = true;
    toast('This browser cannot read aloud.');
  }

  setRate(rate, false);
  $('photo-wrap').hidden = true;
  renderText();
  renderLibrary().then(async () => {
    // reopen the most recent page so the app starts where you left off
    try {
      const pages = (await db.all()).sort((a, b) => b.created - a.created);
      if (pages[0] && !current) openPage(pages[0]);
    } catch { /* storage blocked */ }
  });

  // ---------- offline install ----------
  if ('serviceWorker' in navigator && location.protocol === 'https:' && !/claude\.ai|claudeusercontent/.test(location.host)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
