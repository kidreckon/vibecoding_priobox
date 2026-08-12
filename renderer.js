'use strict';

// ===========================================================================
// State
// ===========================================================================
const PALETTE = [
  '#6c7bff', '#2ecc71', '#ff6b6b', '#ffb020',
  '#20c6d6', '#c86bff', '#ff7ac0', '#8a94a6'
];

let state = { tasks: [], done: [], doneCount: 0 };

// Mirror of the countdown the main process is running. The clock itself lives
// there so it keeps ticking while this window is hidden, minimised or
// unfocused; here we only track which task it belongs to.
let active = null; // { taskId, running }

// Throttles disk writes while a countdown is running.
let lastSaveAt = 0;

// Drag runtime.
let drag = null;
let doneArmed = false;
// Set when a task is dropped on the done zone, so the trailing click doesn't
// also open the history panel.
let lastDropAt = 0;

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
    const done = Array.isArray(loaded.done) ? loaded.done : [];
    state = {
      tasks: loaded.tasks,
      done,
      // Saves made before the archive existed only had a bare count; keep it so
      // the lifetime total stays honest.
      doneCount: typeof loaded.doneCount === 'number' ? loaded.doneCount : done.length
    };
    // Backfill any missing fields from older saves.
    state.tasks.forEach((t, i) => {
      if (!t.color) t.color = PALETTE[i % PALETTE.length];
      if (typeof t.secondsSpent !== 'number') t.secondsSpent = 0;
      // Saves predating subtasks have no nesting at all.
      if (!t.parentId) t.parentId = null;
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
// Hierarchy
//
// Tasks stay in one flat, ordered array; `parentId` marks a child. The array is
// kept in display order with a parent's children immediately following it, so
// the drag code can go on reading order straight off the DOM. Nesting is one
// level deep: a child cannot itself have children.
// ===========================================================================
function childrenOf(id) {
  return state.tasks.filter((t) => t.parentId === id);
}

function hasChildren(id) {
  return state.tasks.some((t) => t.parentId === id);
}

// A parent's time is its own plus every child's, including time inherited from
// children that have since been finished — completing a subtask must not make
// the effort logged against its parent disappear.
function totalSeconds(task) {
  if (task.parentId) return task.secondsSpent;
  return (
    task.secondsSpent +
    (task.rolledUpSeconds || 0) +
    childrenOf(task.id).reduce((sum, c) => sum + c.secondsSpent, 0)
  );
}

// Restore the invariant: top-level tasks in order, each followed by its own
// children. Anything pointing at a missing or non-top-level parent is promoted
// rather than silently vanishing from the board.
function normalizeOrder() {
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  for (const t of state.tasks) {
    if (!t.parentId) continue;
    const parent = byId.get(t.parentId);
    if (!parent || parent.parentId) t.parentId = null;
  }
  const ordered = [];
  for (const t of state.tasks) {
    if (t.parentId) continue;
    ordered.push(t);
    for (const c of state.tasks) {
      if (c.parentId === t.id) ordered.push(c);
    }
  }
  state.tasks = ordered;
}

// ===========================================================================
// Render
// ===========================================================================
// Set while an inline "add a subtask" input is open on a parent.
let addingChildFor = null;

function render() {
  normalizeOrder();
  taskListEl.innerHTML = '';

  // The subtask input belongs after the parent's existing children, so a new
  // subtask appears exactly where it will land — or directly under the parent
  // when it has none yet.
  const kids = addingChildFor ? childrenOf(addingChildFor) : [];
  const inputAfter = !addingChildFor ? null
    : kids.length ? kids[kids.length - 1].id : addingChildFor;

  for (const task of state.tasks) {
    taskListEl.appendChild(taskNode(task));
    if (task.id === inputAfter) {
      taskListEl.appendChild(childInputNode(addingChildFor));
    }
  }
  emptyHint.style.display = state.tasks.length ? 'none' : 'block';
  renderDoneCount();
}

// The inline input is appended after the parent's existing children, so a new
// subtask appears where it will actually land.
function childInputNode(parentId) {
  const li = document.createElement('li');
  li.className = 'child-input';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Subtask name — Enter to add, Esc to cancel';
  input.maxLength = 120;

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const value = input.value.trim();
      if (value) {
        addTask(value, parentId);
        input.value = '';
        // Stay open so several subtasks can be added in a row.
        render();
        const next = taskListEl.querySelector('.child-input input');
        if (next) next.focus();
      }
    } else if (e.key === 'Escape') {
      addingChildFor = null;
      render();
    }
  });
  input.addEventListener('blur', () => {
    // Let a click on another control land before tearing the row down.
    setTimeout(() => {
      // Adding a subtask re-renders, which detaches this input and fires its
      // blur — without this guard that stale event would close the fresh row
      // that just replaced it.
      if (!input.isConnected) return;
      if (addingChildFor === parentId && !input.value.trim()) {
        addingChildFor = null;
        render();
      }
    }, 120);
  });

  li.appendChild(input);
  return li;
}

