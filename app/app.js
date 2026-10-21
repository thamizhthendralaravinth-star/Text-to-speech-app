/* Thendral Text-to-Speech: photo → offline OCR (Tesseract) → device voice, with saved pages. */
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
      get: (id) => run('readonly', (s) => s.get(id)),
      all: () => run('readonly', (s) => s.getAll()),
      del: (id) => run('readwrite', (s) => s.delete(id)),
    };
  })();

  // ---------- state ----------
  let current = null;          // the open page record
  let sentences = [];          // [{text, tamil, el}]
  let idx = 0;                 // sentence being read
  let playing = false;
  let speakToken = 0;          // ignores stale utterance events after cancel
  let rate = settings.get('rate', 1);
  let voices = [];
  let wakeLock = null;

  // ---------- helpers ----------
  const TAMIL = /[஀-௿]/g;
  const isTamil = (s) => {
    const letters = s.replace(/[\s\d\p{P}]/gu, '').length || 1;
    return ((s.match(TAMIL) || []).length / letters) > 0.3;
  };

  const toast = (msg) => {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
  };

  // Tesseract keeps the printed line breaks; rebuild real paragraphs.
  const cleanText = (raw) => raw
    .replace(/\r/g, '')
    .replace(/([A-Za-z])-\n([a-z])/g, '$1$2')      // re-join hyphenated words
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter((p) => p.length > 1)
    .join('\n\n');

  const ABBREV = /\b(?:e\.g|i\.e|etc|vs|Dr|Mr|Mrs|Ms|Prof|Fig|Figs|No|Vol|approx|Ch|Sec|Ref|St|mg|ml|cm|mm|kg|Inc|Ltd)\.$/i;

  const splitSentences = (para) => {
    const out = [];
    let buf = '';
    for (const part of para.split(/(?<=[.!?।:;])\s+/)) {
      buf = buf ? buf + ' ' + part : part;
      if (ABBREV.test(buf) || /\b[A-Z]\.$/.test(buf)) continue;   // "Dr." or an initial
      out.push(buf);
      buf = '';
    }
    if (buf) out.push(buf);
    // very long sentences stall some voices; break them at commas
    return out.flatMap((s) => {
      if (s.length <= 260) return [s];
      const pieces = [];
      let chunk = '';
      for (const w of s.split(/(?<=,)\s+/)) {
        if ((chunk + ' ' + w).length > 220 && chunk) { pieces.push(chunk); chunk = w; }
        else chunk = chunk ? chunk + ' ' + w : w;
      }
      if (chunk) pieces.push(chunk);
      return pieces;
    });
  };

  const titleFrom = (text) => {
    const first = (text.split('\n').find((l) => l.trim()) || 'Untitled page').trim();
    return first.length > 70 ? first.slice(0, 68) + '…' : first;
  };

  const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  // ---------- image handling ----------
  const loadBitmap = async (file) => {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
      } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
  };

  const draw = (src, maxSide, filter) => {
    const w = src.width, h = src.height;
    const k = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    const ctx = c.getContext('2d');
    if (filter) ctx.filter = filter;
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  };

  const toBlob = (canvas, q) => new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));

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
        if (m.status === 'recognizing text') setProgress('Reading the page…', m.progress);
        else if (m.status) setProgress('Preparing the reader…', m.progress * 0.3);
      },
    });
    workerLangs = langs;
    return worker;
  };

  const setProgress = (label, p) => {
    $('status-text').textContent = label;
    $('meter-fill').style.width = Math.round((p || 0) * 100) + '%';
  };

  const handleFile = async (file) => {
    if (!file || !file.type.startsWith('image/')) { toast('Please choose a photo or image file.'); return; }
    stop();
    const langs = document.querySelector('input[name="lang"]:checked').value;
    const status = $('status');
    status.hidden = false;
    setProgress('Preparing the photo…', 0.02);

    try {
      const bmp = await loadBitmap(file);
      const photoCanvas = draw(bmp, 1800);
      const photo = await toBlob(photoCanvas, 0.82);
      const thumb = await toBlob(draw(bmp, 160), 0.7);
      $('preview').src = URL.createObjectURL(thumb);

      const ocrCanvas = draw(bmp, 2600, 'grayscale(1) contrast(1.25)');
      const w = await getWorker(langs);
      const { data } = await w.recognize(ocrCanvas);
      const text = cleanText(data.text || '');

      if (!text) {
        setProgress('No text found. Try again closer to the page, in brighter light.', 0);
        return;
      }

      const page = {
        id: String(Date.now()),
        created: Date.now(),
        title: titleFrom(text),
        text,
        lang: langs,
        photo,
        thumb,
        rate,
        voiceURI: $('voice').value || null,
        pos: 0,
        confidence: Math.round(data.confidence || 0),
      };
      await db.put(page);
      status.hidden = true;
      openPage(page);
      renderHistory();
      toast(page.confidence && page.confidence < 60
        ? 'Saved. Some words may be wrong: retake in better light or fix them under Edit.'
        : 'Saved. Tap play to listen.');
    } catch (err) {
      console.error(err);
      setProgress('Could not read this photo. Try another one.', 0);
    }
  };

  // ---------- reader view ----------
  const showView = (name) => {
    for (const v of ['read', 'photo', 'edit']) $('view-' + v).classList.toggle('on', v === name);
    $('readview').hidden = name !== 'read';
    $('photoview').hidden = name !== 'photo';
    $('editview').hidden = name !== 'edit';
    if (name === 'read' && current && $('editview').value !== current.text) {
      current.text = $('editview').value;
      current.title = titleFrom(current.text);
      db.put(current).then(renderHistory);
      renderText();
    }
  };

  const renderText = () => {
    const view = $('readview');
    view.textContent = '';
    sentences = [];
    if (!current) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'Take a photo of a textbook page. The text will appear here and the play button will read it aloud.';
      view.append(p);
      $('voice-note').hidden = true;
      return;
    }
    const hasTamilVoice = !!pickVoice(true);
    let skipped = 0;
    for (const para of current.text.split(/\n\s*\n/)) {
      const p = document.createElement('p');
      for (const s of splitSentences(para.trim())) {
        const span = document.createElement('span');
        const tamil = isTamil(s);
        span.className = 's' + (tamil ? ' ta' : '');
        if (tamil) span.lang = 'ta';
        if (tamil && !hasTamilVoice) { span.classList.add('skip'); skipped++; }
        span.textContent = s + ' ';
        const i = sentences.length;
        span.addEventListener('click', () => { idx = i; play(); });
        sentences.push({ text: s, tamil, el: span });
        p.append(span);
      }
      view.append(p);
    }
    const note = $('voice-note');
    note.hidden = !skipped;
    note.textContent = skipped
      ? `This device has no Tamil voice, so ${skipped} Tamil sentence${skipped > 1 ? 's are' : ' is'} shown but not read aloud. On iPhone, look under Settings › Accessibility › Spoken Content › Voices; on Windows, add the Tamil speech pack under Settings › Time & language › Speech.`
      : '';
    idx = Math.min(current.pos || 0, Math.max(0, sentences.length - 1));
    mark();
  };

  const mark = () => {
    sentences.forEach((s, i) => s.el.classList.toggle('now', i === idx && (playing || idx > 0)));
  };

  const openPage = (page) => {
    stop();
    current = page;
    $('page-title').textContent = page.title;
    $('editview').value = page.text;
    $('photo-full').src = page.photo ? URL.createObjectURL(page.photo) : '';
    $('view-photo').hidden = !page.photo;
    if (page.rate) setRate(page.rate, false);
    if (page.voiceURI && voices.some((v) => v.voiceURI === page.voiceURI)) $('voice').value = page.voiceURI;
    showView('read');
    renderText();
    window.scrollTo({ top: $('readview').offsetTop - 80, behavior: 'smooth' });
  };

  // ---------- voices ----------
  const loadVoices = () => {
    voices = speechSynthesis.getVoices().filter((v) => /^(en|ta)/i.test(v.lang));
    const sel = $('voice');
    const want = (current && current.voiceURI) || settings.get('voice', null);
    sel.textContent = '';
    const english = voices.filter((v) => /^en/i.test(v.lang));
    // offline voices first: they work without internet
    english.sort((a, b) => (b.localService - a.localService) || (/en-(IN|GB)/i.test(b.lang) - /en-(IN|GB)/i.test(a.lang)));
    for (const v of english) {
      const o = document.createElement('option');
      o.value = v.voiceURI;
      o.textContent = `${v.name} (${v.lang})${v.localService ? '' : ' · needs internet'}`;
      sel.append(o);
    }
    if (!english.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'Default voice';
      sel.append(o);
    }
    if (want && english.some((v) => v.voiceURI === want)) sel.value = want;
    if (current) renderText();
  };

  const pickVoice = (tamil) => {
    if (tamil) return voices.find((v) => /^ta/i.test(v.lang) && v.localService) || voices.find((v) => /^ta/i.test(v.lang)) || null;
    return voices.find((v) => v.voiceURI === $('voice').value) || null;
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
    // skip sentences this device cannot voice
    while (idx < sentences.length && sentences[idx].tamil && !pickVoice(true)) idx++;
    if (idx >= sentences.length) { finish(); return; }

    const s = sentences[idx];
    const u = new SpeechSynthesisUtterance(s.text);
    const v = pickVoice(s.tamil);
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = s.tamil ? 'ta-IN' : 'en-IN';
    u.rate = rate;
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
    mark();
    s.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // a tick after cancel() avoids a dropped first utterance in Chrome/Electron
    setTimeout(() => { if (token === speakToken) speechSynthesis.speak(u); }, 60);
  };

  const play = () => {
    if (!sentences.length) { toast('Take a photo first.'); return; }
    if (idx >= sentences.length) idx = 0;
    playing = true;
    setPlayIcon();
    keepAwake(true);
    speakCurrent();
  };

  const pause = () => {
    playing = false;
    speakToken++;
    speechSynthesis.cancel();
    setPlayIcon();
    keepAwake(false);
    savePos();
    mark();
  };

  const stop = () => { if (playing) pause(); };

  const finish = () => {
    playing = false;
    idx = 0;
    setPlayIcon();
    keepAwake(false);
    savePos();
    mark();
  };

  const step = (d) => {
    if (!sentences.length) return;
    idx = Math.max(0, Math.min(sentences.length - 1, idx + d));
    if (playing) speakCurrent(); else mark();
  };

  const savePos = () => {
    if (!current) return;
    current.pos = idx;
    current.rate = rate;
    current.voiceURI = $('voice').value || null;
    db.put(current).catch(() => {});
  };

  const setRate = (r, restart = true) => {
    rate = Math.round(Math.max(0.5, Math.min(2, r)) * 100) / 100;
    $('rate-out').textContent = rate.toFixed(rate % 0.25 === 0 && rate % 0.5 ? 2 : 1) + '×';
    document.querySelectorAll('.presets button').forEach((b) => b.classList.toggle('on', Number(b.dataset.rate) === rate));
    settings.set('rate', rate);
    if (restart && playing) speakCurrent();   // apply the new speed right away
    if (restart) savePos();
  };

  const keepAwake = async (on) => {
    try {
      if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch { wakeLock = null; }
  };

  // ---------- history ----------
  const renderHistory = async () => {
    let pages = [];
    try { pages = (await db.all()).sort((a, b) => b.created - a.created); } catch { /* storage blocked */ }
    const list = $('history-list');
    list.textContent = '';
    $('history-empty').hidden = pages.length > 0;
    for (const page of pages) {
      const li = document.createElement('li');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'open';
      const img = document.createElement('img');
      img.className = 'thumb';
      img.alt = '';
      if (page.thumb) img.src = URL.createObjectURL(page.thumb);
      const label = document.createElement('span');
      const b = document.createElement('b');
      b.textContent = page.title;
      const small = document.createElement('small');
      const progress = page.pos ? ' · resumes where you stopped' : '';
      small.textContent = `${fmtDate(page.created)} · ${(page.rate || 1)}×${progress}`;
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
          del.textContent = 'Tap to confirm';
          setTimeout(() => { del.dataset.armed = ''; del.textContent = 'Delete'; }, 3000);
          return;
        }
        await db.del(page.id);
        if (current && current.id === page.id) { stop(); current = null; $('page-title').textContent = 'Text'; $('view-photo').hidden = true; showView('read'); renderText(); }
        renderHistory();
      });
      li.append(open, del);
      list.append(li);
    }
  };

  // ---------- wiring ----------
  $('camera').addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });
  $('picker').addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });

  const capture = document.querySelector('.capture');
  document.addEventListener('dragover', (e) => { e.preventDefault(); capture.classList.add('drag'); });
  document.addEventListener('dragleave', () => capture.classList.remove('drag'));
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    capture.classList.remove('drag');
    handleFile(e.dataTransfer.files[0]);
  });
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) handleFile(item.getAsFile());
  });

  document.querySelectorAll('input[name="lang"]').forEach((r) => {
    if (r.value === settings.get('lang', 'eng')) r.checked = true;
    r.addEventListener('change', () => settings.set('lang', r.value));
  });

  $('view-read').addEventListener('click', () => showView('read'));
  $('view-photo').addEventListener('click', () => showView('photo'));
  $('view-edit').addEventListener('click', () => { stop(); showView('edit'); });

  $('play').addEventListener('click', () => (playing ? pause() : play()));
  $('back').addEventListener('click', () => step(-1));
  $('fwd').addEventListener('click', () => step(1));
  $('slower').addEventListener('click', () => setRate(rate - 0.1));
  $('faster').addEventListener('click', () => setRate(rate + 0.1));
  document.querySelectorAll('.presets button').forEach((b) => b.addEventListener('click', () => setRate(Number(b.dataset.rate))));
  $('voice').addEventListener('change', () => {
    settings.set('voice', $('voice').value);
    savePos();
    if (playing) speakCurrent();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('textarea, input, select')) return;
    if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
    if (e.code === 'ArrowRight') step(1);
    if (e.code === 'ArrowLeft') step(-1);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && playing && wakeLock === null) keepAwake(true);
  });

  if ('speechSynthesis' in window) {
    loadVoices();
    speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
  } else {
    $('play').disabled = true;
    toast('This browser cannot read aloud.');
  }

  // keep page content clear of the docked player, whatever its height
  const player = document.querySelector('.player');
  const syncPlayerHeight = () => document.documentElement.style.setProperty('--player-h', player.offsetHeight + 'px');
  if ('ResizeObserver' in window) new ResizeObserver(syncPlayerHeight).observe(player);
  syncPlayerHeight();

  setRate(rate, false);
  renderText();
  renderHistory();

  // ---------- offline install (iPhone / browsers) ----------
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => { $('offline').hidden = false; }).catch(() => {});
  } else if (location.protocol === 'app:') {
    $('offline').hidden = false;   // desktop app: everything is bundled
  }
})();
