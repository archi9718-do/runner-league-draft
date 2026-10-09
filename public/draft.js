// Shared by the page (app.js) and the rules generator (gen-rules.mjs).
// TEAMS is the online seat order (seat s0..s4); solo mode may reorder S.teams.
export const TEAMS = ["룩삼", "콩콩", "푸린", "둥그레", "울프"];
export const S = {
  teams: TEAMS.slice(),
  dps: ["김뿡", "꼴랑이", "뀨냥냥", "디디디용", "마뫄", "뱅", "설백", "엘리", "정령왕", "큐베"],
  sup: ["눈꽃", "담유이", "삐부", "새담", "서넹", "아야츠노 유니", "양아지", "인섹", "임나은", "남봉"],
  cap: 2,
  picks: [], // online: mirrored from rooms/<code>/picks; solo: this browser's picks
};
export const CODE_RE = /^[A-Z0-9]{6}$/;
export const PICK_MS = 30000;   // per-pick limit; after it any seated captain may auto-pick
export const READY_MS = 60000;  // once all seats fill, captains not ready by then can be removed
export const n = () => S.teams.length;
export const total = () => S.dps.length + S.sup.length;
// snake: odd rounds go 1→n, even rounds go n→1
export const teamOf = p => { const r = Math.floor(p / n()), i = p % n(); return r % 2 ? n() - 1 - i : i; };
export const roleOf = name => S.dps.includes(name) ? "DPS" : "SUP";
export const seatKey = i => "s" + i;
export const pickKey = p => "p" + String(p).padStart(2, "0");
