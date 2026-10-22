'use strict';

/* =====================================================================
   Блиц-опрос — панель преподавателя.
   Преподаватель НЕ пишет текст вопроса: он выбирает только ТИП раунда
   («варианты А-Е» — 20 с или «текст» — 40 с), видит ответы студентов
   сгруппированными и отмечает один правильный.
   ===================================================================== */

const $ = function (id) { return document.getElementById(id); };

let room = null;
let auth = null;               // 'Basic ...' если задан пароль учителя
let state = null;              // содержимое rooms/{room}.json
let students = {};             // sid -> {name}
const seenStudents = new Set();
const seenAnswerFiles = new Set();
let answersByRound = {};       // номер раунда -> sid -> {name, answer, elapsed}
let screen = 'setup';
let pollInt = null;
let roundTimerInt = null;
let curRound = 0;
let lastJudgedKey = null;      // отмеченный правильный ответ (нормализованный)
let lastJudgedTitle = '';      // как показать правильный ответ человеку
let lastResults = null;
let lastFinalRows = [];

/* ---------------- переключение экранов ---------------- */

function show(sec) {
  ['sec-setup', 'sec-lobby', 'sec-round', 'sec-final'].forEach(function (s) {
    $(s).classList.add('hidden');
  });
  $(sec).classList.remove('hidden');
  screen = sec.replace('sec-', '');
}

function setConn(ok) {
  $('conn').classList.toggle('on', ok);
  $('conn-text').textContent = ok ? 'связь с сервером есть' : 'нет связи с сервером';
}

/* ---------------- открытие комнаты ---------------- */

$('btn-open').addEventListener('click', openRoom);

async function openRoom() {
  const inp = $('room-id');
  room = safeRoom(inp.value) || randomRoom();
  inp.value = room;
  const pass = $('teacher-pass').value.trim();
  auth = pass ? 'Basic ' + btoa('teacher:' + pass) : null;
  $('btn-open').disabled = true;
  try {
    await syncClock();
    state = await apiGet('rooms/' + room + '.json', auth);
    if (!state) {
      state = { status: 'lobby', round: 0, created: new Date().toISOString() };
      await apiPut('rooms/' + room + '.json', state, auth);
    }
    if (state.status === 'judge' && state.lastCorrect != null) {
      lastJudgedKey = state.lastCorrect;
      lastJudgedTitle = String(state.lastCorrect);
    }
    clearInterval(pollInt);
    pollInt = setInterval(tick, 1200);
    show('sec-lobby');
    if (state.status === 'active') enterRound();
    else if (state.status === 'done') {
      const res = await apiGet('results/' + room + '.json', auth);
      lastFinalRows = (res && res.standings) || rankFromScores((res && res.scores) || {});
      renderFinal(lastFinalRows);
      show('sec-final');
    }
    tick();
  } catch (e) {
    alert('Не удалось открыть комнату: ' + e.message +
      '\nПроверьте настройки сервера: ' + API_BASE);
  }
  $('btn-open').disabled = false;
}

/* ---------------- фоновый опрос ---------------- */

async function tick() {
  try {
    syncClock();
    const st = await apiGet('rooms/' + room + '.json', auth);
    setConn(true);
    if (st) state = st;
    if (!state) return;
    await pollStudents();
    if (screen === 'lobby') {
      lastResults = await apiGet('results/' + room + '.json', auth);
      renderLobby();
      if (state.status === 'active') enterRound();
    } else if (screen === 'round') {
      if (state.round === curRound) await pollAnswers(state.round);
      renderRound();
    }
  } catch (e) {
    setConn(false);
  }
}

async function pollStudents() {
  let files;
  try { files = await apiList('students/' + room); } catch (e) { return; }
  for (const f of files) {
    if (seenStudents.has(f)) continue;
    seenStudents.add(f);
    try {
      const d = await apiGet('students/' + room + '/' + f);
      const sid = f.replace(/\.json$/, '');
      if (d && d.name) students[d.sid || sid] = { name: d.name };
    } catch (e) { /* пропускаем битый файл */ }
  }
}

