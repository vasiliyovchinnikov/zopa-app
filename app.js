'use strict';

/* ZOPA — подготовка к переговорам.
   Канон: Raiffa (1982), Fisher & Ury, Harvard PON, Lax–Sebenius 3-D,
   Voss (Ackerman, One Sheet), Medvec & Galinsky (MESO), Galinsky & Mussweiler (якорение). */

const $id = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Math.round(Number(n)).toLocaleString('ru-RU');

const DEAL_KEY = 'zopa_deal_v1';
let SCEN = [];
let st = null;       // состояние визарда
let session = null;  // состояние тренажёра

/* ---------------- хранилище сделки ---------------- */
function loadDeal() {
  try { return JSON.parse(localStorage.getItem(DEAL_KEY) || 'null'); } catch (e) { return null; }
}
function saveDeal(d) {
  try { localStorage.setItem(DEAL_KEY, JSON.stringify(d)); } catch (e) {}
}

function zoneCalc(d) {
  const sell = d.role === 'sell';
  const r = Number(d.main.reserve), t = Number(d.main.target), o = Number(d.opp.limit);
  const lo = Math.min(r, o), hi = Math.max(r, o);
  const exists = sell ? o >= r : o <= r;
  return { sell, r, t, o, lo, hi, width: hi - lo, exists };
}

/* ---------------- сценарии тренажёра ---------------- */
const SCEN_FALLBACK = [
  { id: 'procurement', title: 'Скупой закупщик',
    desc: 'Корпоративный закупщик: жёсткий бюджет, сравнивает с конкурентами, уйти ему легко.',
    tone: 'холодно, формально, давит на цену', stepPct: 0.45, patience: 4 },
  { id: 'cfo', title: 'CFO с жёстким бюджетом',
    desc: 'Финансовый директор: только цифры, ROI и бюджетный цикл. Позиция сильная, времени мало.',
    tone: 'по делу, с цифрами, торопит', stepPct: 0.3, patience: 3 }
];
async function loadScenarios() {
  try {
    const r = await fetch('scenarios.json?v=1');
    const j = await r.json();
    const list = (j.profiles || []).filter((p) => p && p.id && p.title);
    if (list.length) SCEN = list;
  } catch (e) { /* fallback ниже */ }
  if (!SCEN.length) SCEN = SCEN_FALLBACK;
}

/* ---------------- реплики бота ---------------- */
const TONE_PROC = {
  hold: ['Это выше того, что я могу согласовать. Реально — {N}.', 'У меня другие цифры. {N}.', 'Конкуренты дешевле. {N} — и я подумаю.'],
  concede: ['Хорошо. {N}. Но дальше — только решение сверху.', 'Ладно. {N} — и не просите больше.', '{N}. Это максимум, что дотягиваю сам.'],
  accept: ['По {N} согласен. Зафиксируем.', '{N}. Хорошо, берём.'],
  ultimatum: ['Финал: {N}. Да или нет?', 'Последняя цифра — {N}. Либо да, либо закрываем тему.'],
  nudge: ['Цену назовите. Без цифры говорить не о чем.', 'Мне нужна цифра, а не рассказ.'],
  away: ['Вы цену не в ту сторону двигаете? Серьёзно? Остаёмся на {N}.']
};
const TONE_CFO = {
  hold: ['Не проходит по экономике. Реально — {N}.', 'ROI не сходится. {N} — потолок.', 'У меня лимит согласований. {N} — максимум, который подпишу.'],
  concede: ['Хм. {N} — при условии фиксации объёма и сроков.', 'Ладно. {N}. Вношу в бюджет как крайнюю точку.', 'Редко так двигаюсь. {N}.'],
  accept: ['Принято. {N}. Готовьте договор.', 'Ок. {N}. Отправляйте на подпись.'],
  ultimatum: ['До конца недели: {N}, потом бюджет уходит другому проекту.', '{N} — финал. Решайте.'],
  nudge: ['Числа. Мне нужны числа.', 'Эмоции потом. Цифра какая?'],
  away: ['Это шаг назад. Остаёмся на {N}.']
};
function tone(s, kind, n, i) {
  const bank = (s.id === 'cfo' ? TONE_CFO : TONE_PROC)[kind];
  const line = bank[i == null ? Math.min(session.round, bank.length - 1) : i];
  return line.replace('{N}', fmt(n));
}

/* ---------------- утилиты парсинга ---------------- */
function parseNum(text) {
  let t = String(text).toLowerCase().replace(/,/g, '.').replace(/\s/g, '');
  t = t.replace(/тыс(яч)?\.?/g, 'k').replace(/млн/g, 'm');
  const m = t.match(/(\d+(?:\.\d+)?)([мmk])/);
  if (m) { let v = parseFloat(m[1]); v *= m[2] === 'k' ? 1e3 : 1e6; return Math.round(v); }
  // Голое число из 2–4 цифр в переговорах о деньгах — почти всегда тысячи
  // («ладно, 780» = 780 000). 5+ знаков — абсолютные рубли, как есть.
  const b = t.match(/(\d{1,}(?:\.\d+)?)/);
  if (b) {
    const v = parseFloat(b[1]);
    const contextWord = /(%|процент|штук|дней|дня|недел|месяц|этап|рублей за лицензию)/.test(t);
    if (v >= 10 && v < 10000 && !/(^|[^\d.])\d{5}/.test(t) && !contextWord) return Math.round(v * 1000);
    return Math.round(v);
  }
  return null;
}
const isYes = (t) => /^(да|согласен|согласна|принимаю|принимаю|ок|окей|беру|хорошо|ладно|год)/i.test(String(t).trim().toLowerCase());

/* ================= НАВИГАЦИЯ ================= */
const VIEWS = { brief: viewBrief, build: viewBuild, drill: viewDrill, cheat: viewCheat };

function nav(name) {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
  const app = $id('app');
  const wrap = document.createElement('div');
  wrap.innerHTML = VIEWS[name]();
  app.replaceChildren(wrap);
  window.scrollTo(0, 0);
  if (name === 'build') initBuild();
  if (name === 'drill') initDrill();
  if (name === 'brief') { const c = $id('cta-build'); if (c) c.onclick = () => nav('build'); }
}

