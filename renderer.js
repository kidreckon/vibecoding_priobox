'use strict';

// ===========================================================================
// State
// ===========================================================================
const PALETTE = [
  '#6c7bff', '#2ecc71', '#ff6b6b', '#ffb020',
  '#20c6d6', '#c86bff', '#ff7ac0', '#8a94a6'
];

let state = { tasks: [], doneCount: 0 };

// Runtime timer (not persisted, except the accumulated secondsSpent on a task).
let active = null; // { taskId, remaining, total, running, intervalId }

// Drag runtime.
let drag = null;
let doneArmed = false;

// ===========================================================================
// DOM refs
// ===========================================================================
const taskListEl = document.getElementById('task-list');
const emptyHint = document.getElementById('empty-hint');
const doneZone = document.getElementById('done-zone');
const doneCountEl = document.getElementById('done-count');
const addForm = document.getElementById('add-form');
const addInput = document.getElementById('add-input');

const modal = document.getElementById('timer-modal');
const modalTaskEl = document.getElementById('timer-modal-task');
const durationLabel = document.getElementById('duration-label');

let modalTaskId = null;
let modalMinutes = 30;

// ===========================================================================
// Persistence
// ===========================================================================
async function boot() {
  const loaded = await window.api.loadState();
  if (loaded && Array.isArray(loaded.tasks)) {
    state = { tasks: loaded.tasks, doneCount: loaded.doneCount || 0 };
    // Backfill any missing fields from older saves.
    state.tasks.forEach((t, i) => {
      if (!t.color) t.color = PALETTE[i % PALETTE.length];
      if (typeof t.secondsSpent !== 'number') t.secondsSpent = 0;
    });
  }
  render();
}

let saveTimer = null;
function save() {
  // Debounce disk writes a little; always flush the current state object.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.api.saveState(state), 120);
}

// ===========================================================================
// Formatting helpers
// ===========================================================================
function formatSpent(seconds) {
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function getTask(id) {
  return state.tasks.find((t) => t.id === id);
}

// ===========================================================================
// Render
// ===========================================================================
function render() {
  taskListEl.innerHTML = '';
  for (const task of state.tasks) {
    taskListEl.appendChild(taskNode(task));
  }
  emptyHint.style.display = state.tasks.length ? 'none' : 'block';
  renderDoneCount();
}

function renderDoneCount() {
  doneCountEl.textContent = `${state.doneCount} done`;
}

function taskNode(task) {
  const running = active && active.taskId === task.id && active.running;

  const li = document.createElement('li');
  li.className = 'task' + (running ? ' running' : '');
  li.dataset.id = task.id;
  li.style.setProperty('--task-color', task.color);

  const grip = document.createElement('span');
  grip.className = 'grip';
  grip.textContent = '⋮⋮';

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = task.title;

  const spent = document.createElement('span');
  spent.className = 'time-spent';
  spent.textContent = formatSpent(task.secondsSpent);

  const colorBtn = document.createElement('button');
  colorBtn.className = 'icon-btn color-btn';
  colorBtn.title = 'Recolor';
  colorBtn.textContent = '🎨';

  const playBtn = document.createElement('button');
  playBtn.className = 'icon-btn play-btn';
  playBtn.title = running ? 'Stop timer' : 'Start timer';
  playBtn.textContent = running ? '■' : '▶';

  li.append(grip, title, spent, colorBtn, playBtn);
  return li;
}

function updateTaskTimeLabel(id) {
  const task = getTask(id);
  const li = taskListEl.querySelector(`.task[data-id="${id}"]`);
  if (task && li) {
    li.querySelector('.time-spent').textContent = formatSpent(task.secondsSpent);
  }
}

function setRunningVisual(id, isRunning) {
  const li = taskListEl.querySelector(`.task[data-id="${id}"]`);
  if (!li) return;
  li.classList.toggle('running', isRunning);
  const playBtn = li.querySelector('.play-btn');
  playBtn.textContent = isRunning ? '■' : '▶';
  playBtn.title = isRunning ? 'Stop timer' : 'Start timer';
}

// ===========================================================================
// Add / color
// ===========================================================================
addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = addInput.value.trim();
  if (!value) return;
  const task = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: value,
    color: PALETTE[state.tasks.length % PALETTE.length],
    secondsSpent: 0
  };
  state.tasks.push(task);
  addInput.value = '';
  render();
  save();
});

function togglePalette(li, id) {
  const existing = li.querySelector('.palette');
  closeAllPalettes();
  if (existing) return; // it was open -> now closed
  const pal = document.createElement('div');
  pal.className = 'palette';
  for (const color of PALETTE) {
    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = color;
    sw.addEventListener('click', (e) => {
      e.stopPropagation();
      const task = getTask(id);
      if (task) {
        task.color = color;
        li.style.setProperty('--task-color', color);
        save();
      }
      closeAllPalettes();
    });
    pal.appendChild(sw);
  }
  li.appendChild(pal);
}

