import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDatabase, ref, get, set, update, onValue, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { S, TEAMS, n, teamOf, roleOf, total, CODE_RE, seatKey, pickKey, PICK_MS, READY_MS } from "./draft.js";

// Public web config: security comes from database.rules.json, not from hiding these.
const app = initializeApp({
  apiKey: "AIzaSyD7nZhpa_0MmQegpSweoEPk8B6p1kBlNWA",
  authDomain: "runner-draft.firebaseapp.com",
  databaseURL: "https://runner-draft-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "runner-draft",
  storageBucket: "runner-draft.firebasestorage.app",
  messagingSenderId: "537504677059",
  appId: "1:537504677059:web:31e876672aa5c45289b676",
});
const auth = getAuth(app);
const fdb = getDatabase(app);

const $ = id => document.getElementById(id);
const rounds = () => Math.ceil(total() / n());
const count = (t, role) => S.picks.filter((x, p) => teamOf(p) === t && roleOf(x) === role).length;
const av = name => PHOTOS[name] ? `<img class="av" src="${PHOTOS[name]}" alt="">` : "";
const tag = role => `<span class="tag ${role}">${role}</span>`;
const validPicks = raw => Array.isArray(raw) ? raw.filter((x, i) => (S.dps.includes(x) || S.sup.includes(x)) && raw.indexOf(x) === i).slice(0, total()) : [];
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }

const ROOM_KEY = "runner-room";       // "SOLO" or the matched room code, to resume after reload
const SOLO_KEY = "runner-solo";       // {order: [captain], picks: [player]}
let me = null, ready = false, failed = false, code = null, room = null, seats = {}, unsub = null, busy = false;
let solo = false;                      // one person picks for every team, kept in this browser only
let order = null;                      // solo: chosen captain order (null while choosing)
let draftOrder = [];                   // solo: captains clicked so far on the order screen
const mySeat = () => solo ? (order && S.teams[teamOf(S.picks.length)]) : S.teams.find(t => seats[t] === me) || null;
const seated = () => solo ? n() : S.teams.filter(t => seats[t]).length;
const roomRef = (path = "") => ref(fdb, `rooms/${code}${path}`);
const slotOf = t => TEAMS.findIndex((_, k) => room?.slots?.["o" + k] === seatKey(TEAMS.indexOf(t)));   // -1: no pick order chosen yet
const isReady = t => room?.ready?.[seatKey(TEAMS.indexOf(t))] === true;
const readyCount = () => TEAMS.filter(t => seats[t] && isReady(t)).length;
const started = () => solo || typeof room?.turn === "number";   // online: turn exists once everyone was ready
// the rules judge time limits by server time, so show countdowns in server time too
let skew = 0; onValue(ref(fdb, ".info/serverTimeOffset"), s => { skew = s.val() || 0; });
const now = () => Date.now() + skew;

let tt; function toast(m) { $("toast").textContent = m; clearTimeout(tt); tt = setTimeout(() => $("toast").textContent = "", 3500); }

let saved = null; try { saved = localStorage.getItem(ROOM_KEY); } catch {}
let booted = false;
onAuthStateChanged(auth, async u => {
  if (!u || booted) return;
  booted = true; me = u.uid; ready = true;
  if (solo) return render();
  if (saved && saved !== "SOLO") await enter(saved); else render();
});
signInAnonymously(auth).catch(() => { ready = true; failed = true; render(); });

// ---------- online: random matching ----------

function newCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  return Array.from(crypto.getRandomValues(new Uint32Array(6)), x => A[x % A.length]).join("");
}

function seatsOf(v) {
  const out = {};
  TEAMS.forEach((t, i) => { const u = v?.seats?.[seatKey(i)]; if (typeof u === "string") out[t] = u; });
  return out;
}
// joinable: draft not started and a seat is free (or I already hold one)
const joinable = v => {
  const s = Object.values(seatsOf(v));
  return !!v && (s.includes(me) || (!v.picks && v.turn == null && s.length < n()));
};

async function createRoom() {
  let c; do { c = newCode(); } while ((await get(ref(fdb, `rooms/${c}/host`))).exists());
  await set(ref(fdb, `rooms/${c}`), { host: me, createdAt: Date.now() });
  return c;
}