/* ================= ЭКРАН 1: СУТЬ ================= */
function viewBrief() {
  return `
  <div class="card">
    <span class="badge">Суть за две минуты</span>
    <h2>ZOPA — зона возможного соглашения</h2>
    <p><strong>ZOPA (Zone of Possible Agreement)</strong> — диапазон условий, приемлемых <strong>и для вас, и для них</strong>. Продавец готов отдать не дешевле 600, покупатель купить не дороже 750 → зона 600–750. Нет пересечения — сделки нет, пока кто-то не изменит позицию или состав предметов торга.</p>
    <p>Цепочка, на которой всё держится:</p>
    <ul class="clean">
      <li><strong>BATNA</strong> — что вы сделаете, если сделки не будет. Ваш рычаг.</li>
      <li><strong>Резерв</strong> — точка выхода, худшее приемлемое. Логично вытекает из BATNA.</li>
      <li><strong>Цель</strong> — амбициозный, но реальный финал.</li>
      <li><strong>ZOPA</strong> — пересечение вашего резерва и их лимита.</li>
    </ul>
    <p>Асимметрия, на которой держится вся игра: <strong>свой резерв вы знаете, их — только оцениваете</strong>. Не выдать свой, нащупать чужой, не принять хуже BATNA — три правила переговорщика.</p>
  </div>

  <div class="card">
    <h3>Что здесь есть</h3>
    <ul class="clean">
      <li><strong>«Собрать»</strong> — конструктор подготовки: зона, первый оффер, лестница уступок, три равноценных пакета (MESO) и one-sheet для стола.</li>
      <li><strong>«Тренажёр»</strong> — переговоры против бота со скрытым резервом. Нащупайте его зону, не выдав свою. В конце — разбор.</li>
      <li><strong>«Шпаргалка»</strong> — механики с доказательной базой: якорение, Ackerman, MESO, расширение отрицательной зоны.</li>
    </ul>
    <p class="fine" style="margin-top:10px">Методология — открытый канон переговорного анализа: Raiffa «The Art and Science of Negotiation» (1982), Fisher &amp; Ury «Getting to Yes», Harvard Program on Negotiation, Lax–Sebenius «3-D Negotiation», Voss «Never Split the Difference».</p>
  </div>

  <div class="grid2">
    <div class="card">
      <h3>Три правила до стола</h3>
      <ul class="clean">
        <li>Усильте BATNA — это единственная настоящая сила.</li>
        <li>Первое число сильно предсказывает финал (Galinsky &amp; Mussweiler, 2001). Готовьте якорь заранее.</li>
        <li>Никогда не принимайте хуже своего резерва. Никогда.</li>
      </ul>
    </div>
    <div class="card">
      <h3>Три правила за столом</h3>
      <ul class="clean">
        <li>Не торгуйтесь против себя: уступка — только в обмен на их движение.</li>
        <li>Уступки уменьшающимися шагами — сигнал, что зона сужается.</li>
        <li>Зоны нет? Меняйте состав: сроки, объём, гарантии, условия. Не ломайте цену.</li>
      </ul>
    </div>
  </div>

  <div style="text-align:center;margin:26px 0">
    <button class="btn" id="cta-build">Собрать мою подготовку →</button>
  </div>`;
}

/* ================= ЭКРАН 2: СОБРАТЬ ================= */
function blankState() {
  return {
    step: 1, title: '', role: '',
    main: { name: 'Сумма сделки, ₽', reserve: '', target: '' },
    opp: { name: '', limit: '' },
    extras: [ { name: '', note: '' }, { name: '', note: '' }, { name: '', note: '' } ]
  };
}
function stFromDeal(d) {
  if (!d) return null;
  const s = blankState();
  s.title = d.title || ''; s.role = d.role || '';
  s.main = { name: (d.main && d.main.name) || 'Сумма сделки, ₽', reserve: d.main ? d.main.reserve : '', target: d.main ? d.main.target : '' };
  s.opp = { name: (d.opp && d.opp.name) || '', limit: d.opp ? d.opp.limit : '' };
  if (d.extras) s.extras = d.extras.slice(0, 3).concat(Array(3).fill({name:'',note:''})).slice(0,3).map((e) => ({ name: e.name || '', note: e.note || '' }));
  s.step = 5;
  return s;
}
function dealFromSt() {
  return {
    title: st.title, role: st.role, main: { ...st.main }, opp: { ...st.opp },
    extras: st.extras.map((e) => ({ ...e })), demo: false, saved: Date.now()
  };
}

function viewBuild() {
  st = st || stFromDeal(loadDeal()) || blankState();
  return `<div id="wiz"></div>`;
}
function initBuild() { renderWiz(); }

function renderWiz() {
  const w = $id('wiz');
  const S = st.step;
  let html = `<div class="card"><span class="badge">Шаг ${S} из 5</span>`;

  if (S === 1) {
    html += `<h2>Ваша роль в переговорах</h2>
    <p>От этого зависит, с какой стороны считать зону.</p>
    <div class="field"><label><input type="radio" name="role" value="sell" ${st.role === 'sell' ? 'checked' : ''}> <strong>Отдаю ценность</strong> — продаю товар/услугу или торгуюсь за зарплату. Моя цифра — минимум, хочу больше.</label></div>
    <div class="field"><label><input type="radio" name="role" value="buy" ${st.role === 'buy' ? 'checked' : ''}> <strong>Получаю ценность</strong> — покупаю, нанимаю, закупаю. Моя цифра — потолок, хочу дешевле.</label></div>
    <div class="field"><label>О чём переговоры (необязательно)</label>
      <input type="text" id="w-title" placeholder="Например: внедрение аналитики для ритейлера" value="${esc(st.title)}"></div>
    <button class="btn" id="w-next" ${st.role ? '' : 'disabled'}>Далее →</button>`;
  }

  if (S === 2) {
    html += `<h2>Ваша сторона</h2>
    <div class="field"><label>Что обсуждаете</label><input type="text" id="w-mname" value="${esc(st.main.name)}"></div>
    <div class="field"><label>${st.role === 'sell' ? 'Ваш минимум (резерв) — ниже нет сделки' : 'Ваш потолок (резерв) — выше нет сделки'}</label>
      <input type="number" id="w-reserve" placeholder="${st.role === 'sell' ? '600000' : '750000'}" value="${esc(st.main.reserve)}">
      <div class="sub">Точка выхода. Всё, что хуже, — хуже вашей BATNA.</div></div>
    <div class="field"><label>Ваша цель (реалистично-амбициозная)</label>
      <input type="number" id="w-target" placeholder="${st.role === 'sell' ? '850000' : '620000'}" value="${esc(st.main.target)}"></div>
    <button class="btn ghost" id="w-back">← Назад</button> <button class="btn" id="w-next" ${st.main.reserve && st.main.target ? '' : 'disabled'}>Далее →</button>`;
  }

  if (S === 3) {
    html += `<h2>Оценка контрагента</h2>
    <div class="field"><label>Кто оппонент (необязательно)</label><input type="text" id="w-opp-name" placeholder="Закупщик сети «Х», Алексей" value="${esc(st.opp.name)}"></div>
    <div class="field"><label>${st.role === 'sell' ? 'Их максимум: сколько они способны заплатить (ваша оценка)' : 'Их минимум: ниже какой цены они точно не отдадут (ваша оценка)'}</label>
      <input type="number" id="w-opp-limit" placeholder="${st.role === 'sell' ? '750000' : '550000'}" value="${esc(st.opp.limit)}">
      <div class="sub">Оценка из рынка, их бюджета, публичных данных. Ошибка здесь — источник ошибок всей карты.</div></div>
    <button class="btn ghost" id="w-back">← Назад</button> <button class="btn" id="w-next" ${st.opp.limit ? '' : 'disabled'}>Далее →</button>`;
  }

  if (S === 4) {
    html += `<h2>Дополнительные переменные</h2>
    <p>Кроме суммы. Из них собираются обмены (логроллинг) и пакеты MESO. Можно пропустить.</p>`;
    st.extras.forEach((e, i) => {
      html += `<div class="issue-row">
        <input type="text" data-ex="${i}" data-k="name" placeholder="Переменная ${i + 1}: сроки" value="${esc(e.name)}">
        <input type="text" data-ex="${i}" data-k="note" placeholder="Ваш ход: предоплата, сжатые сроки" value="${esc(e.note)}">
      </div>`;
    });
    html += `<button class="btn ghost" id="w-back">← Назад</button> <button class="btn" id="w-next">Далее →</button>`;
  }

  if (S === 5) html += buildResult();
  html += `</div>`;
  w.innerHTML = html;
  wireWiz(S);
}