async function pollAnswers(n) {
  let files;
  try { files = await apiList('answers/' + room); } catch (e) { return; }
  const pref = 'r' + n + '_';
  for (const f of files) {
    if (!f.startsWith(pref) || seenAnswerFiles.has(f)) continue;
    seenAnswerFiles.add(f);
    try {
      const d = await apiGet('answers/' + room + '/' + f);
      const sid = f.slice(pref.length, -5); // убираем "r{N}_" и ".json"
      if (d) {
        answersByRound[n] = answersByRound[n] || {};
        answersByRound[n][sid] = {
          name: d.name || sid,
          answer: d.answer,
          elapsed: +d.elapsed || 0
        };
      }
    } catch (e) { /* пропускаем битый файл */ }
  }
}

/* ---------------- лобби ---------------- */

function renderLobby() {
  $('lobby-room').textContent = room;
  const base = location.href.replace(/teacher\.html.*$/, '');
  $('stu-link').value = base + 'student.html#' + room;
  $('stu-count').textContent = Object.keys(students).length;
  const ul = $('stu-list');
  ul.textContent = '';
  Object.values(students).map(function (s) { return s.name; })
    .sort(function (a, b) { return a.localeCompare(b); })
    .forEach(function (n) {
      const li = document.createElement('li');
      li.textContent = n;
      ul.appendChild(li);
    });
  $('btn-finish').disabled = !(lastResults && Object.keys(lastResults.scores || {}).length > 0);
}

$('btn-copy').addEventListener('click', async function () {
  const inp = $('stu-link');
  try {
    await navigator.clipboard.writeText(inp.value);
  } catch (e) {
    inp.select();
    try { document.execCommand('copy'); } catch (e2) { /* вручную */ }
  }
  $('btn-copy').textContent = 'Скопировано';
  setTimeout(function () { $('btn-copy').textContent = 'Копировать'; }, 1500);
});

/* ---------------- раунды ---------------- */

$('btn-choice').addEventListener('click', function () { startRound('choice'); });
$('btn-text').addEventListener('click', function () { startRound('text'); });

async function startRound(type) {
  const duration = type === 'choice' ? CHOICE_SECONDS : TEXT_SECONDS;
  const next = (state.round || 0) + 1;
  const st = {
    status: 'active',
    round: next,
    type: type,
    duration: duration,
    startedAt: serverNow(),
    lastCorrect: null
  };
  try {
    await apiPut('rooms/' + room + '.json', st, auth);
    state = st;
    answersByRound[next] = {};
    enterRound();
  } catch (e) {
    alert('Не удалось запустить раунд: ' + e.message);
  }
}

function enterRound() {
  curRound = state.round;
  lastJudgedKey = null;
  lastJudgedTitle = '';
  show('sec-round');
  renderRound();
  clearInterval(roundTimerInt);
  roundTimerInt = setInterval(function () {
    if (screen === 'round') renderTimer();
  }, 200);
}

function renderTimer() {
  if (!state || state.status !== 'active') { $('t-num').textContent = '–'; return; }
  const rem = Math.max(0, (state.startedAt + state.duration * 1000 - serverNow()) / 1000);
  $('t-num').textContent = Math.ceil(rem);
  const pct = Math.max(0, Math.min(100, (rem / state.duration) * 100));
  $('t-fill').style.width = pct + '%';
  $('t-bar').classList.toggle('low', rem < state.duration * 0.25);
}