// match/current points at the room new players should join. Join it while it is open;
// otherwise make a new room and swap the pointer in a transaction so simultaneous
// players converge on one room instead of each opening their own.
async function matchmake() {
  if (busy) return; busy = true; render();
  try {
    for (let tries = 0; tries < 3; tries++) {
      const cur = (await get(ref(fdb, "match/current"))).val();
      if (typeof cur === "string" && CODE_RE.test(cur) && joinable((await get(ref(fdb, `rooms/${cur}`))).val())) {
        if (await enter(cur)) return;
        continue;
      }
      const mine = await createRoom();
      const res = await runTransaction(ref(fdb, "match/current"), x => (x == null || x === cur) ? mine : undefined);
      const target = res.committed ? mine : res.snapshot.val();
      if (typeof target === "string" && await enter(target)) return;
    }
    toast("매칭에 실패했습니다. 다시 눌러 주세요.");
  } catch { toast("매칭에 실패했습니다. 잠시 후 다시 눌러 주세요."); }
  finally { busy = false; render(); }
}

async function enter(c) {
  if (!CODE_RE.test(c)) { forget(); render(); return false; }
  try {
    if (!joinable((await get(ref(fdb, `rooms/${c}`))).val())) { forget(); render(); return false; }
  } catch { render(); return false; }
  leaveRoom(true);
  code = c;
  try { localStorage.setItem(ROOM_KEY, c); } catch {}
  unsub = onValue(roomRef(), snap => {
    room = snap.val();
    seats = seatsOf(room);
    const p = room?.picks || {};
    S.picks = validPicks(Object.keys(p).sort().map(k => p[k]));
    // online pick order: slots/o<k> = seat key; until all five are chosen show seat order
    const ord = TEAMS.map((_, k) => room?.slots?.["o" + k]);
    S.teams = ord.every(x => /^s[0-4]$/.test(x)) && new Set(ord).size === n() ? ord.map(x => TEAMS[+x.slice(1)]) : TEAMS.slice();
    render();
  }, () => toast("방 연결이 끊겼습니다. 새로고침해 주세요."));
  render();
  return true;
}

function forget() { try { localStorage.removeItem(ROOM_KEY); } catch {} }
function leaveRoom(keepSaved) {
  if (unsub) unsub(); unsub = null; code = null; room = null; seats = {}; S.picks = []; S.teams = TEAMS.slice();
  if (!keepSaved) forget();
}

async function claim(team) {
  if (busy || mySeat() || !TEAMS.includes(team)) return; busy = true; render();
  // the rules only accept a claim on an empty seat, so a lost race is rejected server-side
  try { await set(roomRef(`/seats/${seatKey(TEAMS.indexOf(team))}`), me); }
  catch { toast("이미 다른 사람이 앉은 자리입니다."); }
  busy = false; render();
}

// ---------- solo ----------

function startSolo() {
  leaveRoom(); solo = true; ready = true; draftOrder = [];
  try { localStorage.setItem(ROOM_KEY, "SOLO"); } catch {}
  let st = {}; try { st = JSON.parse(localStorage.getItem(SOLO_KEY)) || {}; } catch {}
  const ok = Array.isArray(st.order) && st.order.length === n() && TEAMS.every(t => st.order.includes(t));
  order = ok ? st.order : null;
  S.teams = order ? order.slice() : TEAMS.slice();
  S.picks = order ? validPicks(st.picks) : [];
  render();
}
function saveSolo() { try { localStorage.setItem(SOLO_KEY, JSON.stringify({ order, picks: S.picks })); } catch {} }

function toggleOrder(team) {
  const i = draftOrder.indexOf(team);
  if (i >= 0) draftOrder.splice(i, 1); else draftOrder.push(team);
  render();
}
function confirmOrder() {
  if (draftOrder.length !== n()) return;
  order = draftOrder.slice(); S.teams = order.slice(); S.picks = []; saveSolo(); render();
}

// ---------- shared actions ----------

async function exit() {
  if (solo) { solo = false; order = null; S.teams = TEAMS.slice(); S.picks = []; forget(); return render(); }
  const t = mySeat();
  // before the draft starts, leaving frees the seat for someone else
  if (t && !started()) { const s = seatKey(TEAMS.indexOf(t)); const u = { [`seats/${s}`]: null, [`ready/${s}`]: null }; if (slotOf(t) >= 0) u[`slots/o${slotOf(t)}`] = null;
    try { await update(roomRef(), u); } catch {} }
  leaveRoom(); render();
}

// one write adds the pick and moves the clock; the rules reject it if the turn already moved on
const pickWrite = (cur, name) => update(roomRef(), {
  [`picks/${pickKey(cur)}`]: name, [`taken/${name}`]: pickKey(cur), turn: cur + 1, turnAt: serverTimestamp(),
});

