// Generates database.rules.json from public/draft.js. Run: node gen-rules.mjs
import { writeFileSync } from "node:fs";
import { S, TEAMS, total, teamOf, seatKey, pickKey, PICK_MS, READY_MS } from "./public/draft.js";

const R = "root.child('rooms').child($code)";
const I = TEAMS.map((_, i) => i);
const seat = i => `${R}.child('seats/${seatKey(i)}')`;
const seated = `(${I.map(i => `${seat(i)}.val() === auth.uid`).join(" || ")})`;
const allSeated = I.map(i => `${seat(i)}.exists()`).join(" && ");
const allReady = I.map(i => `${R}.child('ready/${seatKey(i)}').val() === true`).join(" && ");
const started = `${R}.child('turn').exists()`;
const names = [...S.dps, ...S.sup].map(x => `newData.val() === '${x}'`).join(" || ");

const seats = { $other: { ".validate": false } };
const ready = { $other: { ".validate": false } };
// slots/o<k> = seat key of the captain who picks k-th in round 1 (first come)
const slot = k => `${R}.child('slots/o${k}')`;
const slotOwner = v => `${R}.child('seats').child(${v}).val() === auth.uid`;
const slots = { $other: { ".validate": false } };
I.forEach(k => {
  slots["o" + k] = {
    ".write": `auth != null && !${started} && (` +
      // take a free slot for my own seat, holding no other slot after this write (switching is one write)
      `(!data.exists() && ${slotOwner("newData.val()")} && ${I.filter(j => j !== k).map(j => `newData.parent().child('o${j}').val() !== newData.val()`).join(" && ")})` +
      // give it back: not while ready, unless the seat itself is being left in the same write
      ` || (!newData.exists() && ${slotOwner("data.val()")} && (${R}.child('ready').child(data.val()).val() !== true || !newData.parent().parent().child('seats').child(data.val()).exists()))` +
      // ready window over: free the slot of a captain being removed
      ` || (!newData.exists() && ${seated} && ${R}.child('readyAt').exists() && now > ${R}.child('readyAt').val() + ${READY_MS} && ${R}.child('ready').child(data.val()).val() !== true))`,
    ".validate": "newData.isString() && newData.val().matches(/^s[0-4]$/)",
  };
});
I.forEach(i => {
  seats[seatKey(i)] = { ".write": `auth != null && (` +
    // claim an empty seat, not already holding another
    `(!data.exists() && newData.val() === auth.uid && ${R}.child('host').exists() && ${I.map(j => `${seat(j)}.val() !== auth.uid`).join(" && ")})` +
    // leave own seat before the draft starts
    ` || (data.val() === auth.uid && !newData.exists() && !${started})` +
    // ready window over: any captain may remove one who never pressed ready
    ` || (data.exists() && !newData.exists() && ${seated} && !${started} && ${R}.child('readyAt').exists() && now > ${R}.child('readyAt').val() + ${READY_MS} && ${R}.child('ready/${seatKey(i)}').val() !== true))` };
  ready[seatKey(i)] = {
    ".write": `auth != null && !${started} && ${seat(i)}.val() === auth.uid && (${I.map(k => `${slot(k)}.val() === '${seatKey(i)}'`).join(" || ")})`,
    ".validate": "newData.isBoolean()",
  };
});

// no ".write" here: a finished draft is never wiped
const picks = {
  $other: { ".validate": false },
};
for (let p = 0; p < total(); p++) {
  picks[pickKey(p)] = {
    ".write": `auth != null && !data.exists() && ${p ? `${R}.child('picks/${pickKey(p - 1)}').exists()` : "true"} && ${allSeated}` +
      ` && ${R}.child('turn').val() === ${p} && newData.parent().parent().child('turn').val() === ${p + 1}` +
      // the team on the clock picks; after the time limit any captain picks for it
      ` && (${slotOwner(`${slot(teamOf(p))}.val()`)} || (${seated} && now >= ${R}.child('turnAt').val() + ${PICK_MS}))`,
    ".validate": `newData.isString() && (${names}) && newData.parent().parent().child('taken').child(newData.val()).val() === '${pickKey(p)}'`,
  };
}

const turnSteps = Array.from({ length: total() }, (_, p) =>
  `(data.val() === ${p} && newData.val() === ${p + 1} && newData.parent().child('picks/${pickKey(p)}').exists())`).join(" || ");

const rules = { rules: {
  match: { current: {
    ".read": "auth != null",
    ".write": "auth != null",
    ".validate": "newData.isString() && newData.val().matches(/^[A-Z0-9]{6}$/) && root.child('rooms').child(newData.val()).child('host').exists()",
  } },
  rooms: { $code: {
    ".read": "auth != null",
    ".write": "auth != null && !data.exists() && newData.child('host').val() === auth.uid && $code.matches(/^[A-Z0-9]{6}$/)",
    host: { ".validate": "newData.isString()" },
    createdAt: { ".validate": "newData.isNumber()" },
    seats,
    ready,
    slots,
    readyAt: {
      ".write": `auth != null && ${seated} && !${started} && (!newData.exists() || (!data.exists() && newData.val() === now && ${allSeated}))`,
      ".validate": "newData.isNumber()",
    },
    // next pick index; 0 starts once everyone is ready
    turn: {
      ".write": `auth != null && ${seated} && ((!data.exists() && newData.val() === 0 && !newData.parent().child('picks').exists() && ${allSeated} && ${allReady}) || ${turnSteps})`,
      ".validate": "newData.isNumber()",
    },
    turnAt: {
      ".write": `auth != null && ${seated} && newData.val() === now && newData.parent().child('turn').val() !== data.parent().child('turn').val()`,
      ".validate": "newData.isNumber()",
    },
    picks,
    taken: {
      $name: {
        ".write": "auth != null && !data.exists()",
        ".validate": "newData.isString() && newData.parent().parent().child('picks').child(newData.val()).val() === $name",
      },
    },
    $other: { ".validate": false },
  } },
} };

writeFileSync(new URL("./database.rules.json", import.meta.url), JSON.stringify(rules, null, 2) + "\n");
console.log("database.rules.json written");