function wireWiz(S) {
  const w = $id('wiz');
  if (S === 1) {
    w.querySelectorAll('input[name=role]').forEach((r) => { r.onchange = () => { st.role = r.value; $id('w-next').disabled = false; }; });
    $id('w-title').oninput = (e) => { st.title = e.target.value; };
    $id('w-next').onclick = () => { st.step = 2; renderWiz(); };
  }
  if (S === 2) {
    $id('w-mname').oninput = (e) => { st.main.name = e.target.value; };
    const upd = () => { $id('w-next').disabled = !($id('w-reserve').value && $id('w-target').value); };
    $id('w-reserve').oninput = (e) => { st.main.reserve = e.target.value; upd(); };
    $id('w-target').oninput = (e) => { st.main.target = e.target.value; upd(); };
    upd();
    $id('w-back').onclick = () => { st.step = 1; renderWiz(); };
    $id('w-next').onclick = () => {
      st.main.name = $id('w-mname').value || 'Сумма сделки, ₽';
      st.main.reserve = $id('w-reserve').value;
      st.main.target = $id('w-target').value;
      const r = Number(st.main.reserve), t = Number(st.main.target);
      const ok = r > 0 && t > 0 && (st.role === 'sell' ? t > r : t < r);
      if (ok) { st.step = 3; renderWiz(); }
      else alert(st.role === 'sell' ? 'Цель должна быть ВЫШЕ резерва (вы продаёте)' : 'Цель должна быть НИЖЕ резерва (вы покупаете)');
    };
  }
  if (S === 3) {
    $id('w-opp-name').oninput = (e) => { st.opp.name = e.target.value; };
    const upd3 = () => { $id('w-next').disabled = !$id('w-opp-limit').value; };
    $id('w-opp-limit').oninput = (e) => { st.opp.limit = e.target.value; upd3(); };
    upd3();
    $id('w-back').onclick = () => { st.step = 2; renderWiz(); };
    $id('w-next').onclick = () => { st.opp.limit = $id('w-opp-limit').value; st.opp.name = $id('w-opp-name').value; st.step = 4; renderWiz(); };
  }
  if (S === 4) {
    w.querySelectorAll('[data-ex]').forEach((inp) => {
      inp.oninput = () => { st.extras[Number(inp.dataset.ex)][inp.dataset.k] = inp.value; };
    });
    $id('w-back').onclick = () => { st.step = 3; renderWiz(); };
    $id('w-next').onclick = () => { st.step = 5; renderWiz(); };
  }
  if (S === 5) {
    $id('w-copy').onclick = () => copyText(buildOneSheetText());
    $id('w-drill').onclick = () => { saveDeal(dealFromSt()); nav('drill'); };
  }
}

function anchorCalc(z) {
  if (z.exists) {
    return z.sell
      ? Math.ceil((z.hi + 0.35 * Math.max(z.hi * 0.12, (z.t - z.r) * 0.5)) / 1000) * 1000 - 7
      : Math.floor((z.lo - 0.35 * Math.max(z.r * 0.12, (z.r - z.t))) / 1000) * 1000 + 3;
  }
  return z.sell ? Math.ceil(z.t * 1.18 / 1000) * 1000 - 7 : Math.floor(z.t * 0.82 / 1000) * 1000 + 3;
}

function buildResult() {
  const z = zoneCalc(st);
  let html = '';

  if (z.exists && z.width > 0) {
    const pRes = Math.min(Math.max((z.r - z.lo) / z.width, 0), 1) * 100;
    const pOpp = Math.min(Math.max((z.o - z.lo) / z.width, 0), 1) * 100;
    const pT = Math.min(Math.max((z.t - z.lo) / z.width, 0), 1) * 100;
    html += `<h2>✅ Зона возможного соглашения</h2>
    <div class="zone-viz">
      <div class="zbar" style="height:46px">
        <div class="zfill" style="left:0;width:100%"></div>
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:space-between;padding:0 14px;font-weight:800;font-size:15px">
          <span>${fmt(z.lo)}</span><span style="color:#9fb2cc;font-size:12px;font-weight:700">зона · ширина ${fmt(z.width)}</span><span>${fmt(z.hi)}</span>
        </div>
      </div>
      <div class="zbar" style="background:transparent;border:none;height:22px;position:relative;margin-top:2px">
        <div style="position:absolute;left:0;top:6px;right:0;height:2px;background:linear-gradient(90deg,var(--warn),var(--acc2))"></div>
        <div style="position:absolute;left:0%;top:0;bottom:0;width:3px;background:var(--warn)"></div>
        <div style="position:absolute;left:${pRes}%;top:0;bottom:0;width:3px;background:var(--warn)"></div>
        <div style="position:absolute;left:${pOpp}%;top:0;bottom:0;width:3px;background:var(--acc2)"></div>
        <div style="position:absolute;left:${pT}%;top:-6px;bottom:-6px;width:3px;background:var(--ok)"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-top:2px">
        <span style="color:var(--warn)">▲ ваш резерв ${fmt(z.r)}</span>
        <span style="color:var(--ok)">▲ ваша цель ${fmt(z.t)}</span>
        <span style="color:var(--acc2)">▲ оценка их лимита ${fmt(z.o)}</span>
      </div>
    </div>
    <p style="margin-top:12px">Любая сделка в диапазоне <strong>${fmt(z.lo)} — ${fmt(z.hi)}</strong> лучше для обеих сторон, чем уход со стола. Закрыв на цель (${fmt(z.t)}), вы забираете <strong>${z.sell ? fmt(z.t - z.r) + ' сверх минимума' : fmt(z.hi - z.t) + ' экономии от потолка'}</strong>. Оценка чужого лимита — гипотеза: проверяйте вопросами, не выдавая свой резерв.</p>`;
  } else {
    html += `<h2>⛔ Отрицательная зона (negative ZOPA)</h2>
    <p>Пересечения нет: ${z.sell ? `ваш минимум ${fmt(z.r)} выше их максимума ${fmt(z.o)}` : `ваш потолок ${fmt(z.r)} ниже их минимума ${fmt(z.o)}`}. В текущей конфигурации сделки не будет.</p>
    <div class="card" style="background:rgba(248,113,113,.06);border-color:rgba(248,113,113,.3)">
      <h3>Что расширяет зону (по канону)</h3>
      <ul class="clean">
        <li><strong>Добавить переменные</strong> — сроки, объём, предоплата, гарантии, эксклюзив. Зона часто есть по пакету, хотя её нет по цене.</li>
        <li><strong>Логроллинг</strong> — уступите по дешёвому для вас, получите по дорогому для них.</li>
        <li><strong>Контракт с условием</strong> (contingent contract) — «если объём вырастет, цена пересматривается».</li>
        <li><strong>Усилить BATNA</strong> — вторая альтернатива сдвигает ваш резерв.</li>
        <li><strong>Перепроверить оценку</strong> — их лимит это ваша гипотеза: ищите их KPI, бюджетный цикл, замену вам.</li>
      </ul>
    </div>`;
  }

  // Стратегия входа
  const A = anchorCalc(z);
  const gap = z.t - A;
  const L1 = A + gap * 0.571, L2 = A + gap * 0.857;
  const dir = z.sell ? 1 : -1;
  html += `<h3>Вход и уступки</h3>
  <ul class="clean">
    <li><strong>Первый оффер (якорь): ${fmt(A)}</strong>. Агрессивно, но не абсурдно — и всегда с обоснованием (состав, рынок, сроки). Первое число сильно тянет финал за собой (Galinsky &amp; Mussweiler, 2001).</li>
    <li><strong>Лестница уступок (Ackerman):</strong> ${fmt(A)} → ${fmt(L1)} → ${fmt(L2)} → <strong>${fmt(z.t)}</strong> — шаги уменьшаются (это сигнал: «зона кончается»). Только в обмен на их движение. Финальная цифра — некруглая и точная.</li>
    <li><strong>Между уступками — вопросы</strong>, а не встречные предложения: «Как это работает для вашей стороны?», «Что произойдёт, если не сойдёмся?»</li>
  </ul>`;

  // MESO
  const ex = st.extras.filter((e) => e.name && e.name.trim());
  const span = Math.abs(z.t - z.r);
  const packs = z.sell
    ? [z.t, Math.round(z.r + 0.65 * (z.t - z.r)), Math.round(z.r + 0.3 * (z.t - z.r))]
    : [z.t, Math.round(z.r - 0.7 * (z.r - z.t)), Math.round(z.r - 0.3 * (z.r - z.t))];
  const exA = ex[0] ? ex[0].name.toLowerCase() : 'сжатые сроки';
  const exB = ex[1] ? ex[1].name.toLowerCase() : 'предоплата 30%';
  const exC = ex[2] ? ex[2].name.toLowerCase() : 'больший объём';
  html += `<h3>Три равноценных пакета (MESO)</h3>
  <p>Предложите одновременно — вы выглядите гибким, а их выбор покажет приоритеты (Medvec &amp; Galinsky). Проверьте на глаз: пакеты должны быть примерно равны для вас.</p>
  <ul class="clean">
    <li><strong>Пакет А:</strong> ${fmt(packs[0])} — условия как есть.</li>
    <li><strong>Пакет Б:</strong> ${fmt(packs[1])} ${z.sell ? '−' : '+'} взамен: ${esc(exA)} (${esc(ex[0] && ex[0].note ? ex[0].note : 'ваша выгода')}).</li>
    <li><strong>Пакет В:</strong> ${fmt(packs[2])} ${z.sell ? '−' : '+'} взамен: ${esc(exBAndC(ex, exB, exC))}</li>
  </ul>`;

  html += `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
    <button class="btn" id="w-copy">Скопировать one-sheet</button>
    <button class="btn ghost" id="w-drill">Проверить в тренажёре →</button>
  </div>
  <p class="fine" style="margin-top:8px">Подготовка автоматически сохраняется в этом браузере — тренажёр её подхватит.</p>`;
  return html;
}
function exBAndC(ex, exB, exC) {
  const parts = [];
  if (ex[1] && ex[1].name) parts.push(ex[1].name.toLowerCase() + (ex[1].note ? ` (${ex[1].note})` : ''));
  else parts.push(exB);
  if (ex[2] && ex[2].name) parts.push(ex[2].name.toLowerCase());
  else parts.push(exC);
  return parts.join(' + ');
}

