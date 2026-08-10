# Chat Chat Revolution — 瓦落とし (Kawara-otoshi)

A chat-controlled grid dodging game. Everyone in chat types `l` / `r` / `u` / `d` to plot a path
across a shared board, then the roof tiles and boulders come down.

## Design read

- **Surface:** application UI wrapped around a canvas game (stream-overlay hybrid). Leader: the game board.
- **Audience:** a livestream chat crowd plus one local player. Glanceable at low attention, read from a couch distance.
- **Single job:** let a viewer see *where they are*, *where the danger lands*, and *how many steps separate the two* before the timer runs out.
- **Task and risk:** high frequency (a decision every 3 to 6s), low decision cost, instant and total error cost (elimination). Time pressure is the whole game.
- **Content:** 11x7 labelled grid, 11 named characters, live chat feed, round/alive/timer HUD.
- **Platform:** desktop browser first, single narrow-column fallback. Input is a text field (chat), with arrow keys as an equivalent path when no field has focus.
- **Constraints:** no build step, no image assets, no network. All art is drawn procedurally on canvas.

## Thesis

**A moonlit ukiyo-e castle courtyard rendered as graph paper.** The board is a lettered/numbered
stone grid so distance is *countable*, not estimated — that grid is the memorable device, and it is the
game mechanic (it defuses chat lag: you count squares, not reflexes). Vermilion is reserved
exclusively for danger; everything else lives in indigo, stone grey, and pale gold, so a telegraphed
impact is the only saturated red on screen.

- **Color roles:** indigo night `#0e1a30` (ground/void), stone `#5b6172` (board), pale gold `#d8b45c`
  (grid, labels, focus), vermilion `#e0483a` (hazard only), sakura `#f2a8bd` (accents, petals),
  paper `#f4efe2` (text).
- **Type:** DotGothic16 — a pixel-era Japanese face that carries kana, kanji and Latin in one family,
  so the HUD, chat and in-canvas markers stay one voice. No system-ui fallback as the look.
- **Motion:** telegraph pulse (danger), 170ms per movement step, one impact shake. Every one of those
  has a reduced-motion path: the pulse holds at a fixed opacity, shake and petals stop, character
  bob and ghost drift stop, and movement snaps cell to cell instead of sliding.
- **First glance:** the red 危 markers. **Second glance:** your own nameplate. **Primary action:** the chat input.

## Craft system

- Uniform rail: HUD, board and chat column share one max-width and gutter; below 900px they stack in the
  same rail.
- Contrast: paper on indigo ≈ 14:1, gold on stone ≈ 4.9:1, vermilion markers carry a dark outline and are
  never the *only* signal (they also show the 危 glyph and a growing shadow).
- No emoji. Icons are drawn pixel glyphs from one hand-built set.
- Focus is visible on every control (2px gold ring, offset), and pointer clicks do not leave it stuck.

## Accessibility floor (WCAG 2.2 AA target)

- Canvas has a text alternative that is updated every phase with round, phase, your cell, and the
  hazard cells, so the state is readable without seeing the board.
- Round results, eliminations and phase changes announce through one polite live region. The path
  preview under the input is *not* a live region, so typing does not interrupt a screen reader; it is
  wired to the input with `aria-describedby` instead.
- The whole game is playable from the keyboard alone: type moves and press Enter, or press arrow keys
  to append steps and Enter to send while no text field has focus. Arrow keys inside the message box
  keep their normal caret behaviour so the message stays editable.
- Timing: the plan timer is a game rule, disclosed up front, and the game auto-restarts without input.
- Reduced motion honoured for petals, shake, pulse and step interpolation.

Not claimed: full conformance. No assistive-technology or manual audit has been run here.

## States covered

Planning, locked, resolving, impact, elimination, round break, spectating after death, game over with
winner, auto-restart, empty chat, invalid command feedback, blocked move feedback, path-lands-on-danger
feedback, and the step-limit warning.
