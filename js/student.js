'use strict';

/* =====================================================================
   Блиц-опрос — страница студента.
   Обратный отсчёт начинается, когда студент УВИДЕЛ вопрос (точная
   синхронизация часов не нужна). На сервер отправляется время,
   которое студент затратил на ответ. Можно заходить в середине теста.
   ===================================================================== */

const $ = function (id) { return document.getElementById(id); };

let room = null;
let sid = null;
let name = '';
let state = null;

let lastShownRound = 0;    // раунд, который сейчас на экране
let submitted = false;     // ответ на показанный раунд отправлен
let lastAnswer = null;     // мой ответ текущего раунда
let qStartPerf = 0;        // performance.now() в момент показа вопроса
let qDuration = 0;
let timerInt = null;
let pollInt = null;
let screen = 'join';
let finalShown = false;
let lastResults = null;
let judgeRoundShown = 0;

/* ---------------- переключение экранов ---------------- */

function show(sec) {
  ['sec-join', 'sec-wait', 'sec-question', 'sec-sent', 'sec-late', 'sec-judge', 'sec-final']
    .forEach(function (s) { $(s).classList.add('hidden'); });
  $(sec).classList.remove('hidden');
  screen = sec.replace('sec-', '');
}

function setConn(ok) {
  $('conn').classList.toggle('on', ok);
  $('conn-text').textContent = ok ? 'связь с сервером есть' : 'нет связи с сервером';
}

/* ---------------- вход ---------------- */

(async function init() {
  const h = decodeURIComponent(location.hash || '').replace(/^#/, '');
  if (h) $('in-room').value = safeRoom(h);
  const r = localStorage.getItem('blitz_room');
  if (r && !h) $('in-room').value = r;
  const n = r && localStorage.getItem('blitz_name_' + r);
  if (n) $('in-name').value = n;
})();

$('btn-join').addEventListener('click', join);
$('in-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') join(); });

async function join() {
  room = safeRoom($('in-room').value);
  name = ($('in-name').value || '').trim().slice(0, 40) || 'Без имени';
  if (!room) { alert('Введите код комнаты от преподавателя'); return; }
  sid = localStorage.getItem('blitz_sid_' + room) || safeId(name);
  localStorage.setItem('blitz_sid_' + room, sid);
  localStorage.setItem('blitz_name_' + room, name);
  localStorage.setItem('blitz_room', room);
  $('btn-join').disabled = true;
  try {
    await syncClock();
    await apiPut('students/' + room + '/' + sid + '.json', {
      sid: sid, name: name, at: new Date().toISOString()
    });
    $('wait-text').textContent = 'Вы в комнате. Ждём начала…';
    show('sec-wait');
    clearInterval(pollInt);
    pollInt = setInterval(tick, POLL_MS);
    tick();
  } catch (e) {
    alert('Не удалось подключиться: ' + e.message +
      '\nПроверьте код комнаты и адрес сервера: ' + API_BASE);
  }
  $('btn-join').disabled = false;
}

/* ---------------- фоновый опрос ---------------- */

async function tick() {
  try {
    syncClock();
    const st = await apiGet('rooms/' + room + '.json');
    setConn(true);
    state = st;
    if (!st) {
      if (screen !== 'wait') show('sec-wait');
      $('wait-text').textContent = 'Комната пока не создана. Ждём учителя…';
      return;
    }
    if (st.status === 'active' && st.round) {
      if (lastShownRound !== st.round) { await showQuestion(st); return; }
      if (screen === 'question') updateTimer();
      // если ответ уже отправлен — остаёмся на экране «Ответ принят»
    } else if (st.status === 'judge') {
      showJudge(st);
    } else if (st.status === 'done') {
      await showFinal();
    } else { // lobby
      if (lastResults && !lastResults.finished) finalShown = false;
      if (finalShown && lastResults && lastResults.finished) return; // остаёмся на итогах
      if (screen !== 'wait') show('sec-wait');
      $('wait-text').textContent = 'Ждём следующего вопроса…';
    }
  } catch (e) {
    setConn(false);
  }
}

/* ---------------- показ вопроса ---------------- */

async function showQuestion(st) {
  if (lastShownRound === st.round) return;
  lastShownRound = st.round;

  // после перезагрузки страницы: возможно, ответ уже отправлен
  try {
    const prev = await apiGet('answers/' + room + '/r' + st.round + '_' + sid + '.json');
    if (prev) {
      lastAnswer = prev.answer;
      submitted = true;
      $('sent-text').textContent = 'Ответ принят: ' + prev.answer;
      show('sec-sent');
      return;
    }
  } catch (e) { /* ответа ещё нет — отвечаем */ }

  const remainMs = st.startedAt + st.duration * 1000 - serverNow();
  if (remainMs <= 500) {
    // зашёл, когда время уже истекло
    submitted = true;
    lastAnswer = null;
    $('late-text').textContent = 'Раунд ' + st.round + ': время истекло, ответ не принят.';
    show('sec-late');
    return;
  }

  submitted = false;
  lastAnswer = null;
  qDuration = st.duration;
  qStartPerf = performance.now();

  $('q-round').textContent = 'Раунд ' + st.round;
  $('q-type').textContent = st.type === 'choice' ? 'Выберите один из вариантов' : 'Введите ответ текстом';

  const grid = $('q-options');
  grid.textContent = '';
  if (st.type === 'choice') {
    $('q-choice').classList.remove('hidden');
    $('q-textblock').classList.add('hidden');
    CHOICE_OPTIONS.forEach(function (o) {
      const b = document.createElement('button');
      b.textContent = o;
      b.addEventListener('click', function () { submit(o); });
      grid.appendChild(b);
    });
  } else {
    $('q-choice').classList.add('hidden');
    $('q-textblock').classList.remove('hidden');
    $('q-input').value = '';
    show('sec-question');
    $('q-input').focus();
  }

  show('sec-question');
  updateTimer();
  clearInterval(timerInt);
  timerInt = setInterval(updateTimer, 100);
}