function buildOneSheetText() {
  const z = zoneCalc(st);
  const A = anchorCalc(z);
  const gap = z.t - A;
  const L = [];
  L.push('ONE SHEET — ' + (st.title || 'переговоры'));
  L.push('Роль: ' + (z.sell ? 'отдаю ценность (продажа / кандидат)' : 'получаю ценность (покупка / работодатель)'));
  if (st.opp.name) L.push('Контрагент: ' + st.opp.name);
  L.push('');
  L.push('МОЯ ПОЗИЦИЯ (не раскрывать!)');
  L.push('Резерв: ' + fmt(st.main.reserve));
  L.push('Цель: ' + fmt(st.main.target));
  L.push('Оценка их лимита: ' + fmt(st.opp.limit));
  L.push('');
  L.push(z.exists ? 'ZOPA: ' + fmt(z.lo) + ' — ' + fmt(z.hi) + ' (ширина ' + fmt(z.width) + ')' : 'ZOPA ОТРИЦАТЕЛЬНАЯ → менять состав переменных, не цену');
  L.push('');
  if (z.exists) {
    L.push('Якорь (первый оффер): ' + fmt(A) + ' — с обоснованием.');
    L.push('Лестница: ' + fmt(A + gap * 0.571) + ' → ' + fmt(A + gap * 0.857) + ' → ' + fmt(z.t) + ' (шаги уменьшаются, финал некруглый).');
    const ex = st.extras.filter((e) => e.name);
    L.push('MESO: 3 пакета одновременно. Переменные: ' + (ex.map((e) => e.name).join(', ') || 'сроки / предоплата / объём') + '.');
  } else {
    L.push('Зоны нет по цене — работать пакетом: переменные: ' + st.extras.filter((e) => e.name).map((e) => e.name).join(', ') + '.');
  }
  L.push('');
  L.push('Вопросы за столом:');
  L.push('— Что для них важно, кроме цены?');
  L.push('— Что произойдёт у них, если сделки не будет?');
  L.push('— Кто ещё должен быть в комнате?');
  L.push('СТОП-ЛИНИЯ: не принимать хуже резерва. Точка.');
  return L.join('\n');
}
function copyText(t) {
  const done = () => toast('Скопировано в буфер');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(done, () => fallbackCopy(t, done));
  } else fallbackCopy(t, done);
}
function fallbackCopy(t, cb) {
  const ta = document.createElement('textarea');
  ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta); toast('Скопировано');
}
function toast(txt) {
  const d = document.createElement('div');
  d.className = 'toast'; d.textContent = txt;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 2200);
}

/* ================= ЭКРАН 3: ТРЕНАЖЁР ================= */
function demoDeal() {
  return {
    demo: true, title: 'Демо: внедрение аналитики для ритейлера', role: 'sell',
    main: { name: 'Сумма контракта, ₽', reserve: '600000', target: '850000' },
    opp: { name: 'Закупщик сети', limit: '750000' },
    extras: [
      { name: 'Сроки старта', note: 'старт через 2 недели' },
      { name: 'Предоплата', note: '30% для найма команды' },
      { name: 'Объём работ', note: 'этап 2 — отдельным контрактом' }
    ]
  };
}

function viewDrill() { return `<div id="drill-root"></div>`; }

function initDrill() {
  const root = $id('drill-root');
  const d = loadDeal();
  if (!d) {
    root.innerHTML = `<div class="card">
      <h2>Сначала — подготовка</h2>
      <p>Тренажёр играет от вашей подготовки: берёт ваш резерв, цель и оценку лимита из раздела «Собрать». Без неё игра нечестная.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn" id="d-demo">Играть на демо-сделке</button>
        <button class="btn ghost" id="d-build">Заполнить свою →</button>
      </div></div>`;
    $id('d-demo').onclick = () => { saveDeal(demoDeal()); initDrill(); };
    $id('d-build').onclick = () => nav('build');
    return;
  }
  let html = `<div class="card"><span class="badge">Тренажёр</span>
    <h2>${d.demo ? 'Демо-сделка: ' : ''}${esc(d.title || 'переговоры')}</h2>
    <p>Вы — ${d.role === 'sell' ? 'продающая сторона' : 'покупающая сторона'}. Резерв: ${fmt(d.main.reserve)}, цель: ${fmt(d.main.target)}.</p>
    <h3 style="margin-top:14px">Выберите контрагента</h3>`;
  SCEN.forEach((s, i) => {
    html += `<div class="card" style="margin:10px 0;cursor:pointer;border-color:var(--line)" data-scen="${i}">
      <h3 style="margin:0 0 6px">${esc(s.title)}</h3><p style="margin:0">${esc(s.desc)}</p>
      <p class="fine" style="margin:8px 0 0">Манера: ${esc(s.tone || 'деловая')}</p></div>`;
  });
  html += `<p class="fine">Лимит контрагента скрыт и в каждой партии свой. Задача: нащупать его зону и не отдать свою.</p></div>
  ${aiSettingsHtml()}
  <div id="drill-live"></div>`;
  root.innerHTML = html;
  wireAiSettings();
  root.querySelectorAll('[data-scen]').forEach((el) => {
    el.onclick = () => startSession(SCEN[Number(el.dataset.scen)], d);
  });
}