function closeAllPalettes() {
  document.querySelectorAll('.palette').forEach((p) => p.remove());
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.palette') && !e.target.closest('.color-btn')) {
    closeAllPalettes();
  }
});

// ===========================================================================
// Click handling (color / play)
// ===========================================================================
taskListEl.addEventListener('click', (e) => {
  const li = e.target.closest('.task');
  if (!li) return;
  const id = li.dataset.id;
  if (e.target.closest('.color-btn')) {
    e.stopPropagation();
    togglePalette(li, id);
  } else if (e.target.closest('.play-btn')) {
    onPlay(id);
  }
});

// ===========================================================================
// Smooth drag-to-reorder + drop-to-finish (FLIP based)
// ===========================================================================
taskListEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const li = e.target.closest('.task');
  if (!li) return;
  if (e.target.closest('.icon-btn') || e.target.closest('.palette')) return;
  startPointer(e, li);
});

function startPointer(e, li) {
  const rect = li.getBoundingClientRect();
  drag = {
    el: li,
    id: li.dataset.id,
    startX: e.clientX,
    startY: e.clientY,
    grabDX: e.clientX - rect.left,
    grabDY: e.clientY - rect.top,
    width: rect.width,
    height: rect.height,
    started: false,
    placeholder: null
  };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
}

function onPointerMove(e) {
  if (!drag) return;
  if (!drag.started) {
    const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
    if (dist < 5) return;
    beginDrag();
  }
  const el = drag.el;
  el.style.left = e.clientX - drag.grabDX + 'px';
  el.style.top = e.clientY - drag.grabDY + 'px';

  // Done-zone hit test.
  const dz = doneZone.getBoundingClientRect();
  const overDone =
    e.clientX >= dz.left && e.clientX <= dz.right &&
    e.clientY >= dz.top && e.clientY <= dz.bottom;
  if (overDone !== doneArmed) {
    doneArmed = overDone;
    doneZone.classList.toggle('armed', doneArmed);
  }
  if (!doneArmed) updatePlaceholder(e.clientY);
}

function beginDrag() {
  drag.started = true;
  closeAllPalettes();
  const el = drag.el;

  const ph = document.createElement('li');
  ph.className = 'drag-placeholder';
  ph.style.height = drag.height + 'px';
  el.parentNode.insertBefore(ph, el);
  drag.placeholder = ph;

  el.classList.add('dragging');
  el.style.position = 'fixed';
  el.style.width = drag.width + 'px';
  el.style.height = drag.height + 'px';
  el.style.margin = '0';
  el.style.left = el.getBoundingClientRect().left + 'px';
  el.style.top = el.getBoundingClientRect().top + 'px';
  document.body.appendChild(el);
}

function updatePlaceholder(pointerY) {
  const ph = drag.placeholder;
  const tasks = [...taskListEl.querySelectorAll('.task')];
  let refNode = null;
  for (const t of tasks) {
    const r = t.getBoundingClientRect();
    if (pointerY < r.top + r.height / 2) {
      refNode = t;
      break;
    }
  }

  // Already in place?
  if (refNode) {
    if (ph.nextElementSibling === refNode) return;
  } else if (ph === taskListEl.lastElementChild) {
    return;
  }

  flipReorder(() => {
    if (refNode) taskListEl.insertBefore(ph, refNode);
    else taskListEl.appendChild(ph);
  });
}

// FLIP: record positions, mutate the DOM, then animate the deltas away.
function flipReorder(mutate) {
  const items = [...taskListEl.querySelectorAll('.task')];
  const firsts = items.map((it) => it.getBoundingClientRect().top);
  mutate();
  items.forEach((it, i) => {
    const dy = firsts[i] - it.getBoundingClientRect().top;
    if (!dy) return;
    it.classList.remove('settling');
    it.style.transform = `translateY(${dy}px)`;
  });
  requestAnimationFrame(() => {
    items.forEach((it) => {
      it.classList.add('settling');
      it.style.transform = '';
    });
  });
}

function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  if (!drag) return;

  if (!drag.started) {
    drag = null;
    return;
  }

  const el = drag.el;
  const ph = drag.placeholder;

  if (doneArmed) {
    finishTask(drag.id, el, ph);
    doneArmed = false;
    doneZone.classList.remove('armed');
    drag = null;
    return;
  }

  // Settle the lifted card into the placeholder's slot, then swap it in.
  const target = ph.getBoundingClientRect();
  let done = false;
  const finalize = () => {
    if (done) return;
    done = true;
    el.removeEventListener('transitionend', finalize);
    clearDragStyles(el);
    if (ph.parentNode) ph.parentNode.replaceChild(el, ph);
    commitOrderFromDOM();
    drag = null;
  };
  el.style.transition = 'left 0.18s ease, top 0.18s ease, transform 0.18s ease';
  el.style.left = target.left + 'px';
  el.style.top = target.top + 'px';
  el.style.transform = 'scale(1)';
  el.addEventListener('transitionend', finalize);
  setTimeout(finalize, 260);
}

