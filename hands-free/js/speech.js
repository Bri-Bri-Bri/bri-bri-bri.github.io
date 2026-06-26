/**
 * speech.js — shared TTS + voice input utilities for Hands-Free Games
 *
 * Exposes a global `HF` object:
 *   HF.speak(text, opts)              — Text-to-Speech (fire-and-forget)
 *   HF.speakThen(text, cb, opts)      — TTS, then call cb when done
 *   HF.cancelSpeech()                 — stop any TTS in progress
 *   HF.VOICE_SUPPORTED                — true if native SpeechRecognition available
 *   HF.audioMode                      — true = auto-listen after TTS (persisted)
 *   HF.setAudioMode(bool)             — toggle + persist audioMode
 *   HF.cancelRecognition()            — abort any active SR session
 *   HF.renderAudioToggle(container)   — inserts a toggle button into container
 *   HF.createInputUI(el, cb, opts)    — render input (button or status + text form)
 *   HF.GameState()                    — score/streak/accuracy tracker
 *
 * Audio mode (VOICE_SUPPORTED only):
 *   Each game calls HF.speakThen(question, () => ui.startListening())
 *   When audioMode is on the Speak button is replaced with a status indicator
 *   and SR starts automatically when TTS ends.
 */
(function () {
  'use strict';

  const HF = window.HF = window.HF || {};

  // ── Text-to-Speech ──────────────────────────────────────────────────────
  /**
   * Speak text aloud via the Web Speech API.
   * @param {string} text
   * @param {{ rate?: number, pitch?: number, volume?: number }} [opts]
   * @returns {SpeechSynthesisUtterance|null}
   */
  HF.speak = function (text, opts) {
    if (!window.speechSynthesis) return null;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    if (opts) {
      if (opts.rate   !== undefined) utt.rate   = opts.rate;
      if (opts.pitch  !== undefined) utt.pitch  = opts.pitch;
      if (opts.volume !== undefined) utt.volume = opts.volume;
    }
    // Work around a Chrome bug where speechSynthesis stalls after ~15 s
    window.speechSynthesis.speak(utt);
    return utt;
  };

  HF.cancelSpeech = function () {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  };

  // ── Speech Recognition detection ────────────────────────────────────────
  HF.VOICE_SUPPORTED = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  // ── Audio mode (auto-listen after TTS) ────────────────────────────────
  // Default ON when voice is supported; persisted in localStorage.
  HF.audioMode = HF.VOICE_SUPPORTED &&
    localStorage.getItem('hf_audiomode') !== 'off';

  HF.setAudioMode = function (val) {
    HF.audioMode = !!val;
    localStorage.setItem('hf_audiomode', val ? 'on' : 'off');
  };

  // Global handle for the currently active SpeechRecognition instance
  HF._recognition = null;

  HF.cancelRecognition = function () {
    if (HF._recognition) {
      try { HF._recognition.abort(); } catch (_) {}
      HF._recognition = null;
    }
  };

  // ── speakThen ───────────────────────────────────────────────────────────
  /**
   * Speak text aloud, then call cb when finished (or immediately if no TTS).
   * Includes a timeout fallback in case onend doesn't fire.
   */
  HF.speakThen = function (text, cb, opts) {
    if (!window.speechSynthesis) {
      if (cb) setTimeout(cb, 50);
      return null;
    }
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
      utt.onend   = once;
      utt.onerror = once;
      // Fallback: ~150 wpm, 5 chars/word, +800 ms buffer
      const ms = Math.max(1200, Math.round(text.length / 5 / 150 * 60000) + 800);
      setTimeout(once, ms);
    }
    window.speechSynthesis.speak(utt);
    return utt;
  };

  // ── renderAudioToggle ──────────────────────────────────────────────────
  /**
   * Append an Audio on/off toggle button to `container`.
   * Only rendered when VOICE_SUPPORTED is true.
   */
  HF.renderAudioToggle = function (container) {
    if (!HF.VOICE_SUPPORTED) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'audio-toggle' + (HF.audioMode ? ' on' : '');
    btn.title = 'Toggle full audio mode (auto-listen after question is read)';
    btn.textContent = 'Audio ' + (HF.audioMode ? 'on' : 'off');
    btn.addEventListener('click', function () {
      HF.setAudioMode(!HF.audioMode);
      btn.className = 'audio-toggle' + (HF.audioMode ? ' on' : '');
      btn.textContent = 'Audio ' + (HF.audioMode ? 'on' : 'off');
    });
    container.appendChild(btn);
    return btn;
  };

  /**
   * Build the voice-input UI inside `container`.
   *
   * When SpeechRecognition IS available:
   *   – A large "🎤 Speak" button that toggles the mic
   *   – A collapsible text input + Submit for typed fallback
   *
   * When SpeechRecognition is NOT available (Firefox):
   *   – A text input + Submit button
   *   – A small note explaining the situation
   *
   * @param {HTMLElement} container  — where to render the UI
   * @param {function(string):void} onAnswer  — called with the trimmed answer string
   * @param {{ placeholder?: string, lang?: string }} [opts]
   * @returns {{ focus(): void, reset(): void }}
   */
  HF.createInputUI = function (container, onAnswer, opts) {
    opts = opts || {};
    container.innerHTML = '';

    let micBtn  = null;
    let statusEl = null;

    // ── Shared SR start logic ────────────────────────────────────────────
    // `answered` is scoped to the createInputUI call, not individual sessions.
    // When the game rebuilds the UI for a new question, this closure is gone,
    // so the restart loop stops naturally.
    let answered = false;
    let fatalError = false;

    function doStartListening() {
      if (!HF.VOICE_SUPPORTED) return;
      if (HF._recognition) return; // already active
      if (answered) return;        // answer already came in via text/voice
      if (fatalError) return;      // permission denied / service down

      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const rec = new SR();
      HF._recognition = rec;
      rec.lang = opts.lang || 'en-US';
      rec.interimResults = false;
      rec.maxAlternatives = 1;

      rec.onstart = function () {
        if (statusEl) { statusEl.classList.add('listening'); statusEl.textContent = 'Listening...'; }
        if (micBtn)   { micBtn.classList.add('listening');   micBtn.textContent   = 'Listening...'; }
      };

      rec.onend = function () {
        if (HF._recognition === rec) HF._recognition = null;
        if (statusEl) { statusEl.classList.remove('listening'); statusEl.textContent = 'Ready'; }
        if (micBtn)   { micBtn.classList.remove('listening');   micBtn.textContent   = 'Speak'; }
        // Restart only if nothing has stopped the loop (answered, fatal error, or stale UI).
        if (HF.audioMode && !answered && !fatalError && document.contains(form)) {
          setTimeout(doStartListening, 300);
        }
      };

      rec.onresult = function (e) {
        const transcript = e.results[0][0].transcript.trim();
        answered = true;
        rec.stop();
        if (transcript) onAnswer(transcript);
      };

      rec.onerror = function (e) {
        console.warn('[HF] SpeechRecognition error:', e.error);
        if (HF._recognition === rec) HF._recognition = null;
        if (statusEl) { statusEl.classList.remove('listening'); statusEl.textContent = 'Ready'; }
        if (micBtn)   { micBtn.classList.remove('listening');   micBtn.textContent   = 'Speak'; }
        if (e.error === 'not-allowed' || e.error === 'service-not-available') {
          fatalError = true; // onend will fire next but the guard above will catch it
        }
      };

      rec.start();
    }

    // ── Manual Speak button (non-audio mode) ─────────────────────────────
    if (HF.VOICE_SUPPORTED && !HF.audioMode) {
      micBtn = document.createElement('button');
      micBtn.type = 'button';
      micBtn.className = 'btn-mic';
      micBtn.setAttribute('aria-label', 'Start voice input');
      micBtn.textContent = 'Speak';
      micBtn.addEventListener('click', function () {
        if (HF._recognition) { HF._recognition.stop(); return; }
        doStartListening();
      });
      container.appendChild(micBtn);
    }

    // ── Status indicator (audio mode) ────────────────────────────────────
    if (HF.VOICE_SUPPORTED && HF.audioMode) {
      statusEl = document.createElement('div');
      statusEl.className = 'audio-status';
      statusEl.setAttribute('aria-live', 'polite');
      statusEl.textContent = 'Ready';
      container.appendChild(statusEl);
    }

    // ── Text input (always present) ──────────────────────────────────────
    const form = document.createElement('form');
    form.className = 'answer-form';
    form.setAttribute('novalidate', '');

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'answer-input';
    input.placeholder = opts.placeholder || 'Type answer…';
    input.autocomplete   = 'off';
    input.autocorrect    = 'off';
    input.autocapitalize = 'off';
    input.spellcheck     = false;
    input.setAttribute('inputmode', opts.inputmode || 'text');

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
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
      // Stop any in-progress SR so the typed answer wins
      HF.cancelRecognition();
      onAnswer(val);
    });

    container.appendChild(form);

    // ── No-voice notice ──────────────────────────────────────────────────
    if (!HF.VOICE_SUPPORTED) {
      const note = document.createElement('p');
      note.className = 'voice-unavailable';
      note.textContent =
        'Voice input is not available in this browser — type your answer above.';
      container.appendChild(note);
    }

    return {
      focus:          function () { input.focus(); },
      reset:          function () { input.value = ''; },
      startListening: doStartListening,
    };
  };

  // ── Lightweight game-state helper ────────────────────────────────────────
  /**
   * Simple score/streak tracker.
   * Usage:
   *   const gs = HF.GameState();
   *   gs.correct();  gs.wrong();
   *   gs.score       gs.streak     gs.total
   */
  HF.GameState = function () {
    return {
      score:  0,
      streak: 0,
      total:  0,

      correct: function () {
        this.score++;
        this.streak++;
        this.total++;
      },

      wrong: function () {
        this.streak = 0;
        this.total++;
      },

      accuracy: function () {
        return this.total === 0
          ? 0
          : Math.round((this.score / this.total) * 100);
      },
    };
  };

})();
