'use strict';

const widget = document.getElementById('widget');
const taskName = document.getElementById('task-name');
const countdown = document.getElementById('countdown');
const ringFg = document.getElementById('ring-fg');
const pauseBtn = document.getElementById('pause-btn');
const stopBtn = document.getElementById('stop-btn');

const CIRCUMFERENCE = 2 * Math.PI * 19; // matches r=19 in the SVG

// Last state pushed by the main process. The display is recomputed locally from
// it against the wall clock, so this window keeps counting correctly even if no
// further updates arrive — it is always on screen, so its own clock is the one
// least likely to be starved.
let last = null;
let reportedExpiry = false;

function fmt(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function remainingMs() {
  if (!last) return 0;
  if (!last.running) return last.remainingMs;
  return Math.max(0, last.endsAt - Date.now());
}

function paint() {
  if (!last) return;

  const remaining = remainingMs();
  countdown.textContent = fmt(remaining);

  const frac = last.totalMs > 0 ? remaining / last.totalMs : 0;
  ringFg.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - frac));

  const finished = last.finished || (!last.running && remaining <= 0);
  taskName.textContent = finished
    ? "Time's up — " + (last.title || 'Task')
    : last.title || 'Task';

  widget.classList.toggle('paused', !last.running);
  pauseBtn.textContent = last.running ? '⏸' : '▶';
  pauseBtn.title = last.running ? 'Pause' : 'Resume';

  // Backstop: if the deadline passes and the main process hasn't wrapped the
  // timer up, tell it once.
  if (last.running && remaining <= 0 && !reportedExpiry) {
    reportedExpiry = true;
    window.floatApi.control('expired');
  }
}

window.floatApi.onState((state) => {
  widget.style.setProperty('--accent', state.color || '#6c7bff');
  if (!last || state.taskId !== last.taskId || state.running !== last.running) {
    reportedExpiry = false;
  }
  last = state;
  paint();
});

// Own ticker — independent of IPC arriving.
setInterval(paint, 250);

// Repaint the instant this window is shown or refocused after being starved.
document.addEventListener('visibilitychange', paint);
window.addEventListener('focus', paint);
window.addEventListener('pageshow', paint);

pauseBtn.addEventListener('click', () => {
  window.floatApi.control(last && last.running ? 'pause' : 'resume');
});

stopBtn.addEventListener('click', () => {
  window.floatApi.control('stop');
});