function clearDragStyles(el) {
  el.classList.remove('dragging', 'settling');
  el.style.position = '';
  el.style.left = '';
  el.style.top = '';
  el.style.width = '';
  el.style.height = '';
  el.style.margin = '';
  el.style.transform = '';
  el.style.transition = '';
}

function commitOrderFromDOM() {
  const ids = [...taskListEl.querySelectorAll('.task')].map((el) => el.dataset.id);
  state.tasks.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  save();
}

function finishTask(id, el, ph) {
  el.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
  el.style.transform = 'scale(0.6) translateX(40px)';
  el.style.opacity = '0';
  setTimeout(() => {
    el.remove();
    if (ph && ph.parentNode) flipReorder(() => ph.remove());
  }, 200);

  if (active && active.taskId === id) stopTimer();

  state.tasks = state.tasks.filter((t) => t.id !== id);
  state.doneCount += 1;
  renderDoneCount();
  emptyHint.style.display = state.tasks.length ? 'none' : 'block';
  save();
}

// ===========================================================================
// Timer: modal, countdown, floating window mirror, time tracking
// ===========================================================================
function onPlay(id) {
  if (active && active.taskId === id) {
    // Toggle stop on the currently running task.
    stopTimer();
    return;
  }
  openTimerModal(id);
}

function openTimerModal(id) {
  const task = getTask(id);
  if (!task) return;
  modalTaskId = id;
  modalMinutes = 30;
  modalTaskEl.textContent = task.title;
  durationLabel.textContent = formatDuration(modalMinutes);
  modal.hidden = false;
}

function closeTimerModal() {
  modal.hidden = true;
  modalTaskId = null;
}

document.getElementById('inc-btn').addEventListener('click', () => {
  modalMinutes = Math.min(480, modalMinutes + 30);
  durationLabel.textContent = formatDuration(modalMinutes);
});
document.getElementById('dec-btn').addEventListener('click', () => {
  modalMinutes = Math.max(30, modalMinutes - 30);
  durationLabel.textContent = formatDuration(modalMinutes);
});
document.getElementById('timer-cancel').addEventListener('click', closeTimerModal);
document.getElementById('timer-start').addEventListener('click', () => {
  if (modalTaskId) startTimer(modalTaskId, modalMinutes * 60);
  closeTimerModal();
});
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeTimerModal();
});

function startTimer(id, seconds) {
  // Only one timer at a time.
  if (active) stopTimer();

  const task = getTask(id);
  if (!task) return;

  active = {
    taskId: id,
    remaining: seconds,
    total: seconds,
    running: true,
    intervalId: null
  };

  setRunningVisual(id, true);
  window.api.timerStart(floatingPayload());
  active.intervalId = setInterval(tick, 1000);
}

function floatingPayload() {
  const task = getTask(active.taskId);
  return {
    taskId: active.taskId,
    title: task ? task.title : '',
    color: task ? task.color : '#6c7bff',
    remaining: Math.max(0, active.remaining),
    total: active.total,
    running: active.running
  };
}

function tick() {
  if (!active || !active.running) return;
  active.remaining -= 1;

  const task = getTask(active.taskId);
  if (task) task.secondsSpent += 1;
  updateTaskTimeLabel(active.taskId);

  window.api.timerUpdate(floatingPayload());

  if (active.remaining % 15 === 0) save();

  if (active.remaining <= 0) completeTimer();
}

function completeTimer() {
  const task = getTask(active.taskId);
  try {
    // eslint-disable-next-line no-new
    new Notification('PrioBox', {
      body: task ? `“${task.title}” — time's up!` : "Time's up!"
    });
  } catch (_) { /* notifications may be unavailable */ }
  stopTimer();
}

function stopTimer() {
  if (!active) return;
  const id = active.taskId;
  clearInterval(active.intervalId);
  active = null;
  setRunningVisual(id, false);
  window.api.timerStop();
  save();
}

// Controls relayed from the floating desktop window.
window.api.onFloatingControl((action) => {
  if (!active) return;
  if (action === 'stop') {
    stopTimer();
  } else if (action === 'pause') {
    active.running = false;
    setRunningVisual(active.taskId, false);
    window.api.timerUpdate(floatingPayload());
  } else if (action === 'resume') {
    active.running = true;
    setRunningVisual(active.taskId, true);
    window.api.timerUpdate(floatingPayload());
  }
});

// Ask for notification permission up front (harmless if already granted).
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission().catch(() => {});
}

boot();