async function pick(name) {
  const cur = S.picks.length, t = S.teams[teamOf(cur)];
  if (busy || cur >= total() || seated() < n() || !started() || (!solo && seats[t] !== me)) return;
  if (S.picks.includes(name) || count(teamOf(cur), roleOf(name)) >= S.cap) return;
  if (solo) { S.picks.push(name); saveSolo(); return render(); }
  busy = true; render();
  try { await pickWrite(cur, name); }
  catch { toast(S.picks.length > cur ? "시간이 지나 자동 지명되었습니다." : "지명을 저장하지 못했습니다. 다시 눌러 주세요."); }
  busy = false; render();
}

// first come: take a free pick-order slot, or click mine again to give it back
async function chooseSlot(k) {
  const t = mySeat();
  if (busy || !t || started() || isReady(t)) return;
  const cur = room?.slots?.["o" + k], mineKey = seatKey(TEAMS.indexOf(t));
  if (cur && cur !== mineKey) return;
  busy = true; render();
  const u = { [`slots/o${k}`]: cur ? null : mineKey };
  if (!cur && slotOf(t) >= 0) u[`slots/o${slotOf(t)}`] = null;   // switching slots
  try { await update(roomRef(), u); }
  catch { toast("다른 팀장이 먼저 고른 순번입니다."); }
  busy = false; render();
}

async function readyUp() {
  const t = mySeat();
  if (busy || !t || isReady(t) || slotOf(t) < 0) return; busy = true; render();
  try { await set(roomRef(`/ready/${seatKey(TEAMS.indexOf(t))}`), true); }
  catch { toast("준비 상태를 저장하지 못했습니다. 다시 눌러 주세요."); }
  busy = false; render();
}

// ---------- timers: any seated captain moves a stalled room along ----------

// time ran out: pick a random player the idle team may still take
function autoPick() {
  const cur = S.picks.length, t = teamOf(cur), taken = new Set(S.picks);
  const pool = [...S.dps, ...S.sup].filter(p => !taken.has(p) && count(t, roleOf(p)) < S.cap);
  return pool.length ? pickWrite(cur, pool[Math.floor(Math.random() * pool.length)]) : Promise.resolve();
}
// ready window over: free every seat that never pressed ready
function kickUnready() {
  const u = { readyAt: null };
  TEAMS.forEach((t, i) => { if (seats[t] && !isReady(t)) { u[`seats/${seatKey(i)}`] = null; if (slotOf(t) >= 0) u[`slots/o${slotOf(t)}`] = null; } });
  return update(roomRef(), u);
}

let maintBusy = false;
function maint(fn) {
  if (maintBusy) return; maintBusy = true;
  // a rejected write is normal here (another captain got there first, or the server clock disagrees)
  fn().catch(() => {}).finally(() => setTimeout(() => { maintBusy = false; }, 1000));
}

function tick() {
  const el = $("timer"); let txt = "", low = false;
  if (!solo && code && room && mySeat()) {
    const full = seated() >= n(), t = now();
    if (started() && S.picks.length < total()) {
      const left = (room.turnAt || 0) + PICK_MS - t;
      txt = `남은 시간 ${Math.max(0, Math.ceil(left / 1000))}초`; low = left < 10000;
      if (left < -500) maint(autoPick);
    } else if (!started()) {
      if (full && readyCount() >= n()) maint(() => update(roomRef(), { turn: 0, turnAt: serverTimestamp(), readyAt: null }));
      else if (full && !room.readyAt) maint(() => set(roomRef("/readyAt"), serverTimestamp()));
      else if (full) {
        const left = room.readyAt + READY_MS - t;
        txt = `준비 마감 ${Math.max(0, Math.ceil(left / 1000))}초`; low = left < 10000;
        if (left < -500) maint(kickUnready);
      } else if (room.readyAt) maint(() => set(roomRef("/readyAt"), null));
    }
  }
  if (el.textContent !== txt) el.textContent = txt;
  el.classList.toggle("low", low);
}
setInterval(tick, 250);

// one step back: last pick first, then the captain order one captain at a time
function undo() {
  if (!solo) return;
  if (S.picks.length) { const name = S.picks.pop(); saveSolo(); render(); return toast(`${name} 지명을 취소했습니다.`); }
  if (order) { draftOrder = order.slice(0, -1); order = null; S.teams = TEAMS.slice(); saveSolo(); render(); return toast("팀장 순서 선택으로 돌아갔습니다."); }
  if (draftOrder.length) { const t = draftOrder.pop(); render(); toast(`${t} 순서 선택을 취소했습니다.`); }
}

async function reset(btn) {
  if (!btn.classList.contains("armed")) { btn.classList.add("armed"); btn.textContent = "한 번 더 누르면 초기화됩니다"; return; }
  if (!solo) return;   // online drafts are final
  order = null; draftOrder = []; S.teams = TEAMS.slice(); S.picks = []; saveSolo(); render();
}