function renderDoneCount() {
  doneCountEl.textContent = `${state.doneCount} done`;
}

function taskNode(task) {
  const running = active && active.taskId === task.id && active.running;
  const isChild = !!task.parentId;
  const kids = isChild ? [] : childrenOf(task.id);

  const li = document.createElement('li');
  li.className = 'task' + (running ? ' running' : '') + (isChild ? ' child' : '');
  li.dataset.id = task.id;
  li.style.setProperty('--task-color', task.color);

  const grip = document.createElement('span');
  grip.className = 'grip';
  grip.textContent = isChild ? '↳' : '⋮⋮';

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = task.title;

  const spent = document.createElement('span');
  spent.className = 'time-spent';
  spent.textContent = formatSpent(totalSeconds(task));
  if (kids.length) {
    spent.classList.add('rolled-up');
    spent.title =
      `${formatSpent(task.secondsSpent + (task.rolledUpSeconds || 0))} on this task, ` +
      `${formatSpent(totalSeconds(task) - task.secondsSpent - (task.rolledUpSeconds || 0))} ` +
      `across ${kids.length} subtask${kids.length > 1 ? 's' : ''}`;
  }

  li.append(grip, title, spent);

  if (isChild) {
    const promote = document.createElement('button');
    promote.className = 'icon-btn promote-btn';
    promote.title = 'Make this a top-level task';
    promote.textContent = '⤴';
    li.appendChild(promote);
  } else {
    const addChild = document.createElement('button');
    addChild.className = 'icon-btn add-child-btn';
    addChild.title = 'Add a subtask';
    addChild.textContent = '+';
    li.appendChild(addChild);
  }

  const colorBtn = document.createElement('button');
  colorBtn.className = 'icon-btn color-btn';
  colorBtn.title = 'Recolor';
  colorBtn.textContent = '🎨';

  const playBtn = document.createElement('button');
  playBtn.className = 'icon-btn play-btn';
  playBtn.title = running ? 'Stop timer' : 'Start timer';
  playBtn.textContent = running ? '■' : '▶';

  li.append(colorBtn, playBtn);
  return li;
}

function setTimeLabel(id) {
  const task = getTask(id);
  const li = taskListEl.querySelector(`.task[data-id="${id}"]`);
  if (task && li) {
    li.querySelector('.time-spent').textContent = formatSpent(totalSeconds(task));
  }
}

// Time logged against a child also moves its parent's rolled-up total.
function updateTaskTimeLabel(id) {
  setTimeLabel(id);
  const task = getTask(id);
  if (task && task.parentId) setTimeLabel(task.parentId);
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
function addTask(title, parentId) {
  const parent = parentId ? getTask(parentId) : null;
  const task = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title,
    // Subtasks inherit their parent's colour so a group reads as one unit.
    color: parent ? parent.color : PALETTE[state.tasks.length % PALETTE.length],
    secondsSpent: 0,
    parentId: parent ? parent.id : null
  };
  state.tasks.push(task);
  save();
  return task;
}

addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = addInput.value.trim();
  if (!value) return;
  addTask(value, null);
  addInput.value = '';
  render();
});