function startSession(scen, d) {
  const z = zoneCalc(d);
  const rnd = (a, b) => a + Math.random() * (b - a);
  let floor, offer;
  if (z.sell) {
    floor = Math.round(Number(d.opp.limit) * rnd(0.9, 1.1));
    offer = Math.round((floor * rnd(0.58, 0.72)) / 1000) * 1000;
  } else {
    floor = Math.round(Number(d.opp.limit) * rnd(0.9, 1.1));
    offer = Math.round((floor * rnd(1.28, 1.48)) / 1000) * 1000;
  }
  session = { z, scen, deal: d, floor, offer, round: 0, nudges: 0, mine: [], msg: [], over: false, ultimatum: false, closed: null, acceptedUltimatum: false, ai: !!getAiKey() };
  renderSession();
  const opening = 'Слушайте, давайте к делу. Что у вас по деньгам? Только честно — у меня ещё три поставщика в работе.';
  const openingBuy = 'Вы нам в целом подходите. Но бюджет в этом году урезали. Начните с вашей лучшей цены — и без долгих прелюдий.';
  if (session.ai) {
    aiSpeak(session, { system: aiOpeningPrompt(session) }, z.sell ? opening : openingBuy);
  } else {
    pushThem(z.sell ? opening : openingBuy);
    pushSys('Раунд 1. Лимит контрагента скрыт. Ваш ход — назовите цифру (или условия) или завершите и получите разбор.');
  }
}

function renderSession() {
  const box = $id('drill-live');
  if (!box) return;
  if (!$id('chat')) {
    box.innerHTML = `<div class="card">
      <div id="chat" aria-live="polite"></div>
      <div class="chat-input" style="margin-top:12px">
        <input type="text" id="chat-in" placeholder="Ваш ход: цифра или условия…" autocomplete="off">
        <button class="btn" id="chat-send">Отправить</button>
      </div>
      <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn ghost" id="d-end">Завершить и разобрать</button>
      </div>
    </div>`;
    $id('chat-send').onclick = onUser;
    $id('chat-in').onkeydown = (e) => { if (e.key === 'Enter') onUser(); };
    $id('d-end').onclick = () => endSession('Разбор по вашему запросу.');
  }
  const chat = $id('chat');
  if (chat._r !== session.msg.length) {
    chat._r = session.msg.length;
    chat.replaceChildren(...session.msg.map((m) => {
      const div = document.createElement('div');
      div.className = 'msg ' + m.who;
      div.textContent = m.text;
      return div;
    }));
    chat.scrollTop = chat.scrollHeight;
  }
}
function pushWho(who, text) { session.msg.push({ who, text }); renderSession(); }
function pushThem(t) { pushWho('them', t); }
function pushSys(t) { pushWho('sys', t); }

function onUser() {
  const inp = $id('chat-in');
  const text = (inp.value || '').trim();
  if (!text || !session || session.over) return;
  inp.value = '';
  pushWho('me', text);
  let num = parseNum(text);
  // «640», «ладно, 500» в контексте торга о крупной сделке — тысячи, а не рубли.
  // Если цифра крошечная относительно текущих ставок в партии — умножаем на 1000.
  if (num != null && num > 0 && num < 10000) {
    const rates = [session.offer, ...session.mine.map(x => parseNum(x))].filter(x => x != null && x >= 10000);
    const ref = rates.length ? Math.max(...rates) : null;
    if (ref && num * 1000 >= ref * 0.03) num = num * 1000;
  }
  session.mine.push(text);

  if (session.ultimatum) {
    const z = session.z;
    if (isYes(text)) { session.closed = session.offer; session.acceptedUltimatum = true; endSession(); return; }
    else if (num != null) {
      const okForThem = z.sell ? num <= session.floor : num >= session.floor;
      if (okForThem) { session.closed = num; endSession(); return; }
      session.ultRefusals = (session.ultRefusals || 0) + 1;
      if (session.ultRefusals >= 3) { endSession(`Разошлись: их финал — ${fmt(session.offer)}, ваша последняя цифра — ${fmt(num)}.`); return; }
      aiSpeak(session, { system: `Сводка для твоей реплики: собеседник снова не принял твой оффер ${fmt(session.offer)}. Повтори его жёстче, без новых цифр.` }, 'Цифры мы уже назвали. Наша — ' + fmt(session.offer) + '. Или берёте, или расходимся.');
      aiCoach(session, text, 'пользователь отказался от их финального оффера, сузил до ' + fmt(num));
      return;
    }
    else { aiSpeak(session, { system: 'Пользователь уклончив, цифры нет. Потребуйте цифру прямо.' }, 'Да или нет. Называйте цифру, если не согласны.'); return; }
  }
  if (num == null) {
    session.nudges++;
    if (session.nudges >= 3) { endSession('Цена так и не прозвучала — разговор сошёл на нет.'); return; }
    aiSpeak(session, { system: 'Сводка для твоей реплики: собеседник уходит от цены, говорит «' + text.slice(0, 120) + '». Требуй цифру прямо, дави по характеру.' }, tone(session.scen, 'nudge', session.offer));
    aiCoach(session, text, 'ход без цифры (уклончивый)');
    return;
  }
  resolveNum(num, text);
}

async function resolveNum(num, userText) {
  const z = session.z, d = session.deal;
  const r = Number(d.main.reserve);
  const userText2 = userText || String(num);
  // Проверка на движение против себя
  const nums = session.mine.map(parseNum).filter((x) => x != null);
  const prev = nums.length >= 2 ? nums[nums.length - 2] : null;
  const selfDefeat = prev != null && (z.sell ? num < prev : num > prev);
  if (selfDefeat) pushSys('⚠️ Вы улучшили предложение сами себе — «торг против себя». Уступайте только в обмен на их движение.');

  // Принятие: их floor достигнут?
  const okForThem = z.sell ? num <= session.floor : num >= session.floor;
  const nearFloor = Math.abs(num - session.floor) <= Math.abs(session.floor) * 0.04;
  if (okForThem && (session.round >= 1 || nearFloor)) {
    session.closed = num;
    if (session.ai) {
      aiSpeak(session, { system: `Сводка для твоей реплики: собеседник предложил ${fmt(num)} — тебя это устраивает. Соглашайся и фиксируй договорённость.` }, tone(session.scen, 'accept', num, 0));
      aiCoach(session, userText2, 'предложил ' + fmt(num) + ' — контрагент принимает');
      setTimeout(endSession, 3200);
    } else {
      pushThem(tone(session.scen, 'accept', num, 0));
      endSession();
    }
    return;
  }
  // Чужой лимит раундов
  session.round++;
  const remaining = Math.abs(session.floor - session.offer);
  if (remaining <= minStepVal(session.floor) * 1.6 || session.round >= session.scen.patience * 2) {
    session.ultimatum = true;
    const sysLine = 'Это их финальная цифра. Ответьте «да» — принять, или назовите свою. «Завершить» — разбор без сделки.';
    if (session.ai) {
      aiSpeak(session, { system: `Сводка для твоей реплики: это твой предел. Назови ${fmt(session.floor)} как окончательную цену и дай понять, что дальше — только прощание.` }, tone(session.scen, 'ultimatum', session.floor));
      setTimeout(() => pushSys('Это их финальная цифра. «Да» — принять, назовите свою — продолжить, «Завершить» — разбор.'), 900);
    } else {
      pushThem(tone(session.scen, 'ultimatum', session.floor));
      pushSys(sysLine);
    }
    return;
  }
  // Их уступка в сторону floor
  const step = Math.max(minStepVal(session.floor), Math.abs(session.floor - session.offer) * (session.scen.stepPct || 0.4));
  session.offer = z.sell
    ? Math.min(session.floor, session.offer + step)
    : Math.max(session.floor, session.offer - step);
  const directive = selfDefeat
    ? { system: `Сводка ситуации для твоего хода: собеседник только что предложил ${fmt(num)} — сам, без твоего движения. Ты пока не двигаешься к своей цели, отвечай с давлением и без новых цифр.`, fallbackText: tone(session.scen, 'hold', session.offer) }
    : { system: `Сводка для твоей реплики: ты называешь ${fmt(session.offer)}. Добей собеседника и потребуй встречного движения.`, fallbackText: tone(session.scen, 'concede', session.offer) };
  aiSpeak(session, directive, directive.fallbackText);
  aiCoach(session, userText2, selfDefeat ? 'торг против себя: уступка без встречного движения контрагента' : 'обычная уступка');
}

