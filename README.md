# PrioBox

A small, **fully offline** macOS task board. No accounts, no network — everything
lives in a local JSON file on your Mac.

## What it does

- **A column of tasks.** Type a task, press Enter, and it drops into the list.
- **Smooth drag-to-reorder.** Grab any card and drag it up or down. The other
  cards glide out of the way (FLIP animation) and the card settles into its new
  slot when you let go.
- **Drag to finish.** Drop a card onto the green **Done** zone on the right and
  it animates away and leaves the row. A running "done" count is kept.
- **Recolor any task.** Click the 🎨 button on a card and pick from a palette.
  The color shows up as the card's accent stripe (and on the floating timer).
- **Per-task countdown.** Click ▶ on a card, choose a duration in **30-minute
  steps**, and start it. Only one timer runs at a time.
- **Always-on-top desktop timer.** When a countdown starts, a small frameless
  widget appears on your desktop and floats above every other window (and over
  full-screen apps / all Spaces). It shows the task, a countdown, a progress
  ring, and Pause / Stop controls. Drag it anywhere.
- **Time tracking.** Every second a task's countdown runs is added to that
  task's total **time spent**, shown as a badge on the card (e.g. `45m`,
  `1h 20m`). When the countdown hits zero you get a native notification.

## Requirements

- macOS
- [Node.js](https://nodejs.org/) 18+ (only needed to install/run/build)

## Run it

```bash
npm install
npm start
```

## Build a real `.app` / `.dmg`

```bash
npm run dist
```

The packaged app lands in `dist/`. Because the app makes no network calls, it
runs completely offline once built.

## Where is my data?

A single JSON file:

```
~/Library/Application Support/PrioBox/priobox-data.json
```

Delete it to reset everything.

## How it's built

Electron, no runtime dependencies:

| File | Role |
| --- | --- |
| `main.js` | Main process: windows, the always-on-top floating timer, JSON persistence, IPC |
| `preload.js` / `floating-preload.js` | Locked-down `contextBridge` APIs (no Node in the renderers) |
| `index.html` / `styles.css` / `renderer.js` | Main board: tasks, drag, colors, timer modal, countdown clock |
| `floating.html` / `floating.css` / `floating.js` | The desktop countdown widget |

The renderer owns the single source of truth and the ticking clock; the floating
window is a pure display + controls that talks back over IPC.