function renderRound() {
  const isChoice = state.type === 'choice';
  $('round-title').textContent = 'Раунд ' + curRound + ' — ' +
    (isChoice ? 'выбор варианта (20 сек)' : 'ввод текста (40 сек)');
  renderTimer();

  const ans = answersByRound[curRound] || {};
  const groups = {};                 // ключ -> {title, names[]}
  if (isChoice) {
    CHOICE_OPTIONS.forEach(function (o) { groups[o] = { title: o, names: [] }; });
  }
  Object.values(ans).forEach(function (a) {
    const key = isChoice ? String(a.answer) : normText(a.answer);
    if (!groups[key]) groups[key] = { title: isChoice ? key : String(a.answer), names: [] };
    groups[key].names.push(a.name);
  });

  const box = $('answers');
  box.textContent = '';
  const keys = Object.keys(groups).sort(function (a, b) {
    return groups[b].names.length - groups[a].names.length;
  });
  if (!keys.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Ответов пока нет…';
    box.appendChild(p);
  }
  keys.forEach(function (k) {
    const g = groups[k];
    const div = document.createElement('div');
    div.className = 'answerGroup';
    const head = document.createElement('div');
    head.className = 'head';
    const ansEl = document.createElement('span');
    ansEl.className = 'ans';
    ansEl.textContent = isChoice ? ('Вариант ' + g.title) : ('«' + g.title + '»');
    const cnt = document.createElement('span');
    cnt.className = 'chip';
    cnt.textContent = g.names.length;
    const btn = document.createElement('button');
    btn.className = 'success';
    btn.textContent = 'Это правильный ответ';
    btn.disabled = !!lastJudgedKey;
    btn.addEventListener('click', function () { judge(k, g.title); });
    head.append(ansEl, cnt, btn);
    const nm = document.createElement('div');
    nm.className = 'names';
    nm.textContent = g.names.join(', ');
    div.append(head, nm);
    box.appendChild(div);
  });

  $('judged-note').textContent = lastJudgedKey
    ? ('Правильный ответ отмечен: ' + (isChoice ? lastJudgedTitle : '«' + lastJudgedTitle + '»'))
    : '';
  $('btn-skip').disabled = !!lastJudgedKey;
  $('round-controls').classList.toggle('hidden', !lastJudgedKey);
}

/* Закрытие раунда: пересчёт накопленных результатов (results/{room}.json).
   correctKey = нормализованный правильный ответ или null (без проверки). */
async function closeRound(correctKey) {
  const res = (await apiGet('results/' + room + '.json', auth)) ||
    { rounds: [], scores: {}, finished: false };
  const n = state.round;
  const ans = answersByRound[n] || {};

  Object.keys(ans).forEach(function (k) {
    if (!res.scores[k]) res.scores[k] = { name: ans[k].name || k, correct: 0, wrong: 0, time: 0 };
  });
  Object.keys(students).forEach(function (k) {
    if (!res.scores[k]) res.scores[k] = { name: students[k].name, correct: 0, wrong: 0, time: 0 };
  });

  Object.keys(res.scores).forEach(function (k) {
    const s = res.scores[k];
    if (ans[k]) {
      s.time += Math.min(+ans[k].elapsed || 0, state.duration + GRACE_SECONDS);
      if (correctKey != null) {
        if (String(ans[k].answer) === correctKey) s.correct++;
        else s.wrong++;
      }
    } else {
      s.time += state.duration + MISS_PENALTY_SEC; // пропуск раунда
    }
    if (students[k]) s.name = students[k].name;
  });

  const meta = { n: n, type: state.type, duration: state.duration, correctKey: correctKey };
  const rt = res.rounds.find(function (r) { return r.n === n; });
  if (rt) Object.assign(rt, meta); else res.rounds.push(meta);
  res.updated = new Date().toISOString();
  await apiPut('results/' + room + '.json', res, auth);
  lastResults = res;
  return res;
}

async function judge(key, title) {
  if (lastJudgedKey) return;
  const isChoice = state.type === 'choice';
  if (!confirm('Отметить как правильный: ' +
    (isChoice ? ('вариант ' + title) : ('«' + title + '»')) + '?')) return;
  try {
    const normKey = isChoice ? key : normText(title);
    await closeRound(normKey);
    lastJudgedKey = normKey;
    lastJudgedTitle = title;
    state.status = 'judge';
    state.lastCorrect = normKey;
    await apiPut('rooms/' + room + '.json', state, auth);
    renderRound();
  } catch (e) {
    alert('Ошибка: ' + e.message);
  }
}

$('btn-skip').addEventListener('click', async function () {
  if (lastJudgedKey) return;
  if (!confirm('Закрыть раунд без правильного ответа? Баллы не изменятся, время будет учтено.')) return;
  try {
    await closeRound(null);
    state.status = 'lobby';
    await apiPut('rooms/' + room + '.json', state, auth);
    backToLobby();
  } catch (e) {
    alert('Ошибка: ' + e.message);
  }
});

