'use strict';

/* =====================================================================
   Блиц-опрос — общий модуль (страницы преподавателя и студента)
   Обмен данными: JSON-файлы на сервере 194.87.103.77 через nginx
   (GET — чтение, PUT — запись; каталоги создаёт сам nginx).
   ===================================================================== */

/* ====== ЕДИНСТВЕННАЯ НАСТРОЙКА: адрес обмена данными ======
   ВАЖНО: страница на GitHub Pages должна быть открыта по http://
   (в настройках Pages НЕ включать "Enforce HTTPS"),
   иначе браузер заблокирует запросы к http://194.87.103.77
   как mixed content. Если на сервере настроен HTTPS — поменяйте
   адрес на https и включите Enforce HTTPS обратно. */
const API_BASE = 'http://194.87.103.77/blitz/data';

/* Параметры теста */
const CHOICE_OPTIONS   = ['А', 'Б', 'С', 'Д', 'Е'];
const CHOICE_SECONDS   = 20;   // раунд «выбор варианта»
const TEXT_SECONDS     = 40;   // раунд «ввод текста»
const GRACE_SECONDS    = 3;    // запас на задержки сети при отправке
const MISS_PENALTY_SEC = 5;    // штраф ко времени за пропущенный раунд
const POLL_MS          = 1500; // период опроса сервера

const GROUP_NAMES = ['отлично', 'хорошо', 'удовлетворительно'];

/* ---------------- низкоуровневый обмен с nginx ---------------- */

function apiUrl(path) { return API_BASE + '/' + path; }

async function apiGet(path, auth) {
  const headers = {};
  if (auth) headers['Authorization'] = auth;
  const r = await fetch(apiUrl(path), { method: 'GET', cache: 'no-store', headers });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('GET ' + r.status);
  return r.json();
}

async function apiPut(path, obj, auth) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers['Authorization'] = auth;
  const r = await fetch(apiUrl(path), {
    method: 'PUT',
    headers: headers,
    body: JSON.stringify(obj)
  });
  if (!r.ok) throw new Error('PUT ' + r.status);
  return true;
}

/* Список .json-файлов каталога через autoindex nginx (HTML-листинг) */
async function apiList(dir) {
  const r = await fetch(apiUrl(dir) + '/', { cache: 'no-store' });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error('LIST ' + r.status);
  const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
  const out = [];
  doc.querySelectorAll('a[href]').forEach(function (a) {
    const h = decodeURIComponent(a.getAttribute('href'));
    if (h.endsWith('/')) return;               // подкаталоги не нужны
    const name = h.split('/').pop();
    if (name.toLowerCase().endsWith('.json')) out.push(name);
  });
  return out;
}

/* ---------------- серверное время (по заголовку Date) ----------------
   Точная синхронизация часов не требуется: смещение определяется по
   заголовку Date ответа nginx и используется только чтобы студенты,
   зашедшие в середине раунда, видели оставшееся время. */

let _clockOffset = 0;
async function syncClock() {
  try {
    const r = await fetch(apiUrl('../probe' + Math.random().toString(36).slice(2)), { cache: 'no-store' });
    const d = r.headers.get('Date');
    if (d) _clockOffset = new Date(d).getTime() - Date.now();
  } catch (e) { /* нет связи — используем локальные часы */ }
}
function serverNow() { return Date.now() + _clockOffset; }

/* ---------------- вспомогательное ---------------- */

function normText(s) {
  return String(s == null ? '' : s).trim().toLowerCase()
    .replace(/\s+/g, ' ').replace(/ё/g, 'е');
}

const _TR = { 'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'c','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya' };

/* латинский id из имени (для имён файлов) + случайный суффикс */
function safeId(name) {
  const base = String(name || '').toLowerCase().split('')
    .map(function (ch) { return Object.prototype.hasOwnProperty.call(_TR, ch) ? _TR[ch] : ch; })
    .filter(function (ch) { return /[a-z0-9]/.test(ch); })
    .join('').slice(0, 14);
  return (base || 'student') + '-' + Math.random().toString(36).slice(2, 6);
}

function safeRoom(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function randomRoom() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

function fmtTime(sec) {
  sec = Math.round(+sec || 0);
  if (sec < 60) return sec + ' с';
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ' мин ' + (s ? s + ' с' : '');
}

/* Деление на 3 группы: 50% / 30% / 20% (метод наибольших остатков,
   чтобы при маленьком числе студентов квоты распределялись корректно).
   Возвращает [кол-во «отлично», «хорошо», «удовлетворительно»]. */
function splitGroups(n) {
  const quota = [n * 0.5, n * 0.3, n * 0.2];
  const cnt = quota.map(Math.floor);
  let rest = n - cnt.reduce(function (a, b) { return a + b; }, 0);
  quota
    .map(function (v, i) { return { i: i, f: v - Math.floor(v) }; })
    .sort(function (a, b) { return b.f - a.f; })
    .forEach(function (o) { if (rest > 0) { cnt[o.i]++; rest--; } });
  return cnt;
}
