'use strict';

const widget = document.getElementById('widget');
const taskName = document.getElementById('task-name');
const countdown = document.getElementById('countdown');
const ringFg = document.getElementById('ring-fg');
const pauseBtn = document.getElementById('pause-btn');
const stopBtn = document.getElementById('stop-btn');

const CIRCUMFERENCE = 2 * Math.PI * 19; // matches r=19 in the SVG

let running = true;

function fmt(sec) {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

window.floatApi.onState((state) => {
  running = !!state.running;

  widget.style.setProperty('--accent', state.color || '#6c7bff');
  taskName.textContent = state.title || 'Task';
  countdown.textContent = fmt(state.remaining);

  const frac = state.total > 0 ? state.remaining / state.total : 0;
  ringFg.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - frac));

  widget.classList.toggle('paused', !running);
  pauseBtn.textContent = running ? '⏸' : '▶';
  pauseBtn.title = running ? 'Pause' : 'Resume';
});

pauseBtn.addEventListener('click', () => {
  window.floatApi.control(running ? 'pause' : 'resume');
});

stopBtn.addEventListener('click', () => {
  window.floatApi.control('stop');
});