$('btn-next').addEventListener('click', async function () {
  try {
    state.status = 'lobby';
    await apiPut('rooms/' + room + '.json', state, auth);
  } catch (e) { /* не критично */ }
  backToLobby();
});

function backToLobby() {
  clearInterval(roundTimerInt);
  show('sec-lobby');
  renderLobby();
}

/* ---------------- завершение теста ---------------- */

$('btn-finish').addEventListener('click', finish);
$('btn-finish2').addEventListener('click', finish);

async function finish() {
  if (!confirm('Завершить тест и разделить студентов на группы?')) return;
  try {
    const res = (await apiGet('results/' + room + '.json', auth)) || lastResults || { scores: {} };
    const rows = rankFromScores(res.scores || {});
    res.finished = true;
    res.standings = rows;
    res.updated = new Date().toISOString();
    await apiPut('results/' + room + '.json', res, auth);
    state.status = 'done';
    await apiPut('rooms/' + room + '.json', state, auth);
    renderFinal(rows);
    show('sec-final');
  } catch (e) {
    alert('Ошибка: ' + e.message);
  }
}

/* Балл = 70% за верные ответы + 30% за скорость (меньше суммарное время — лучше).
   Затем сортировка и деление на группы 50% / 30% / 20%. */
function rankFromScores(scores) {
  const rows = Object.keys(scores || {}).map(function (sid) {
    const s = scores[sid] || {};
    return {
      sid: sid,
      name: s.name || sid,
      correct: +s.correct || 0,
      wrong: +s.wrong || 0,
      time: +s.time || 0
    };
  });
  if (!rows.length) return [];
  const maxCorrect = Math.max(1, Math.max.apply(null, rows.map(function (r) { return r.correct; })));
  const minTime = Math.min.apply(null, rows.map(function (r) { return r.time; }));
  rows.forEach(function (r) {
    const cN = r.correct / maxCorrect;
    const tN = r.time > 0 ? minTime / r.time : 1;
    r.score = Math.round((70 * cN + 30 * tN) * 10) / 10;
  });
  rows.sort(function (a, b) {
    return b.score - a.score || b.correct - a.correct || a.time - b.time ||
      a.name.localeCompare(b.name);
  });
  const g = splitGroups(rows.length);
  rows.forEach(function (r, i) {
    r.group = i < g[0] ? 0 : (i < g[0] + g[1] ? 1 : 2);
  });
  return rows;
}

function renderFinal(rows) {
  lastFinalRows = rows;
  const tb = $('final-body');
  tb.textContent = '';
  rows.forEach(function (r, i) {
    const tr = document.createElement('tr');
    [String(i + 1), r.name, String(r.correct), String(r.wrong), fmtTime(r.time), String(r.score)]
      .forEach(function (v) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      });
    const td = document.createElement('td');
    const chip = document.createElement('span');
    chip.className = 'chip g' + (r.group + 1);
    chip.textContent = GROUP_NAMES[r.group];
    td.appendChild(chip);
    tr.appendChild(td);
    tb.appendChild(tr);
  });
}

$('btn-csv').addEventListener('click', function () {
  if (!lastFinalRows.length) return;
  const head = ['Место', 'Студент', 'Верно', 'Неверно', 'Время (с)', 'Балл', 'Группа'];
  const lines = [head.join(';')].concat(lastFinalRows.map(function (r, i) {
    return [i + 1, r.name, r.correct, r.wrong, Math.round(r.time), r.score, GROUP_NAMES[r.group]].join(';');
  }));
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'blitz-' + room + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

$('btn-new').addEventListener('click', async function () {
  if (!confirm('Начать новый тест? Студенты останутся в комнате, результаты обнулятся.')) return;
  try {
    const fresh = { rounds: [], scores: {}, finished: false, updated: new Date().toISOString() };
    await apiPut('results/' + room + '.json', fresh, auth);
    lastResults = fresh;
    state = { status: 'lobby', round: 0 };
    await apiPut('rooms/' + room + '.json', state, auth);
    answersByRound = {};
    seenAnswerFiles.clear();
    lastJudgedKey = null;
    lastJudgedTitle = '';
    backToLobby();
  } catch (e) {
    alert('Ошибка: ' + e.message);
  }
});