function promoteTask(id) {
  const task = getTask(id);
  if (!task || !task.parentId) return;
  const parent = getTask(task.parentId);
  // The parent keeps the time already logged against it by this child, so
  // detaching a subtask does not rewrite history.
  if (parent) {
    parent.rolledUpSeconds = (parent.rolledUpSeconds || 0) + task.secondsSpent;
  }
  task.parentId = null;
  render();
  save();
}

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
  } else if (e.target.closest('.add-child-btn')) {
    e.stopPropagation();
    addingChildFor = addingChildFor === id ? null : id;
    render();
    const input = taskListEl.querySelector('.child-input input');
    if (input) input.focus();
  } else if (e.target.closest('.promote-btn')) {
    e.stopPropagation();
    promoteTask(id);
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
    // A parent travels with its children; they are lifted out of the list for
    // the duration and put back underneath it wherever it lands.
    isGroup: hasChildren(li.dataset.id),
    parentIdAtStart: (getTask(li.dataset.id) || {}).parentId || null,
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
  if (addingChildFor) {
    addingChildFor = null;
    const row = taskListEl.querySelector('.child-input');
    if (row) row.remove();
  }
  const el = drag.el;

  // Collapse the group down to the parent card while it is in flight; render()
  // rebuilds the children under it once the drop is committed.
  if (drag.isGroup) {
    for (const child of childrenOf(drag.id)) {
      const node = taskListEl.querySelector(`.task[data-id="${child.id}"]`);
      if (node) node.remove();
    }
  }

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
    lastDropAt = Date.now();
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
    // Rebuild so indentation, grips and rolled-up totals match the new nesting.
    render();
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
  const rank = new Map(ids.map((id, i) => [id, i]));

  // A dragged parent's children are not in the DOM right now; rank them just
  // behind their parent so they follow it to its new position.
  const rankOf = (t) =>
    rank.has(t.id) ? rank.get(t.id)
      : rank.has(t.parentId) ? rank.get(t.parentId) + 0.5
        : Number.MAX_SAFE_INTEGER;
  state.tasks.sort((a, b) => rankOf(a) - rankOf(b));

  applyDropNesting(ids);
  normalizeOrder();
  save();
}

// Decide whether the dropped task became someone's subtask. Nesting only
// happens when it is dropped into an existing group — dropping next to a
// childless task is a plain reorder, which keeps ordinary dragging predictable.
// A parent being dragged always stays top-level so groups cannot nest.
function applyDropNesting(ids) {
  const task = getTask(drag.id);
  if (!task || drag.isGroup) {
    if (task) task.parentId = null;
    return;
  }

  const idx = ids.indexOf(task.id);
  const above = idx > 0 ? getTask(ids[idx - 1]) : null;

  if (!above) task.parentId = null;
  else if (above.parentId) task.parentId = above.parentId; // into a group
  else if (hasChildren(above.id)) task.parentId = above.id; // onto a group head
  else task.parentId = null; // beside a plain task — stay top-level

  // Detaching from a parent leaves the time already logged behind, so the
  // parent's total does not drop when a subtask is dragged out of it.
  const from = drag.parentIdAtStart || null;
  if (from && from !== task.parentId) {
    const parent = getTask(from);
    if (parent) {
      parent.rolledUpSeconds = (parent.rolledUpSeconds || 0) + task.secondsSpent;
    }
  }
  // Joining a parent that had previously inherited this task's time gives it
  // back, so moving a subtask between parents does not double-count it.
  if (task.parentId && task.parentId !== from) {
    const parent = getTask(task.parentId);
    if (parent && parent.rolledUpSeconds) {
      parent.rolledUpSeconds = Math.max(0, parent.rolledUpSeconds - task.secondsSpent);
    }
  }
}

function finishTask(id, el, ph) {
  el.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
  el.style.transform = 'scale(0.6) translateX(40px)';
  el.style.opacity = '0';
  setTimeout(() => {
    el.remove();
    if (ph && ph.parentNode) flipReorder(() => ph.remove());
  }, 200);

  const task = getTask(id);
  if (!task) return;

  // Finishing a parent finishes the whole group with it.
  const kids = task.parentId ? [] : childrenOf(id);
  const going = [task, ...kids];

  if (active && going.some((t) => t.id === active.taskId)) stopTimer();

  // Archive before they leave the row, so the history panel can show them.
  const now = Date.now();
  for (const t of going) {
    state.done.unshift({
      id: t.id,
      title: t.title,
      color: t.color,
      // A parent is recorded with the total it actually accumulated.
      secondsSpent: totalSeconds(t),
      // Resolve the real parent: `task` is the child itself when a subtask is
      // finished on its own, so its own title must not be used here.
      parentTitle: t.parentId ? (getTask(t.parentId) || {}).title || null : null,
      completedAt: now
    });
  }

  // A finished subtask leaves its time with its parent — the work still counts
  // towards the parent even though the subtask is gone from the board.
  if (task.parentId) {
    const parent = getTask(task.parentId);
    if (parent) {
      parent.rolledUpSeconds = (parent.rolledUpSeconds || 0) + task.secondsSpent;
    }
  }

  const goingIds = new Set(going.map((t) => t.id));
  state.tasks = state.tasks.filter((t) => !goingIds.has(t.id));
  state.doneCount += going.length;
  renderDoneCount();
  emptyHint.style.display = state.tasks.length ? 'none' : 'block';
  save();

  // Children were removed from the model but their rows are still on screen.
  if (kids.length) {
    for (const child of kids) {
      const node = taskListEl.querySelector(`.task[data-id="${child.id}"]`);
      if (node) node.remove();
    }
  }
  if (task.parentId) setTimeLabel(task.parentId);
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
  const task = getTask(id);
  if (!task) return;

  // Only one countdown at a time; starting a new one replaces the old.
  if (active) setRunningVisual(active.taskId, false);
  active = { taskId: id, running: true };
  lastSaveAt = Date.now();

  setRunningVisual(id, true);
  window.api.timerStart({
    taskId: id,
    title: task.title,
    color: task.color,
    seconds,
    baseSpent: task.secondsSpent
  });
}

