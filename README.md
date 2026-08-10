# 瓦落とし — Chat Chat Revolution

A chat-controlled dodging game. Everyone on the board is a chatter. Each round the roof tiles,
bells and boulders pick their squares, you get a few seconds to count grid squares, and then
everything lands at once.

No build step, no assets, no network. Open it and play.

```bash
npm start          # serves on http://localhost:4173
```

Then open <http://localhost:4173>. `server.js` is a zero-dependency static server that
respects `$PORT`, so the same command runs locally and on a host like Railway.

## How to play

- The board is lettered **A–K** across and numbered **1–7** down. Distance is countable, so
  chat lag never matters: you plan in squares, not in reflexes.
- During **Plot your path** type up to **5 steps** into the chat box:
  - `l` left, `r` right, `u` up, `d` down
  - `rrud`, `r r u d`, `r3u` and `right right up` all work
  - only messages made entirely of moves count, so `lol` will not walk you left twice
  - with no text field focused, arrow keys append a step and Enter sends it
- Your path previews live on the board: pink dots for each step, a box on the square you land on.
- Red squares marked **危** are where things land. Standing on one when the timer ends flattens you.
- From round 3 stone lanterns, bamboo and torii pillars block squares, so a straight line back and
  forth stops working.
- The number of falling objects climbs every round, and the planning window shrinks from 6.2s to 2.8s.

Chatters are eliminated for the rest of the match when hit and keep heckling as spirits. You respawn
every round. The match ends when one is left standing, then everyone comes back.

Every round is guaranteed survivable: the generator verifies that every living player has a safe
square within 5 steps before the round starts.

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | Page shell, HUD, chat panel, accessibility text |
| `styles.css` | Layout, theme tokens, responsive and reduced-motion rules |
| `src/config.js` | Board geometry, timings, palette, chatter names |
| `src/game.js` | Rules: phases, hazard generation, fairness check, bot planning, move parser |
| `src/render.js` | All the pixel art, drawn procedurally on canvas |
| `src/chat.js` | Chat log rendering |
| `src/main.js` | Wiring: input, HUD, bot chatter, frame loop |
| `server.js` | Zero-dependency static server for local dev and deploys |
| `DESIGN.md` | Design read, thesis and accessibility notes |

## Checks

```bash
npm test           # headless soak: ~950 rounds, rule invariants, move parser
npm run shots      # Playwright screenshots of plan / late round / impact / game over / mobile
```

`npm run shots` needs the dev server running and `npx playwright install chromium` once.