function updateTimer() {
  if (!state) return;
  const rem = (state.startedAt + qDuration * 1000 - serverNow()) / 1000;
  const shown = Math.max(0, rem);
  $('t-num').textContent = Math.ceil(shown);
  const pct = Math.max(0, Math.min(100, (shown / qDuration) * 100));
  $('t-fill').style.width = pct + '%';
  $('t-bar').classList.toggle('low', shown < qDuration * 0.25);
  if (rem <= -GRACE_SECONDS) {
    // время вышло, ответ так и не отправлен
    clearInterval(timerInt);
    if (!submitted) {
      submitted = true;
      lastAnswer = null;
      $('late-text').textContent = 'Время вышло. Ответ не отправлен.';
      show('sec-late');
    }
  }
}

/* ---------------- отправка ответа ---------------- */

async function submit(answer) {
  if (submitted || !state) return;
  submitted = true; // защита от двойного нажатия
  clearInterval(timerInt);
  // затраченное время — от момента, когда студент увидел вопрос
  const elapsed = Math.max(0.1,
    Math.min((performance.now() - qStartPerf) / 1000, qDuration + GRACE_SECONDS));
  lastAnswer = answer;
  try {
    await apiPut('answers/' + room + '/r' + state.round + '_' + sid + '.json', {
      sid: sid,
      name: name,
      answer: answer,
      elapsed: Math.round(elapsed * 10) / 10,
      at: new Date().toISOString()
    });
    $('sent-text').textContent = 'Ответ принят: ' +
      (state.type === 'choice' ? ('вариант ' + answer) : ('«' + answer + '»')) +
      '. Ждём остальных…';
    show('sec-sent');
  } catch (e) {
    submitted = false;
    alert('Не удалось отправить ответ: ' + e.message);
  }
}

$('q-send').addEventListener('click', function () {
  const v = $('q-input').value.trim().slice(0, 200);
  if (!v) { alert('Введите ответ'); return; }
  submit(v);
});
$('q-input').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') $('q-send').click();
});

/* ---------------- проверка раунда ---------------- */

function showJudge(st) {
  if (st.round === judgeRoundShown && screen === 'judge') return;
  judgeRoundShown = st.round;
  clearInterval(timerInt);
  const corr = st.lastCorrect;
  let msg;
  if (corr == null) {
    msg = 'Раунд закрыт без правильного ответа.';
  } else {
    const mine = lastAnswer;
    const ok = mine != null && normText(mine) === normText(corr);
    msg = 'Правильный ответ: ' + corr + '. Ваш ответ: ' +
      (mine == null ? '— (не ответили)' : mine) +
      ' — ' + (ok ? 'верно (+1 балл)' : 'неверно (+1 к неправильным)');
  }
  $('verdict').textContent = msg;
  show('sec-judge');
}

/* ---------------- итоги ---------------- */

async function showFinal() {
  if (finalShown) return;
  try {
    const res = await apiGet('results/' + room + '.json');
    if (!res || !res.finished) {
      if (screen !== 'wait') show('sec-wait');
      $('wait-text').textContent = 'Ждём итогов…';
      return;
    }
    lastResults = res;
    finalShown = true;
    const rows = res.standings || [];
    const me = rows.find(function (r) { return r.sid === sid; });
    $('me-name').textContent = name;
    const chip = $('me-chip');
    if (me) {
      chip.className = 'chip g' + (me.group + 1);
      chip.textContent = GROUP_NAMES[me.group];
      chip.classList.remove('hidden');
      $('me-stats').textContent = 'Верно: ' + me.correct + ' • Неверно: ' + me.wrong +
        ' • Время: ' + fmtTime(me.time) + ' • Балл: ' + me.score;
    } else {
      chip.classList.add('hidden');
      $('me-stats').textContent = 'Нет данных — вы присоединились после завершения теста.';
    }
    const box = $('groups-box');
    box.textContent = '';
    [0, 1, 2].forEach(function (gi) {
      const list = rows.filter(function (r) { return r.group === gi; });
      if (!list.length) return;
      const div = document.createElement('div');
      div.className = 'answerGroup';
      const h = document.createElement('div');
      h.className = 'ans';
      h.textContent = GROUP_NAMES[gi] + ' — ' + list.length;
      const nm = document.createElement('div');
      nm.className = 'names';
      nm.textContent = list.map(function (r) { return r.name; }).join(', ');
      div.append(h, nm);
      box.appendChild(div);
    });
    show('sec-final');
  } catch (e) { /* повторим на следующем опросе */ }
}
