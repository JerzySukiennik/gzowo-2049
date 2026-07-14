# Gzowo 2049

Multiplayer 3D open-world cyber city in the browser. Talk to AI robots with your
voice, order them around, get arrested by robot police. No build step, no login.

**Play: https://jerzysukiennik.github.io/gzowo-2049/**

## Features

- Cyber city with a Main Square and a Prison sector, 27 destructible walls
- 10 AI robots (civilian + police) voiced by ONE Gemini Live model
  (`gemini-3.1-flash-live-preview`) over WebSocket — speak (mic button, `M`,
  audio streams straight to Gemini) or type (`T`); the model answers with
  native voice AND executes game actions via function calling (move, follow,
  destroy/repair walls, arrest, patrol, dance…)
- Animated GLB avatars (Quaternius "Animated Robot", CC0) for robots, the
  player and remote players — per-entity tint, runtime Box3 scaling
- Robots stop and face you while you talk to them
- Grid A* navigation — robots route around buildings and walls and use the
  prison gate; destroying a wall opens a new path
- A robotic manipulator arm guards the prison gate: it tracks, grabs and
  dumps wanted robots into the yard
- Robot police: wanted list, chase, arrest and physical escort to the Prison
- Persistent robot memory in Firestore — robots remember past events across
  sessions
- Hybrid multiplayer: PeerJS/WebRTC for smooth position sync + Firestore
  (`onSnapshot`) for lobby registry, world state and chat
- Robot voices: native Gemini Live audio; remote players hear robot lines via
  speechSynthesis fallback (randomized pitch per robot)

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
- `src/ai.js` — Gemini Live session (mic streaming in, PCM voice out, robot_action
  function calls, live subtitles from transcription)
- `src/avatars.js` — GLB avatar loading/cloning/animation (model: "Animated
  Robot" by Quaternius, CC0, quaternius.com)
- `src/nav.js` — walkability grid + A* pathfinding
- `src/manipulator.js` — procedural prison-gate guard arm
- `worker/` — Cloudflare Worker that mints short-lived single-use Gemini tokens;
  the real API key lives only in the Worker's secret store (never in this repo
  or in the browser)

The Firebase config in `src/database.js` contains public identifiers only —
access is controlled by Firestore security rules (`firestore.rules`).

## Local dev

Any static server, e.g. `python3 -m http.server 8080`, then open
`http://localhost:8080`.
