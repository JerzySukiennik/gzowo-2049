# Gzowo 2049

Multiplayer 3D open-world cyber city in the browser. Talk to AI robots with your
voice, order them around, get arrested by robot police. No build step, no login.

**Play: https://jerzysukiennik.github.io/gzowo-2049/**

## Features

- Cyber city with a Main Square and a Prison sector, 27 destructible walls
- 10 AI robots (civilian + police) driven by Gemini as an intent parser —
  speak (mic button, `M`) or type (`T`) natural language, robots execute
  parsed actions (move, follow, destroy/repair walls, arrest, patrol, dance…)
- Robot police: wanted list, chase, arrest and physical escort to the Prison
- Persistent robot memory in Firestore — robots remember past events across
  sessions
- Hybrid multiplayer: PeerJS/WebRTC for smooth position sync + Firestore
  (`onSnapshot`) for lobby registry, world state and chat
- Robot voices: Gemini TTS with browser speechSynthesis fallback (randomized
  pitch per robot)

## Controls

`WASD` move · mouse look (pointer lock) · `E` interact with wall · `T` chat ·
`M` microphone · `Enter` send

## Architecture

- `index.html` + `style.css` — overlay UI (lobby, chat, HUD, subtitles)
- `src/game.js` — three.js renderer, world, robot state machines, fixed-timestep
  loop (exposes `window.G2049.debugStep(seconds)` for deterministic testing)
- `src/multiplayer.js` — PeerJS host/join, 20 Hz position broadcast with
  client-side interpolation
- `src/database.js` — Firebase/Firestore: lobbies, robot memory, world state,
  chat
- `src/ai.js` — SpeechRecognition, intent requests, TTS playback
- `worker/` — Cloudflare Worker proxy that holds the Gemini API key server-side
  (the key is never in this repo or in the browser)

The Firebase config in `src/database.js` contains public identifiers only —
access is controlled by Firestore security rules (`firestore.rules`).

## Local dev

Any static server, e.g. `python3 -m http.server 8080`, then open
`http://localhost:8080`.
