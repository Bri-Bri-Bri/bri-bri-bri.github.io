# bri-bri-bri.github.io

Personal project space. The apps here are built for my own use — mostly things I wanted to exist and couldn't find elsewhere, or things I wanted to understand by building. Nothing is monetized, nothing is tracked, and nothing is trying to sell you a subscription.

---

## Apps

### Pomodoro

A Pomodoro timer with built-in task list management. You can create named lists, add tasks to them, and have the timer read out the current task when each session starts (handy when you want to stay on track without looking at your screen). Task lists persist in local storage and the app installs as a PWA if you want it on your home screen.

---

### Hands-Free Games

A small collection of mental math and memory games designed to be played entirely by voice — no screen interaction required once a round starts. The idea is to practice things like binary conversion or day-of-week calculation while doing something else (walking, commuting, etc.).

The games are:

- **Binary** — Convert decimal numbers to binary and back. Supports 4-bit and 8-bit modes.
- **Doomsday** — Practice the Doomsday algorithm: given a date, say the correct day of the week.
- **Game of 24** — Given four numbers, find an arithmetic expression that equals 24.
- **PAO Quiz** — Quiz yourself on a Person-Action-Object mnemonic system loaded from a CSV file.

#### Speech Recognition and Privacy

Voice input runs entirely in the browser using [Whisper](https://github.com/openai/whisper) via the `@huggingface/transformers` library. The model (~80 MB) is downloaded once and cached locally; after that, recognition works offline. No audio is ever sent to a server.

This is a deliberate choice over the browser's built-in Web Speech API, which routes audio through Google's servers in most implementations.

For games with a small, well-defined answer space, the decoder is further constrained using **logit masking**: at each generation step, any token outside the allowed vocabulary is set to negative infinity, so the model can only produce valid answers. For example, the Doomsday game restricts output to the seven day names, and the Binary game restricts to digit characters and their spoken equivalents. This both improves accuracy and prevents the kinds of hallucinations (plausible but wrong phrases) that unconstrained models occasionally produce.
