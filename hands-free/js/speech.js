/**
 * speech.js — TTS + Whisper VAD-based STT for Hands-Free Games
 *
 * Speech recognition runs entirely in-browser via Whisper. No audio is sent
 * to any server. The model (~40 MB, quantized) is downloaded once on first
 * mic use and cached in browser Cache Storage indefinitely.
 *
 * Recognition flow: mic stays open after each question; a lightweight Voice
 * Activity Detector (VAD) watches for speech via AnalyserNode. When the user
 * stops speaking (~800 ms silence), the audio chunk is automatically sent to
 * Whisper. On an empty/noise result the cycle restarts immediately.
 *
 * API (same as before):
 *   HF.speak(text, opts)
 *   HF.speakThen(text, cb, opts)
 *   HF.cancelSpeech()
 *   HF.VOICE_SUPPORTED        — true when MediaRecorder is available
 *   HF.WHISPER_READY          — true once the model is loaded
 *   HF.audioMode              — TTS read-aloud of questions (persisted)
 *   HF.setAudioMode(bool)
 *   HF.cancelRecognition()
 *   HF.renderAudioToggle(container)
 *   HF.createInputUI(el, cb, opts)   → { focus, reset, startListening }
 *   HF.GameState()
 */
(function () {
  'use strict';

  const HF = window.HF = window.HF || {};

  // Filter ONNX "Removing initializer" noise. Installed before any import()
  // so onnxruntime-web captures our patched reference when it loads.
  var _origConsoleWarn = console.warn;
  console.warn = function () {
    var msg = String(arguments[0] || '');
    if (msg.indexOf('Removing initializer') !== -1) return;
    return _origConsoleWarn.apply(console, arguments);
  };

  // ── TTS ─────────────────────────────────────────────────────────────────

  HF.speak = function (text, opts) {
    if (!window.speechSynthesis) return null;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    if (opts) {
      if (opts.rate   !== undefined) utt.rate   = opts.rate;
      if (opts.pitch  !== undefined) utt.pitch  = opts.pitch;
      if (opts.volume !== undefined) utt.volume = opts.volume;
    }
    window.speechSynthesis.speak(utt);
    return utt;
  };

  HF.cancelSpeech = function () {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  };

  HF.speakThen = function (text, cb, opts) {
    if (!window.speechSynthesis) { if (cb) setTimeout(cb, 50); return null; }
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    if (opts) {
      if (opts.rate   !== undefined) utt.rate   = opts.rate;
      if (opts.pitch  !== undefined) utt.pitch  = opts.pitch;
      if (opts.volume !== undefined) utt.volume = opts.volume;
    }
    if (cb) {
      let fired = false;
      const once = function () { if (!fired) { fired = true; cb(); } };
      utt.onend = utt.onerror = once;
      setTimeout(once, Math.max(1200, Math.round(text.length / 5 / 150 * 60000) + 800));
    }
    window.speechSynthesis.speak(utt);
    return utt;
  };

  // ── Whisper + VAD config ─────────────────────────────────────────────────

  const TRANSFORMERS_URL  = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
  const MODEL_ID          = 'Xenova/whisper-tiny.en';
  const VAD_THRESHOLD     = 0.015;  // RMS level above which audio counts as speech
  const VAD_SILENCE_MS    = 800;    // ms of silence after speech → trigger transcription
  const VAD_MIN_SPEECH_MS = 300;    // ignore bursts shorter than this (noise/clicks)

  HF.VOICE_SUPPORTED = !!(navigator.mediaDevices && window.MediaRecorder);
  HF.WHISPER_READY   = false;
  HF.audioMode       = localStorage.getItem('hf_audiomode') !== 'off';

  HF.setAudioMode = function (val) {
    HF.audioMode = !!val;
    localStorage.setItem('hf_audiomode', val ? 'on' : 'off');
  };

  // ── Model loading ────────────────────────────────────────────────────────

  let _pipe = null, _pipePromise = null, _progressCbs = [];

  function _notifyProgress(p) {
    _progressCbs.forEach(function (cb) { try { cb(p); } catch (_) {} });
  }

  function loadModel(onProgress) {
    if (onProgress) _progressCbs.push(onProgress);
    if (_pipe) { if (onProgress) onProgress({ status: 'ready' }); return Promise.resolve(_pipe); }
    if (_pipePromise) return _pipePromise;

    _pipePromise = import(TRANSFORMERS_URL)
      .then(function (mod) {
        mod.env.allowLocalModels = false;
        // Cache API requires a secure context; falls back gracefully on plain HTTP dev servers.
        try {
          mod.env.useBrowserCache = true;
        } catch (_) {
          mod.env.useBrowserCache = false;
        }
        return mod.pipeline('automatic-speech-recognition', MODEL_ID, {
          quantized: true,
          progress_callback: _notifyProgress,
        });
      })
      .then(function (pipe) {
        _pipe = pipe;
        HF.WHISPER_READY = true;
        _notifyProgress({ status: 'ready' });
        return pipe;
      })
      .catch(function (err) { throw err; });
    return _pipePromise;
  }

  // ── Recognition handle ───────────────────────────────────────────────────

  let _activeCycle = null;

  HF.cancelRecognition = function () {
    if (_activeCycle) { _activeCycle.stop(); _activeCycle = null; }
  };

  // ── VAD recording cycle ──────────────────────────────────────────────────
  // One cycle = listen until utterance detected → transcribe → call onResult.
  // The caller is responsible for restarting if onResult returns null.
  //
  // @param {MediaStream}   stream
  // @param {function(?string)} onResult   — called with transcript or null
  // @param {function(string)}  onStatus   — 'listening'|'speaking'|'thinking'
  // @returns {{ stop() }}

  function startCycle(stream, onResult, onStatus) {
    let active       = true;
    let isSpeaking   = false;
    let silenceStart = null;
    let speechStart  = null;

    // Web Audio VAD setup
    const audioCtx  = new AudioContext();
    audioCtx.resume(); // unblock in browsers that auto-suspend before user gesture
    const analyser  = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    const source    = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);
    const dataArray = new Float32Array(analyser.fftSize);

    // MediaRecorder — 100 ms slices, routed into a pre-buffer or speechChunks.
    //
    // The FIRST chunk from a WebM MediaRecorder contains the EBML initialisation
    // segment (container header). Without it the blob is undecodable, causing the
    // "unknown content type" DOMException. We save it in headerChunk and never
    // roll it out of the window. The rolling pre-buffer (last 2 × 100 ms = 200 ms)
    // captures audio just before speech onset so the first phoneme isn't clipped.
    const PRE_BUFFER_CHUNKS = 2; // rolling window size (excludes header chunk)
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      .find(function (t) { return MediaRecorder.isTypeSupported(t); }) || '';
    const mr = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    let headerChunk    = null; // always kept — contains EBML container header
    let preBuffer      = [];   // rolling window before speech onset
    let speechChunks   = [];   // chunks from speech onset onward
    let recordingSpeech = false;
    mr.ondataavailable = function (ev) {
      if (!ev.data.size || !active) return;
      if (!headerChunk) { headerChunk = ev.data; return; } // save header, don't route it
      if (recordingSpeech) {
        speechChunks.push(ev.data);
      } else {
        preBuffer.push(ev.data);
        if (preBuffer.length > PRE_BUFFER_CHUNKS) preBuffer.shift();
      }
    };
    mr.start(100);

    onStatus('listening');

    // Called when VAD decides the utterance is done (or cycle is cancelled)
    function finish(shouldTranscribe) {
      active = false;
      try { source.disconnect(); } catch (_) {}
      try { audioCtx.close();    } catch (_) {}

      const allChunks = (headerChunk ? [headerChunk] : []).concat(preBuffer).concat(speechChunks);
      if (!shouldTranscribe || allChunks.length < 2) {
        try { mr.stop(); } catch (_) {}
        onResult(null);
        return;
      }

      onStatus('thinking');
      const capturedChunks = allChunks;
      mr.onstop = function () {
        const blob = new Blob(capturedChunks, { type: mr.mimeType || 'audio/webm' });
        const url  = URL.createObjectURL(blob);
        loadModel()
          .then(function (pipe) {
            return pipe(url, {
              language: 'english',
              task: 'transcribe',
              return_timestamps: false,  // skip timestamp decode — faster
            });
          })
          .then(function (result) {
            URL.revokeObjectURL(url);
            const transcript = (result.text || '').trim();
            console.log('[HF] transcript:', JSON.stringify(transcript));
            onResult(transcript);
          })
          .catch(function (err)  { console.error('[HF] transcription error:', err); URL.revokeObjectURL(url); onResult(null); });
      };
      try { mr.stop(); } catch (_) { onResult(null); }
    }

    // VAD poll — runs every 50 ms
    function poll() {
      if (!active) return;

      analyser.getFloatTimeDomainData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
      const rms = Math.sqrt(sum / dataArray.length);
      const now = Date.now();

      if (rms > VAD_THRESHOLD) {
        if (!isSpeaking) {
          isSpeaking = true;
          speechStart = now;
          recordingSpeech = true; // switch MediaRecorder from pre-buffer to speech capture
          onStatus('speaking');
        }
        silenceStart = null;
      } else if (isSpeaking) {
        if (!silenceStart) silenceStart = now;
        if (now - silenceStart >= VAD_SILENCE_MS) {
          // Silence long enough — decide whether to transcribe based on speech length
          const speechMs = (silenceStart || now) - (speechStart || now);
          finish(speechMs >= VAD_MIN_SPEECH_MS);
          return;
        }
      }

      setTimeout(poll, 50);
    }
    poll();

    return {
      stop: function () {
        if (!active) return;
        active = false;
        try { source.disconnect(); audioCtx.close(); mr.stop(); } catch (_) {}
      },
    };
  }

  // ── renderAudioToggle ────────────────────────────────────────────────────

  HF.renderAudioToggle = function (container) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'audio-toggle' + (HF.audioMode ? ' on' : '');
    btn.title = 'Toggle text-to-speech for questions';
    btn.textContent = 'Audio ' + (HF.audioMode ? 'on' : 'off');
    btn.addEventListener('click', function () {
      HF.setAudioMode(!HF.audioMode);
      btn.className = 'audio-toggle' + (HF.audioMode ? ' on' : '');
      btn.textContent = 'Audio ' + (HF.audioMode ? 'on' : 'off');
    });
    container.appendChild(btn);
    return btn;
  };

  // ── createInputUI ────────────────────────────────────────────────────────

  HF.createInputUI = function (container, onAnswer, opts) {
    opts = opts || {};
    container.innerHTML = '';

    let answered     = false;
    let micStream    = null;   // kept open across same-question retries
    let currentCycle = null;
    let micBtn       = null;
    let statusEl     = null;

    // ── Status helper ─────────────────────────────────────────────────────
    // Accepts canonical state keys or raw label strings (e.g. '⏳ 45%')
    function setStatus(s) {
      const map = {
        idle:      ['🎤 Speak',       false, ''],
        listening: ['🎤 Listening…',  false, ''],
        speaking:  ['🔴 Speaking…',   false, ' listening'],
        thinking:  ['⏳ Thinking…',   true,  ''],
      };
      const [label, disabled, extra] = map[s] || [s, true, ''];
      if (micBtn) {
        micBtn.className  = 'btn-mic' + extra;
        micBtn.textContent = label;
        micBtn.disabled   = disabled;
      }
      if (statusEl) {
        statusEl.className  = 'audio-status' + extra;
        statusEl.textContent = label;
      }
    }

    // ── Mic management ────────────────────────────────────────────────────
    function releaseMic() {
      if (micStream) {
        micStream.getTracks().forEach(function (t) { t.stop(); });
        micStream = null;
      }
    }

    // ── Core listen + auto-retry loop ─────────────────────────────────────
    // Starts a VAD cycle on `stream`. On empty/noise result, restarts
    // immediately on the same stream. On valid transcript, fires onAnswer.
    function listenOnStream(stream) {
      currentCycle = startCycle(stream, function onResult(transcript) {
        currentCycle = null;
        _activeCycle = null;
        if (answered) return;

        if (transcript) {
          answered = true;
          releaseMic();
          onAnswer(transcript);
        } else {
          // Nothing useful heard — restart cycle on the same open stream
          if (!answered && micStream && micStream.active) {
            setStatus('listening');
            setTimeout(function () {
              if (!answered) listenOnStream(micStream);
            }, 200);
          }
        }
      }, setStatus);
      _activeCycle = currentCycle;
    }

    // ── Entry point (called by game after TTS, or by button click) ────────
    function beginListening() {
      if (answered || currentCycle) return;

      // Defer until model is ready so "thinking" doesn't stall on first use
      if (!HF.WHISPER_READY) {
        setStatus('⏳ Loading…');
        loadModel().then(function () {
          if (!answered && !currentCycle) beginListening();
        }).catch(function () { setStatus('idle'); });
        return;
      }

      // Reuse the open stream if still alive (avoids re-requesting mic mid-game)
      if (micStream && micStream.active) {
        listenOnStream(micStream);
        return;
      }

      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(function (stream) {
          if (answered) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
          micStream = stream;
          listenOnStream(stream);
        })
        .catch(function (err) {
          console.warn('[HF] Mic access denied:', err);
          setStatus('idle');
        });
    }

    // ── Build UI ──────────────────────────────────────────────────────────
    // Voice controls live in a wrapper so they can be rebuilt in-place when
    // the user switches between voice-VAD mode and keyboard mode mid-game.
    const voiceWrap = document.createElement('div');
    voiceWrap.className = 'voice-wrap';
    let modelLoadStarted = false;

    function buildVoiceControls() {
      voiceWrap.innerHTML = '';
      micBtn   = null;
      statusEl = null;
      if (!HF.VOICE_SUPPORTED) return;

      // Mode toggle — swap between auto-listen (VAD) and keyboard input
      const modeBtn = document.createElement('button');
      modeBtn.type = 'button';
      modeBtn.className = 'btn-mode';
      modeBtn.textContent = HF.audioMode ? '⌨️ Use keyboard' : '🎤 Use voice';
      modeBtn.addEventListener('click', function () {
        if (currentCycle) { currentCycle.stop(); currentCycle = null; _activeCycle = null; }
        releaseMic();
        HF.setAudioMode(!HF.audioMode);
        buildVoiceControls();
        if (HF.audioMode && !answered) beginListening();
      });
      voiceWrap.appendChild(modeBtn);

      if (HF.audioMode) {
        // Auto-listen mode: status indicator, no button.
        // Game calls startListening() after TTS finishes.
        statusEl = document.createElement('div');
        statusEl.className = 'audio-status';
        statusEl.setAttribute('aria-live', 'polite');
        statusEl.textContent = HF.WHISPER_READY ? '🎤 Ready' : '⏳ Loading…';
        voiceWrap.appendChild(statusEl);
      } else {
        // Manual mode: click once to start listening, VAD handles the rest.
        // Click again to cancel.
        micBtn = document.createElement('button');
        micBtn.type = 'button';
        micBtn.className = 'btn-mic';
        micBtn.setAttribute('aria-label', 'Start voice input');
        setStatus(HF.WHISPER_READY ? 'idle' : '⏳ Loading…');

        micBtn.addEventListener('click', function () {
          if (currentCycle) {
            // Cancel active listening
            currentCycle.stop(); currentCycle = null; _activeCycle = null;
            releaseMic();
            setStatus('idle');
          } else {
            beginListening();
          }
        });

        voiceWrap.appendChild(micBtn);
      }

      // Pre-load model once — subsequent buildVoiceControls() calls skip this
      if (!HF.WHISPER_READY && !modelLoadStarted) {
        modelLoadStarted = true;
        loadModel(function (p) {
          if (answered) return;
          if (p.status === 'progress' && p.progress != null) {
            const pct = '⏳ ' + Math.round(p.progress) + '%';
            if (micBtn)  { micBtn.textContent  = pct; micBtn.disabled  = true; }
            if (statusEl)  statusEl.textContent = pct;
          } else if (p.status === 'ready') {
            if (!currentCycle) setStatus(HF.audioMode ? 'listening' : 'idle');
          }
        }).catch(function (err) {
          console.error('[HF] Model load error:', err);
          if (!answered) setStatus('idle');
        });
      }
    }

    buildVoiceControls();
    container.appendChild(voiceWrap);

    // Text input — always present as typed fallback
    const form = document.createElement('form');
    form.className = 'answer-form';
    form.setAttribute('novalidate', '');

    const input = document.createElement('input');
    input.type           = 'text';
    input.className      = 'answer-input';
    input.placeholder    = opts.placeholder  || 'Type answer…';
    input.autocomplete   = 'off';
    input.autocorrect    = 'off';
    input.autocapitalize = 'off';
    input.spellcheck     = false;
    input.setAttribute('inputmode', opts.inputmode || 'text');

    const submitBtn = document.createElement('button');
    submitBtn.type      = 'submit';
    submitBtn.className = 'btn-submit';
    submitBtn.textContent = 'Submit';

    form.appendChild(input);
    form.appendChild(submitBtn);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const val = input.value.trim();
      if (!val) return;
      input.value = '';
      answered = true;
      if (currentCycle) { currentCycle.stop(); currentCycle = null; _activeCycle = null; }
      releaseMic();
      onAnswer(val);
    });

    container.appendChild(form);

    if (!HF.VOICE_SUPPORTED) {
      const note = document.createElement('p');
      note.className   = 'voice-unavailable';
      note.textContent = 'Microphone not available in this browser — type your answer above.';
      container.appendChild(note);
    }

    return {
      focus: function () { input.focus(); },
      reset: function () {
        input.value  = '';
        answered     = false;
        if (currentCycle) { currentCycle.stop(); currentCycle = null; _activeCycle = null; }
        releaseMic();
        setStatus(HF.WHISPER_READY ? 'idle' : '⏳ Loading…');
      },
      startListening: beginListening,
    };
  };

  // ── GameState ────────────────────────────────────────────────────────────

  HF.GameState = function () {
    return {
      score: 0, streak: 0, total: 0,
      correct:  function () { this.score++; this.streak++; this.total++; },
      wrong:    function () { this.streak = 0; this.total++; },
      accuracy: function () {
        return this.total === 0 ? 0 : Math.round((this.score / this.total) * 100);
      },
    };
  };

}());