function stopTimer() {
  if (!active) return;
  const id = active.taskId;
  active = null;
  lastTimerState = null;
  setRunningVisual(id, false);
  window.api.timerStop();
  save();
}

// Last state pushed by the main process, which owns the countdown.
let lastTimerState = null;

// The tracked total is derived from the deadline against the wall clock, not
// accumulated from updates, so it is correct on the first repaint after this
// window has been minimised, hidden or otherwise starved of ticks.
function applyTimerState() {
  const s = lastTimerState;
  if (!s) return;

  const task = getTask(s.taskId);
  if (!task) return; // task was finished or removed meanwhile

  const remaining = s.running
    ? Math.max(0, s.endsAt - Date.now())
    : s.remainingMs;
  // Time spent on this run is exactly the part of the countdown consumed, so a
  // long freeze can never bank more than the timer's own length.
  const spentMs = Math.max(0, s.totalMs - remaining);

  task.secondsSpent = (s.baseSpent || 0) + Math.floor(spentMs / 1000);
  updateTaskTimeLabel(s.taskId);

  if (!active || active.taskId !== s.taskId || active.running !== s.running) {
    if (active && active.taskId !== s.taskId) setRunningVisual(active.taskId, false);
    active = { taskId: s.taskId, running: s.running };
    setRunningVisual(s.taskId, s.running);
  }

  if (s.finished) {
    active = null;
    setRunningVisual(s.taskId, false);
    lastTimerState = null;
    save();
    return;
  }

  const now = Date.now();
  if (now - lastSaveAt > 10000) {
    lastSaveAt = now;
    save();
  }
}

// Adopting on any incoming state covers the board being reopened, reloaded or
// restored while a countdown is already running.
window.api.onTimerState((s) => {
  lastTimerState = s;
  applyTimerState();
});

// Own ticker plus wake hooks — independent of updates arriving.
let lastBoardTickAt = 0;
setInterval(() => {
  const now = Date.now();
  if (lastBoardTickAt && now - lastBoardTickAt > 3000 && lastTimerState) {
    window.api.diag('STALL  board window was not scheduled for ' +
      Math.round((now - lastBoardTickAt) / 1000) + 's  hidden=' + document.hidden);
  }
  lastBoardTickAt = now;
  applyTimerState();
}, 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    applyTimerState();
    window.api.timerRefresh();
  }
});
window.addEventListener('focus', () => {
  applyTimerState();
  window.api.timerRefresh();
});

// Stop can also come from the floating widget's own button.
window.api.onTimerStopped(() => {
  lastTimerState = null;
  if (!active) return;
  const id = active.taskId;
  active = null;
  setRunningVisual(id, false);
  save();
});

// ===========================================================================
// Completed-task history
// ===========================================================================
const historyModal = document.getElementById('history-modal');
const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');
const historyLegacy = document.getElementById('history-legacy');
const statCount = document.getElementById('stat-count');
const statTime = document.getElementById('stat-time');
const clearBtn = document.getElementById('history-clear');

function formatWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 86400000;
  const diffDays = Math.floor((startOfToday - d.getTime()) / dayMs);

  if (d.getTime() >= startOfToday.getTime()) return `Today ${time}`;
  if (diffDays < 1) return `Yesterday ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` ${time}`;
}

function openHistory() {
  renderHistory();
  historyModal.hidden = false;
}

function closeHistory() {
  historyModal.hidden = true;
  resetClearBtn();
}

function renderHistory() {
  historyList.innerHTML = '';

  for (const entry of state.done) {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.style.setProperty('--task-color', entry.color || '#6c7bff');

    const dot = document.createElement('span');
    dot.className = 'history-dot';

    const body = document.createElement('div');
    body.className = 'history-body';

    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = entry.title;

    const meta = document.createElement('div');
    meta.className = 'history-meta';
    const when = formatWhen(entry.completedAt);
    const parts = [`${formatSpent(entry.secondsSpent || 0)} tracked`];
    if (entry.parentTitle) parts.push(`↳ ${entry.parentTitle}`);
    if (when) parts.push(when);
    meta.textContent = parts.join(' · ');

    body.append(title, meta);

    const restore = document.createElement('button');
    restore.className = 'restore-btn';
    restore.textContent = 'Restore';
    restore.title = 'Put this task back on the board';
    restore.addEventListener('click', () => restoreTask(entry.id));

    li.append(dot, body, restore);
    historyList.appendChild(li);
  }

  historyEmpty.style.display = state.done.length ? 'none' : 'block';

  const totalSeconds = state.done.reduce((sum, e) => sum + (e.secondsSpent || 0), 0);
  statCount.textContent = String(state.doneCount);
  statTime.textContent = formatSpent(totalSeconds);

  // Tasks finished before the archive existed have no detail to show.
  const untracked = state.doneCount - state.done.length;
  if (untracked > 0) {
    historyLegacy.hidden = false;
    historyLegacy.textContent =
      `+ ${untracked} finished before history was recorded`;
  } else {
    historyLegacy.hidden = true;
  }
}

function restoreTask(entryId) {
  const idx = state.done.findIndex((e) => e.id === entryId);
  if (idx === -1) return;

  const [entry] = state.done.splice(idx, 1);

  // Re-attach to its parent if that parent is still on the board, handing back
  // the time the parent inherited when the subtask was finished. Otherwise it
  // returns as a top-level task.
  let parentId = null;
  if (entry.parentTitle) {
    const parent = state.tasks.find(
      (t) => !t.parentId && t.title === entry.parentTitle
    );
    if (parent) {
      parentId = parent.id;
      parent.rolledUpSeconds = Math.max(
        0, (parent.rolledUpSeconds || 0) - (entry.secondsSpent || 0)
      );
    }
  }

  state.tasks.push({
    id: entry.id,
    title: entry.title,
    color: entry.color || PALETTE[0],
    secondsSpent: entry.secondsSpent || 0,
    parentId
  });
  state.doneCount = Math.max(0, state.doneCount - 1);

  render();
  renderHistory();
  save();
}

// Two-step confirm so a stray click can't wipe the archive.
let clearArmed = false;
function resetClearBtn() {
  clearArmed = false;
  clearBtn.textContent = 'Clear history';
  clearBtn.classList.remove('confirming');
}

clearBtn.addEventListener('click', () => {
  if (!clearArmed) {
    clearArmed = true;
    clearBtn.textContent = 'Tap again to clear';
    clearBtn.classList.add('confirming');
    return;
  }
  state.done = [];
  state.doneCount = 0;
  resetClearBtn();
  renderHistory();
  renderDoneCount();
  save();
});

document.getElementById('history-btn').addEventListener('click', openHistory);
document.getElementById('history-close').addEventListener('click', closeHistory);
doneZone.addEventListener('click', () => {
  if (Date.now() - lastDropAt < 400) return; // just finished a drop here
  openHistory();
});
historyModal.addEventListener('click', (e) => {
  if (e.target === historyModal) closeHistory();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!historyModal.hidden) closeHistory();
  else if (!modal.hidden) closeTimerModal();
});

// Stamp the running build into the UI so it is always obvious which code is
// actually executing — a rebuilt .app and a `npm start` run can differ.
document.getElementById('reveal-log').addEventListener('click', () => {
  window.api.revealLog();
});

window.api.appInfo().then((info) => {
  const badge = document.getElementById('version-badge');
  badge.textContent = 'v' + info.version + ' · ' + info.build +
    (info.packaged ? ' · app' : ' · dev');
  badge.title = 'Diagnostics log: ' + info.logFile;
});

boot();