function minStepVal(floor) { return Math.max(500, Math.round(Math.abs(floor) * 0.02)); }

function endSession(reason) {
  if (!session || session.over) return;
  session.over = true;
  const z = session.z, d = session.deal;
  const P = session.closed;
  let html = '<div class="card"><span class="badge">Разбор</span>';
  if (P != null) {
    const realZone = Math.abs(session.floor - Number(d.main.reserve));
    const mine = Math.abs(P - Number(d.main.reserve));
    const share = realZone > 0 ? Math.min(999, Math.round((mine / realZone) * 100)) : 0;
    const below = z.sell ? P < Number(d.main.reserve) : P > Number(d.main.reserve);
    // Для продавца: чем выше P, тем лучше. share>100 = закрыли выше своей цели/резерва-математики
    html += `<h2>Сделка закрыта на ${fmt(P)}</h2>`;
    html += `<p>Скрытый лимит контрагента: <strong>${fmt(session.floor)}</strong> (ваша оценка была ${fmt(Number(d.opp.limit))}).</p>`;
    if (below) {
      html += `<p style="color:#f87171"><strong>Красный флаг: сделка хуже вашего резерва.</strong> Так вы продаёте себя ниже BATNA. Стоп-линия должна была сработать — в реальных переговорах это самое дорогое место.</p>`;
    } else if (share > 100) {
      html += `<p>🎰 Сделка ${z.sell ? 'выше вашей цели' : 'ниже вашей цели'} — выторговали больше, чем закладывали (${share}% расчётной зоны). Их реальный бюджет оказался шире вашей оценки.</p>`;
    } else {
      html += `<p>${share >= 70 ? '💪 Отличный захват зоны: ' : share >= 40 ? '👍 Хорошо: ' : '🤏 Скромно: '}вы забрали <strong>${share}%</strong> реальной зоны.</p>`;
    }
  } else {
    html += `<h3>Сделки нет</h3>
    <p>Реальный лимит контрагента: <strong>${fmt(session.floor)}</strong>. Ваш резерв: <strong>${fmt(Number(d.main.reserve))}</strong>. ${z.exists ? 'Зона существовала — разошлись из-за тактики: слишком медленно сходились или слишком жёстко держали цифру.' : 'Зоны реально не было — как в вашей подготовке (negative ZOPA).'}</p>`;
  }
  if (reason) html += `<p class="fine">${esc(reason)}</p>`;
  const nums = session.mine.map(parseNum).filter((x) => x != null);
  if (nums.length >= 3) {
    const steps = [];
    for (let i = 1; i < nums.length; i++) steps.push(Math.abs(nums[i] - nums[i - 1]));
    const dec = steps[0] >= steps[steps.length - 1];
    html += `<p>Дисциплина уступок: шаги ${steps.map((s) => fmt(s)).join(' / ')} — ${dec ? 'уменьшаются ✅ (сигнал «зона кончается»)' : 'растут ⚠️ (сигнал слабости — контрагент будет давить дальше)'}</p>`;
  }
  if (session.scen.tells && session.scen.tells.length) {
    html += `<h3>Манера контрагента (для будущих раундов)</h3><ul class="clean">${session.scen.tells.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
  }
  html += `<div style="margin-top:14px"><button class="btn" id="d-again">Ещё раунд</button> <button class="btn ghost" id="d-home">Сменить контрагента</button></div></div>`;
  $id('drill-root').innerHTML = html;
  $id('d-again').onclick = () => startSession(session.scen, session.deal);
  $id('d-home').onclick = () => initDrill();
  if (session.ai) aiDebriefFill(session);
}

async function aiDebriefFill(session) {
  const holder = document.createElement('div');
  holder.className = 'card';
  holder.innerHTML = '<span class="badge">ИИ-разбор</span><p class="fine"><span class="typing">● ● ●</span> коуч готовит разбор партии…</p>';
  $id('drill-root').appendChild(holder);
  // Скелет разбора строит движок (факты + правило канона), модель только оживляет.
  const z = session.z;
  const redFlag = session.closed != null && (z.sell ? session.closed < Number(session.deal.main.reserve) : session.closed > Number(session.deal.main.reserve));
  const delta = session.closed != null
    ? Math.round(100 - Math.abs(session.closed - session.floor) / Math.max(session.floor, 1) * 100)
    : 0;
  const base = session.closed != null
    ? 'Итог: ' + fmt(session.closed) + ' — ' + (redFlag ? 'СДЕЛКА ХУЖЕ ВАШЕГО РЕЗЕРВА, надо было встать и уйти' : (delta > 60 ? 'вы забрали львиную долю зоны' : 'зона поделена почти пополам')) +
      '. ' + (session.mine.length >= 2 ? 'Уступки: ' + session.mine.map(parseNum).filter(x => x != null).join(' → ') + '. ' : '') +
      'Совет: уступка только в обмен на их шаг, зону нащупывайте вопросами о бюджете.'
    : 'Сделки нет: зоны не нашлось. Совет: расширяйте пир — сроки, объём, гарантии, состав предметов торга.';
  const sys = [
    'Ты — русский коуч по переговорам (канон Raiffa / Harvard PON / Voss). Отвечай ТОЛЬКО по-русски.',
    'Оживи черновик разбора партии: сохрани факты и советы, скажи живее, 3 коротких пункта через «;», до 400 знаков.'
  ].join('\n');
  try {
    window.__gwOp = 'debrief';
    const facts = 'Итог: ' + (session.closed != null ? fmt(session.closed) : 'сделки нет') + '. Ходы пользователя: ' + ((session.mine || []).slice(0, 6).join(' | ') || 'цифр не было') + '.';
    let t = '';
    try { t = await aiChat([{ role: 'user', content: base + ' ||| Факты: ' + facts }], 768); } catch (e) {}
    if (isMostlyRussian(t)) {
      holder.innerHTML = '<span class="badge">ИИ-разбор</span><p style="color:var(--txt)">' + esc(t) + '</p>';
      return;
    }
    // фолбэк: BYO напрямую или скелет
    if (getAiKey()) {
      try {
        const fix = await aiChatDirect([
          { role: 'system', content: sys },
          { role: 'user', content: 'Черновик разбора: «' + base + '»\nФакты: ходы пользователя: ' + ((session.mine || []).slice(0, 6).join(' | ') || 'цифр не было') + '. Оживи по-русски.' }
        ], 768);
        if (isMostlyRussian(fix)) t = fix;
      } catch (e) {}
    }
    if (isMostlyRussian(t)) holder.innerHTML = '<span class="badge">ИИ-разбор</span><p style="color:var(--txt)">' + esc(t) + '</p>';
    else holder.innerHTML = '<span class="badge">ИИ-разбор</span><p style="color:var(--txt)">' + esc(base) + '</p>';
  } catch (e) {
    holder.innerHTML = '<span class="badge">ИИ-разбор</span><p style="color:var(--txt)">' + esc(base) + '</p>';
  }
}

/* ================= ЭКРАН 4: ШПАРГАЛКА ================= */
function viewCheat() {
  return `
  <div class="card">
    <span class="badge">Механики с доказательной базой</span>
    <h2>Шпаргалка переговорщика</h2>
    <p>Всё ниже — из рецензируемых исследований и канонических учебников. Коротко о том, что реально работает.</p>
  </div>

  <div class="cheat-grid">
    <div class="card">
      <h3>⚓ Якорение</h3>
      <p>Первое число в переговорах сильно предсказывает финал (Galinsky &amp; Mussweiler, 2001). Кто предложил первым — тот задал коридор.</p>
      <ul class="clean">
        <li>Первый оффер — агрессивный, но объяснимый: всегда с обоснованием.</li>
        <li>Против чужого якоря: не контр-цифрить сразу. Переспросить обоснование, обозначить свой диапазон позже.</li>
        <li>Оборотная сторона: чересчур агрессивный якорь портит отношение (Maaravi et al., 2012).</li>
      </ul>
    </div>
    <div class="card">
      <h3>🪜 Лестница Ackerman</h3>
      <p>Из Восса, «Never Split the Difference». Для покупателя: первый оффер 65% цели → 85% → 95% → 100%. Шаги тают — контрагент видит, что вы у предела.</p>
      <ul class="clean">
        <li>Между шагами — калиброванные вопросы, не встречные уступки.</li>
        <li>Финал — некруглая цифра: 37 893 вместо 38 000.</li>
        <li>Продавец зеркалит: 135% → 115% → 105% → 100%.</li>
        <li>Распознать чужую лестницу: равные мелкие шаги к «финальной» цифре (разбор Уилера).</li>
      </ul>
    </div>
    <div class="card">
      <h3>🎁 MESO — три пакета сразу</h3>
      <p>Несколько равноценных для вас офферов одновременно (Medvec &amp; Galinsky): вы выглядите гибким, их выбор показывает приоритеты.</p>
      <ul class="clean">
        <li>Пакеты мультипараметрические: цена + сроки + объём.</li>
        <li>По экспериментам: принятие 78% против 59% у одиночного оффера.</li>
        <li>Делайте их в «Собрать» — генератор встроен.</li>
      </ul>
    </div>
    <div class="card">
      <h3>🧩 Отрицательная ZOPA</h3>
      <p>Зоны нет — это не конец, а смена задачи. Не давить на цену, а менять состав:</p>
      <ul class="clean">
        <li>Добавить переменные: сроки, объём, предоплата, гарантии, эксклюзив.</li>
        <li>Логроллинг: дешёвое для вас ↔ дорогое для них.</li>
        <li>Contingent contract: ставка на разногласия («если объём выше X — цена Y»).</li>
        <li>Усилить свою BATNA — сдвинется весь коридор.</li>
      </ul>
    </div>
    <div class="card">
      <h3>🃏 Не раскрывай резерв</h3>
      <p>Информационная асимметрия — сердце ZOPA. Промышленные системы (Smartsettle, Cybersettle) построены на blind bidding: алгоритм находит пересечение скрытых зон без их раскрытия.</p>
      <ul class="clean">
        <li>Свой резерв — не называть никогда, ни под каким давлением.</li>
        <li>«Лучшая цена сразу?» — разведка. Отвечайте диапазоном, не дном.</li>
        <li>Их зону добирайте вопросами: «Что случится у вас, если не сойдёмся?»</li>
      </ul>
    </div>
    <div class="card">
      <h3>📐 3-D Negotiation (Lax–Sebenius)</h3>
      <p>Три измерения большой сделки: тактики за столом, дизайн самой сделки и <strong>setup</strong> — кто, с чем и за каким столом.</p>
      <ul class="clean">
        <li>Худший прокол — виртуозно торговаться не за тем столом.</li>
        <li>Чек-лист setup: правильные стороны? правильная последовательность? правильное время?</li>
        <li>Дизайн: «движение на северо-восток» — сделка, которая лучше для обеих сторон, чем текущий вариант.</li>
      </ul>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <h3>📚 Источники</h3>
    <p class="fine">Raiffa, The Art and Science of Negotiation (1982) · Fisher &amp; Ury, Getting to Yes (1981/1991) · Harvard Program on Negotiation · Lax &amp; Sebenius, 3-D Negotiation (2006) · Voss, Never Split the Difference (2016) · Galinsky &amp; Mussweiler, JPSP (2001) · Maaravi et al., Judgment and Decision Making (2012) · Medvec &amp; Galinsky, MESO-исследования.</p>
  </div>`;
}

/* ---------------- toast ---------------- */
function toast(txt) {
  const d = document.createElement('div');
  d.className = 'toast'; d.textContent = txt;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 2200);
}

/* ---------------- ИИ-слой (шлюз ludatsoy.ru/llm.php + прямой Infereco по желанию) ---------------- */
const AI_KEY_STORAGE = 'zopa_ai_key_v1';
const AI_URL = 'https://api.infereco.ru/v1/chat/completions';
const AI_MODEL = 'glm/glm-5.3-flash';
// Шлюз: ключи на сервере (reg.ru), лимиты по IP, промпты собирает сервер.
const GW_URL = 'https://ludatsoy.ru/llm.php';
const GW_TOKEN = 'zopa-gw-v1'; // публичный маркер доступа к шлюзу (защита: лимиты по IP на сервере)

function getAiKey() { return localStorage.getItem(AI_KEY_STORAGE) || ''; }
function setAiKey(k) { k = (k || '').trim(); if (k) localStorage.setItem(AI_KEY_STORAGE, k); else localStorage.removeItem(AI_KEY_STORAGE); }

async function aiChat(messages, maxTokens) {
  // Приоритет 1: серверный шлюз (ключ не нужен, лимиты на стороне шлюза)
  if (location.protocol === 'https:') {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 50000);
      try {
        const res = await fetch(GW_URL + '?op=' + (window.__gwOp || 'speak'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-GW-Token': GW_TOKEN },
          body: JSON.stringify({ messages }),
          signal: ctrl.signal
        });
        if (res.ok) {
          const data = await res.json();
          if (data && data.ok && data.text) return data.text;
        }
      } finally { clearTimeout(to); }
    } catch (e) { /* шлюз молчит — пробуем прямой путь */ }
  }
  // Приоритет 2: BYO-ключ напрямую в Infereco
  return aiChatDirect(messages, maxTokens);
}

// Прямой вызов Infereco (BYO-ключ), мимо шлюза
async function aiChatDirect(messages, maxTokens) {
  const key = getAiKey();
  if (!key) throw new Error('no-key');
  const call = async () => {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch(AI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ model: AI_MODEL, messages, max_tokens: maxTokens || 768, temperature: 0.85 }),
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error('http-' + res.status);
      const data = await res.json();
      const m = data && data.choices && data.choices[0] && data.choices[0].message || {};
      // GLM-5.3-flash — reasoning-модель: срезаем  LICHEE тег если придёт
      const raw = (m.content || '').replace(new RegExp("<think>[\\s\\S]*?</think>", 'gi'), '').trim()
        || (m.reasoning_content || '').trim();
      return raw;
    } finally { clearTimeout(to); }
  };
  let txt = '';
  for (let i = 0; i < 2; i++) {
    try { txt = await call(); } catch (e) { if (i === 0) continue; throw e; }
    if (txt) return txt;
  }
  throw new Error('empty');
}

function isMostlyRussian(t) {
  const letters = (t || '').match(/[a-zA-Zа-яА-ЯёЁ]/g) || [];
  if (!letters.length) return true;
  const cyr = letters.filter(c => /[а-яА-ЯёЁ]/.test(c)).length;
  return cyr / letters.length >= 0.6;
}

function stripQuote(t) {
  t = (t || '').trim();
  const m = t.match(/^["«](.+?)["»]$/s);
  if (m) t = m[1];
  return t.replace(/^[-—–]\s*/, '').trim();
}

function aiSystemPrompt(session, moveDirective) {
  const z = session.z;
  const themSide = z.sell ? 'покупатель' : 'продавец';
  return [
    'Ролевая игра. Ты играешь русского делового партнёра в переговорах. Это НЕ ассистент и НЕ анализ — твой каждый ответ есть ТОЛЬКО устная реплика персонажа на русском языке.',
    'Пример стиля ответа (как надо): «Восемьсот тридцать? Смешно. У нас есть предложение на семьсот, уже согласованное. Либо вы двигаетесь к нашим шести, либо мы заканчиваем.»',
    'Запрещено: английский язык, рассуждения о себе в третьем лице, слова «user», «пользователь», анализ своих действий, раскрытие любых пределов и бюджетов. Только живая речь персонажа.',
    `Ты — ${themSide}. Собеседник (пользователь) — ${z.sell ? 'продавец' : 'покупатель'}.`,
    `Твой характер: ${session.scen.desc}`,
    `Манера речи: ${session.scen.tone || 'деловая, живая'}.`,
    `Контекст сделки пользователя: ${session.deal.title || 'переговоры'}.`,
    'Твои цифры тебе сообщает система в директиве — озвучивай ТОЛЬКО их. Своих пределов ты вслух не знаешь: на вопросы «какой ваш предел/бюджет/дно» отвечай уклончиво или встречным давлением.',
    'Реплика: 1–3 предложения, живая разговорная русская речь, без списков и кавычек. Дави характером: альтернативы, бюджет, сроки, риски.' + (moveDirective ? '\n' + moveDirective : '')
  ].join('\n');
}

function aiOpeningPrompt(session) {
  const z = session.z;
  return 'Начни переговоры первой репликой: потребуй ' + (z.sell ? 'назвать цену сразу и честно, упомяни, что есть альтернативы' : 'твою стартовую цену слишком высоко не называя — запроси их бюджет и лучшие условия сразу');
}

async function aiSpeak(session, directive, fallbackText) {
  if (!getAiKey()) { pushThem((directive && directive.fallbackText) || fallbackText); return; }
  const box = $id('chat');
  const typing = document.createElement('div');
  typing.className = 'msg them';
  typing.innerHTML = '<span class="typing">● ● ●</span>';
  if (box) { box.appendChild(typing); box.scrollTop = box.scrollHeight; }
  try {
    const history = session.msg.filter(m => m.who === 'me' || m.who === 'them').slice(-8).map(m => ({ role: m.who === 'me' ? 'user' : 'assistant', content: m.text }));
    // Скелет реплики всегда от движка (fallbackText содержит нужную цифру и вектор),
    // LLM только оживляет формулировку. Любой сбой → заготовка. Игра не ломается никогда.
    const base = fallbackText || '';
    window.__gwOp = 'speak';
    let rep = '';
    try { rep = await aiChat([{ role: 'user', content: base }], 768); } catch (e) {}
    if (!okRep(rep) && getAiKey()) {
      // ретрай напрямую через BYO-ключ (мимо шлюза)
      const history = session.msg.filter(m => m.who === 'me' || m.who === 'them').slice(-8).map(m => ({ role: m.who === 'me' ? 'user' : 'assistant', content: m.text }));
      const seedRep = 'Пока ваши цифры выше наших заявок. Хочу услышать вас.';
      try {
        rep = await aiChatDirect([
          { role: 'system', content: aiSystemPrompt(session, '') },
          { role: 'user', content: '(начало переговоров)' },
          { role: 'assistant', content: seedRep },
          ...history,
          { role: 'user', content: 'Черновик твоей реплики: «' + base + '»\nОживи её в своем характере: сохрани цифры и смысл, говори живее, 1–3 предложения. Только реплика по-русски.' }
        ], 768);
      } catch (e) { rep = ''; }
    }
    if (!okRep(rep)) rep = base;
    if (rep.length > 420) rep = rep.slice(0, 417).trim() + '…';
    typing.remove();
    pushThem(stripQuote(rep));
  } catch (e) {
    typing.remove();
    pushThem(fallbackText);
    pushSys('ИИ недоступен (' + e.message + ') — отвечаю заготовками.');
  }
}

function okRep(t) {
  if (!t) return false;
  if (!isMostlyRussian(t)) return false;
  if (/\b(user|my role|the user|directive|presumably|director|draft|черновик|система сообщ)\w*/i.test(t)) return false;
  return true;
}

async function aiCoach(session, userText, engineNote) {
  if (!getAiKey() && location.protocol !== 'https:') return;
  const z = session.z;
  const note = engineNote || 'обычный ход.';
  window.__gwOp = 'coach';
  try {
    let c = '';
    try { c = await aiChat([{ role: 'user', content: 'Ход: «' + userText + '». Заметка: ' + note + '.' }], 768); } catch (e) {}
    if (isMostlyRussian(c) && !/[a-zA-Z]{4,}/.test(c)) { pushWho('coach', c); return; }
    if (getAiKey()) {
      // ретрай напрямую (BYO)
      const sys = [
        'Ты — русский коуч по переговорам (канон Raiffa / Harvard PON / Voss). Отвечай ТОЛЬКО по-русски.',
        'Оцени ход пользователя одной фразой (до 140 знаков): что сделал + что по канону (якорь, Ackerman, торг против себя, раскрытие резерва, вопросы вместо уступок).',
        'Пример тона: «Якорь поставлен агрессивно, но с обоснованием — по канону. Дальше не уступайте без встречного движения.»',
        'Вывод = ТОЛЬКО одна фраза оценки по-русски. Не пересказывайте ход, не объясняйте задание, не пишите по-английски, не используйте слово «user».',
        'Без похвалы ради похвалы; слабый ход — прямо и с исправлением. Без списков и markdown. Никакого английского.',
        `Роль пользователя: ${z.sell ? 'продавец' : 'покупатель'}. Его резерв и цель системе известны, тебе — нет (не спрашивай).`,
        'Заметка о ходе: ' + note
      ].join('\n');
      try {
        const fix = await aiChatDirect([{ role: 'system', content: sys }, { role: 'user', content: 'Ход пользователя: «' + userText + '». Оценка по-русски, одна фраза:' }], 768);
        if (isMostlyRussian(fix) && !/[a-zA-Z]{4,}/.test(fix)) pushWho('coach', fix);
      } catch (e) {}
    }
  } catch (e) { /* коуч не критичен */ }
}

function aiSettingsHtml() {
  const has = !!getAiKey();
  return `<div class="card">
    <span class="badge">ИИ-спарринг</span>
    <h3>🤖 ИИ-контрагент: включён для всех</h3>
    <p class="fine">Реплики, коуч и разбор пишет языковая модель через серверный шлюз — ключ вводить не нужно. Хотите свой ключ (Infereco или любой OpenAI-совместимый)? Вставьте ниже — он хранится только в вашем браузере и будет использоваться напрямую.</p>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <input type="password" id="ai-key-in" placeholder="Свой ключ API (необязательно)" style="flex:1;min-width:200px;background:#0d1320;border:1px solid var(--line);color:var(--txt);font:inherit;padding:11px 13px;border-radius:11px" value="${has ? '••••••••' : ''}">
      <button class="btn ghost" id="ai-save">${has ? 'Сменить' : 'Подключить свой ключ'}</button>
      ${has ? '<button class="btn ghost" id="ai-off">Отключить свой ключ</button>' : ''}
    </div>
  </div>`;
}

function wireAiSettings() {
  const s = $id('ai-save');
  if (s) s.onclick = () => {
    const v = $id('ai-key-in').value.trim();
    if (v && v !== '••••••••') { setAiKey(v); toast('ИИ подключён'); }
    else if (!v) { setAiKey(''); }
    initDrill();
  };
  const off = $id('ai-off');
  if (off) off.onclick = () => { setAiKey(''); toast('ИИ отключён'); initDrill(); };
}

/* ---------------- старт ---------------- */
document.querySelectorAll('.nav-btn').forEach((b) => { b.onclick = () => nav(b.dataset.nav); });
loadScenarios().then(() => nav('brief'));