// ---------- render ----------

function card(name, attrs, label) {
  return `<li><button ${attrs}>${PHOTOS[name] ? `<img src="${PHOTOS[name]}" alt="">` : ""}<span>${label}</span></button></li>`;
}

function render() {
  const lobby = $("lobby"), bar = $("roombar"), game = $("game");
  $("readybox").innerHTML = "";
  const mine = (code || solo) && mySeat();
  lobby.hidden = !!mine; bar.hidden = !code && !solo; game.hidden = !mine;

  if (!ready) { $("clock").textContent = "연결 중…"; lobby.innerHTML = ""; return; }
  if (failed && !solo) {
    $("clock").textContent = "서버에 연결하지 못했습니다";
    lobby.innerHTML = `<h2 class="band">Online</h2><p class="hint">인터넷 연결을 확인하고 새로고침해 주세요. 혼자 진행은 지금도 할 수 있습니다.</p><div class="lobby-row"><button class="btn light" data-act="solo">혼자 진행</button></div>`;
    return;
  }

  if (solo) {
    bar.innerHTML = `<span class="roomcode">SOLO</span>` +
      `<button class="btn light" data-act="undo" ${order || draftOrder.length ? "" : "disabled"}>선택 취소</button>` +
      `<button class="btn light" data-act="exit">나가기</button>`;
  } else if (code) {
    bar.innerHTML = `<div class="chips">${TEAMS.map(t => `<span class="chip ${seats[t] === me ? "me" : seats[t] ? "on" : ""}">${esc(t)} ${!seats[t] ? "○" : isReady(t) && !started() ? "✓" : "●"}</span>`).join("")}</div>
      <button class="btn light" data-act="exit">나가기</button>`;
  }

  if (!code && !solo) {
    $("clock").textContent = "진행 방식을 고르세요";
    lobby.innerHTML = `<h2 class="band">Online</h2>
      <div class="lobby-row"><button class="btn" data-act="match" ${busy ? "disabled" : ""}>${busy ? "매칭 중…" : "랜덤 매칭"}</button></div>
      <p class="hint">대기 중인 방에 자동으로 들어갑니다. 각자 팀장 자리를 고르고, 다섯 명이 모이면 시작합니다.</p>
      <p class="or">OR</p>
      <div class="lobby-row"><button class="btn light" data-act="solo">혼자 진행</button></div>
      <p class="hint">한 사람이 다섯 팀의 지명을 모두 누릅니다. 결과는 이 브라우저에만 저장됩니다.</p>`;
    return;
  }

  if (solo && !order) {
    $("clock").textContent = "지명 순서대로 팀장을 누르세요";
    lobby.innerHTML = `<h2 class="band">Order<small>${draftOrder.length}/${n()}</small></h2><ul>` +
      TEAMS.map(t => { const i = draftOrder.indexOf(t);
        return card(t, `data-order="${esc(t)}" ${i >= 0 ? 'class="mine"' : ""}`, i >= 0 ? `${i + 1}픽 · ${esc(t)}` : esc(t)); }).join("") +
      `</ul><p class="hint">${draftOrder.length ? draftOrder.map((t, i) => `${i + 1}. ${esc(t)}`).join(" → ") : "누른 순서가 1라운드 지명 순서가 됩니다. 다시 누르면 빠집니다."}</p>
      <div class="lobby-row" style="margin-top:12px"><button class="btn" data-act="order-ok" ${draftOrder.length === n() ? "" : "disabled"}>이 순서로 시작</button></div>`;
    return;
  }

  if (!mine) {
    $("clock").textContent = "내 팀장 자리를 고르세요";
    lobby.innerHTML = `<h2 class="band">Captain<small>${seated()}/${n()} 입장</small></h2><ul>` +
      TEAMS.map(t => card(t, `data-team="${esc(t)}" ${seats[t] || busy ? "disabled" : ""}`, `${esc(t)}${seats[t] ? " · 입장" : ""}`)).join("") + `</ul>`;
    return;
  }

  const cur = S.picks.length, done = cur >= total(), t = teamOf(cur);
  const full = seated() >= n(), go = full && started(), myTurn = go && !done && S.teams[t] === mine;
  let html = `<tr><th class="rnd">R</th>${S.teams.map((c, i) =>
    `<th>${esc(c)} 팀<small>DPS ${count(i, "DPS")}/${S.cap} · SUP ${count(i, "SUP")}/${S.cap}</small></th>`).join("")}</tr>`;
  html += `<tr class="cap"><td class="rnd">TANK</td>${S.teams.map(c => `<td><span class="no">CAPTAIN</span><span class="who">${av(c)}${esc(c)}</span></td>`).join("")}</tr>`;
  for (let r = 0; r < rounds(); r++) {
    const cells = Array(n()).fill("<td></td>");
    for (let i = 0; i < n(); i++) {
      const p = r * n() + i; if (p >= total()) break;
      const name = S.picks[p];
      cells[teamOf(p)] = `<td class="${p === cur && !done && go ? "cur" : ""}"><span class="no">#${p + 1}</span>${name ? `<span class="who">${av(name)}<span class="nm">${tag(roleOf(name))}${esc(name)}</span></span>` : ""}</td>`;
    }
    html += `<tr><td class="rnd">${r + 1}</td>${cells.join("")}</tr>`;
  }
  $("board").innerHTML = html;

  $("clock").innerHTML = done ? "드래프트 완료"
    : !full ? `팀장 입장 대기 중 · ${seated()}/${n()}`
    : !go ? `준비 확인 · ${readyCount()}/${n()}`
    : myTurn && !solo ? `<b>내 차례</b> ${esc(mine)} 팀 · ${Math.floor(cur / n()) + 1}라운드 ${cur % n() + 1}픽`
    : `<b>${esc(S.teams[t])} 팀</b> 지명 차례 · ${Math.floor(cur / n()) + 1}라운드 ${cur % n() + 1}픽`;

  if (done) {
    $("pool").innerHTML = `<h2 class="band">Line Up</h2><p class="empty">모든 픽이 끝났습니다.</p>` + (solo ? `<button class="reset" data-act="reset">팀 초기화</button>` : "");
    return;
  }
  const taken = new Set(S.picks);
  // ready button sits right under the countdown so it is the first thing a captain sees
  if (!solo && !go) {
    const mineKey = seatKey(TEAMS.indexOf(mine)), noSlot = slotOf(mine) < 0;
    const slotBtns = TEAMS.map((_, k) => { const x = room?.slots?.["o" + k], owner = x && TEAMS[+x.slice(1)];
      return `<button class="btn ${x === mineKey ? "" : "light"}" data-slot="${k}" ${(x && x !== mineKey) || isReady(mine) || busy ? "disabled" : ""}>${k + 1}픽${owner ? " · " + esc(owner) : ""}</button>`; }).join("");
    $("readybox").innerHTML = `<div class="lobby-row">${slotBtns}</div>` + (!full ? `<p class="hint">1라운드 지명 순번을 고르세요. 다시 누르면 취소됩니다.</p>` :
      `<div class="lobby-row"><button class="btn" data-act="ready" ${isReady(mine) || noSlot || busy ? "disabled" : ""}>${isReady(mine) ? "준비 완료" : noSlot ? "순번을 먼저 고르세요" : "준비"}</button></div>
    <p class="hint">순번을 고르고 준비하세요. 모두 준비하면 바로 시작합니다. ${READY_MS / 1000}초 안에 준비하지 않은 팀장은 자리에서 빠집니다. 시작 후 ${PICK_MS / 1000}초 안에 고르지 않으면 자동으로 지명됩니다.</p>`);
  }
  $("pool").innerHTML = ["DPS", "SUP"].map(role => {
    const list = (role === "DPS" ? S.dps : S.sup).filter(p => !taken.has(p));
    const capped = count(t, role) >= S.cap;
    const note = !full ? "모두 입장하면 시작" : !go ? "모두 준비하면 시작" : !myTurn ? `${esc(S.teams[t])} 팀 차례` : capped ? "한도 도달" : `남은 ${list.length}명`;
    return `<h2 class="band">${role}<small>${note}</small></h2><ul>` +
      (list.map(p => card(p, `data-p="${esc(p)}" ${!myTurn || capped || busy ? "disabled" : ""} ${myTurn && !capped ? 'class="mine"' : ""}`, `${tag(role)}${esc(p)}`)).join("") || `<li class="empty">없음</li>`) + `</ul>`;
  }).join("");
}

document.addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  if (act === "match") matchmake();
  else if (act === "solo") startSolo();
  else if (act === "exit") exit();
  else if (act === "undo") undo();
  else if (act === "ready") readyUp();
  else if (b.dataset.slot) chooseSlot(+b.dataset.slot);
  else if (act === "reset") reset(b);
  else if (act === "order-ok") confirmOrder();
  else if (b.dataset.order) toggleOrder(b.dataset.order);
  else if (b.dataset.team) claim(b.dataset.team);
  else if (b.dataset.p) pick(b.dataset.p);
});

if (saved === "SOLO") startSolo(); else render();
