# [bri-bri-bri.github.io](bri-bri-bri.github.io)

Personal project space. The apps here are built for my own use — mostly things I wanted to exist and couldn't find elsewhere, or things I wanted to understand by building. Nothing is monetized, nothing is tracked, and nothing is trying to sell you a subscription. All of these webapps are static html pages that you can download for personal use and all data stays in your browser.

---

## Apps

### Pomodoro

A Pomodoro timer with built-in task list management. You can create named lists, add tasks to them, and have the timer read out the current task when each session starts (handy when you want to stay on track without looking at your screen). Task lists persist in local storage and the app installs as a PWA if you want it on your phone home screen.

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

---

### Cellular: Chess Diary

Your personal Chess Diary. Each journal entry is a page made of different cells. Text cells let you jot down thoughts and ideas in Markdown. Game cells let you add a position, make moves and add annotations.

You can also import games from Chess.com and Lichess.org, then annotate each move for review. From saved positions, the app can turn your key moments into puzzles and exercises so you can practice what you learned.

---

### World Map

An interactive world map for exploring and learning country subdivisions (states, provinces, territories, etc.). The workflow is:

1. The globe loads showing all countries.
2. Click any country to zoom in and see its admin-level-1 subdivisions drawn as polygons.
3. Subdivision labels are hidden by default - hover to reveal a region's name, so you can quiz yourself without spoilers.
4. A "Show labels" toggle reveals all labels at once when you want them visible.
5. After learning the regions of a country, review using World Map: Admin-1 Anki Deck [here](https://ankiweb.net/shared/info/702916596).

#### Data sources

Geography data comes from [Natural Earth](https://www.naturalearthdata.com/), a public domain dataset maintained by cartographers. Two files are fetched at runtime from the [natural-earth-vector](https://github.com/nvkelso/natural-earth-vector) GitHub repository:

- **`ne_110m_admin_0_countries.geojson`** (~300 KB) — world country polygons at 1:110m scale, loaded on page open.
- **`ne_10m_admin_1_states_provinces.geojson`** (~38 MB raw, ~9 MB compressed) — all admin-1 subdivisions at 1:10m scale, fetched lazily on the first country click and cached in memory for the rest of the session.

No data files are stored in this repository.

#### Map rendering

Maps are rendered with [Leaflet](https://leafletjs.com/) using its Canvas renderer. Country-to-subdivision matching uses Natural Earth's `adm0_a3` column.
