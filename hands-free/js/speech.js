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

  // Filter noisy ONNX/transformers console.warn messages. Installed before
  // any import() so onnxruntime-web captures our patched reference when it
  // loads. The try/catch on apply avoids a Firefox "operation is insecure"
  // DOMException that can fire in certain cross-origin security contexts.
  var _origConsoleWarn = console.warn;
  var _WARN_FILTERS = ['Removing initializer', 'content-length'];
  console.warn = function () {
    var msg = String(arguments[0] || '');
    for (var i = 0; i < _WARN_FILTERS.length; i++) {
      if (msg.indexOf(_WARN_FILTERS[i]) !== -1) return;
    }
    try { return _origConsoleWarn.apply(console, arguments); } catch (_) {}
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

  const TRANSFORMERS_URL  = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';
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
        try { mod.env.useBrowserCache = true; } catch (_) { mod.env.useBrowserCache = false; }
        // Force single-threaded WASM — avoids a silent inference failure that
        // occurs in multi-threaded mode under COOP/COEP headers (SharedArrayBuffer
        // active). Single-threaded is slightly slower but produces correct output.
        try { mod.env.backends.onnx.wasm.numThreads = 1; } catch (_) {}
        return mod.pipeline('automatic-speech-recognition', MODEL_ID, {
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

  // ── Vocab logits processor ───────────────────────────────────────────────
  // Builds a whitelist of BPE token IDs from an allowed-words array. When
  // passed to the pipeline as `logits_processor`, the decoder can only emit
  // tokens from the whitelist — preventing hallucinations like "Thank You"
  // when the only valid answers are "zero" and "one".
  function _buildVocabProcessor(vocab, pipe) {
    var tokenizer = pipe.tokenizer;
    if (!tokenizer) return null;

    var allowed = new Set();
    // Always allow EOS so generation can terminate cleanly.
    // Whisper-tiny.en EOS = 50256; fall back if the property is absent.
    var eos = (tokenizer.eos_token_id != null) ? Number(tokenizer.eos_token_id) : 50256;
    allowed.add(eos);

    function addText(text) {
      if (!text) return;
      try {
        // @huggingface/transformers v3: tokenizer(text, opts) → { input_ids: Tensor }
        var out = tokenizer(text, { add_special_tokens: false });
        var ids = (out && out.input_ids) ? out.input_ids.data : out;
        for (var i = 0; i < ids.length; i++) allowed.add(Number(ids[i]));
      } catch (_) {}
    }

    vocab.forEach(function (phrase) {
      // Encode with/without leading space (GPT-2 BPE convention) and common
      // capitalisation variants so we catch Whisper's usual word boundaries.
      var low = String(phrase).toLowerCase();
      var cap = low.charAt(0).toUpperCase() + low.slice(1);
      [low, ' ' + low, cap, ' ' + cap, phrase, ' ' + phrase].forEach(addText);
    });

    console.log('[HF] vocab processor built:', allowed.size, 'allowed token IDs');
    return {
      _call: function (inputIds, scores) {
        // scores is a Tensor with shape [batch, vocab_size].
        // Mask every disallowed position to -Infinity.
        var data = scores.data;
        var vocabSize = scores.dims[scores.dims.length - 1];
        for (var i = 0; i < data.length; i++) {
          if (!allowed.has(i % vocabSize)) data[i] = -Infinity;
        }
        return scores;
      },
    };
  }

  // ── VAD recording cycle ──────────────────────────────────────────────────
  // One cycle = listen until utterance detected → transcribe → call onResult.
  // The caller is responsible for restarting if onResult returns null.
  //
  // @param {MediaStream}   stream
  // @param {function(?string)} onResult   — called with transcript or null
  // @param {function(string)}  onStatus   — 'listening'|'speaking'|'thinking'
  // @param {Object}        [extraPipeOpts] — merged into pipeline options
  // @returns {{ stop() }}

  function startCycle(stream, onResult, onStatus, extraPipeOpts) {
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
      if (!ev.data.size) return;          // note: !active removed — we need the final flush
      if (!headerChunk) { headerChunk = ev.data; return; } // save header, don't route it
      if (recordingSpeech) {
        speechChunks.push(ev.data);
      } else if (active) {               // only roll pre-buffer while actively listening
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
      mr.onstop = function () {
        // Build blob HERE so mr.stop()'s final ondataavailable flush is included.
        const capturedChunks = (headerChunk ? [headerChunk] : []).concat(preBuffer).concat(speechChunks);
        const blob = new Blob(capturedChunks, { type: mr.mimeType || 'audio/webm' });
        console.log('[HF] audio:', blob.size + 'B,', speechChunks.length, 'speech +', preBuffer.length, 'pre-buffer chunks');
        if (blob.size < 500) { onResult(null); return; }

        // Decode the blob → resample to 16 kHz → pass Float32 PCM directly to
        // Whisper. This avoids the URL-fetch path whose decode can silently fail
        // (returning near-silence that Whisper suppresses as no-speech), and it
        // guarantees the model receives audio at the exact sample rate it expects.
        blob.arrayBuffer()
          .then(function (ab) {
            var decCtx = new AudioContext();
            return decCtx.decodeAudioData(ab).then(function (buf) {
              decCtx.close();
              return buf;
            });
          })
          .then(function (audioBuf) {
            var srcRate = audioBuf.sampleRate;
            console.log('[HF] decoded:', audioBuf.duration.toFixed(2) + 's @', srcRate + 'Hz');
            if (srcRate === 16000) return Promise.resolve(audioBuf.getChannelData(0));
            // Resample to 16 kHz (Whisper's native rate) via OfflineAudioContext
            var outLen = Math.round(audioBuf.length * 16000 / srcRate);
            var offCtx = new OfflineAudioContext(1, outLen, 16000);
            var src    = offCtx.createBufferSource();
            src.buffer = audioBuf;
            src.connect(offCtx.destination);
            src.start(0);
            return offCtx.startRendering().then(function (r) { return r.getChannelData(0); });
          })
          .then(function (pcm) {
            // Sanity-check: log RMS so we can confirm audio is not silent
            var rmsSum = 0;
            for (var i = 0; i < pcm.length; i++) rmsSum += pcm[i] * pcm[i];
            var rms = Math.sqrt(rmsSum / pcm.length);
            console.log('[HF] PCM RMS:', rms.toFixed(4), '(~0 = silence, ~0.1+ = speech)');

            return loadModel().then(function (pipe) {
              var pipeOpts = Object.assign({ return_timestamps: false }, extraPipeOpts || {});
              return pipe(pcm, pipeOpts);
            });
          })
          .then(function (result) {
            console.log('[HF] raw result:', JSON.stringify(result));
            var transcript = (result.text || '').trim();
            console.log('[HF] transcript:', JSON.stringify(transcript));
            onResult(transcript);
          })
          .catch(function (err) { console.error('[HF] transcription error:', err); onResult(null); });
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

    // Vocab logits processor — built once after model loads, reused each cycle.
    let _vocabProc = null;
    const _vocab   = opts.vocab || null;
    if (_vocab && _vocab.length) {
      loadModel().then(function (pipe) {
        _vocabProc = _buildVocabProcessor(_vocab, pipe);
      });
    }

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
      const extraPipeOpts = _vocabProc ? { logits_processor: [_vocabProc] } : null;
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
      }, setStatus, extraPipeOpts);
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
