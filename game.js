// game rules only, no ui or networking
// the board is one flat ring where each player owns 6 pits followed by their store
const PITS = 6, ROW = PITS + 1;

// normal puts 4 stones in every pit
// random gives every pit 1-5 stones; sides differ in layout but hold the same total,
// which varies from game to game and is never under 15
function newGame(n, mode, random) {
  const roll = () => Array.from({ length: PITS }, () => random ? 1 + (Math.random() * 5 | 0) : 4);
  const sum = side => side.reduce((a, b) => a + b);
  let first = roll();
  while (sum(first) < 15) first = roll();
  const board = [];
  for (let p = 0; p < n; p++) {
    let side = p ? roll() : first;
    while (sum(side) !== sum(first)) side = roll(); // re-roll until the totals match
    board.push(...side, 0);
  }
  // steps are the stone movements of the latest move, kept so the ui can replay them
  // [from, to] is one stone sown from the hand picked up at from
  // [from, to, count] is a pile moved in one go
  // [pit] is the pause before an avalanche picks that pit up and carries on
  return { id: Math.random(), n, mode, board, turn: 0, out: [], over: false, last: -1, moveNo: 0, steps: [] };
}

const score = (g, p) => g.board[p * ROW + PITS];

function nextTurn(g) {
  for (let k = 0; k < g.n; k++) {
    g.turn = (g.turn + 1) % g.n;
    if (!g.out.includes(g.turn)) return;
  }
}

// medium bot looks one move ahead and takes whatever banks the most stones
// moves that earn another turn are preferred, and ties are broken at random
function botMove(g) {
  const me = g.turn;
  let best = [], bestValue = -Infinity;
  for (let s = 0; s < PITS; s++) {
    const c = structuredClone(g);
    if (!play(c, s)) continue;
    const value = score(c, me) - score(g, me) + (!c.over && c.turn === me ? 1 : 0);
    if (value > bestValue) { best = [s]; bestValue = value; }
    else if (value === bestValue) best.push(s);
  }
  return best[Math.random() * best.length | 0];
}

// current player plays pit slot (0-5); returns false when the move is illegal
function play(g, slot) {
  const me = g.turn, len = g.n * ROW, b = g.board, store = me * ROW + PITS;
  const start = me * ROW + slot;
  if (g.over || !Number.isInteger(slot) || slot < 0 || slot >= PITS || !b[start]) return false;

  const steps = [];
  let i = start;
  for (;;) {
    const from = i;
    let hand = b[i];
    b[i] = 0;
    while (hand) {
      i = (i + 1) % len;
      if (i % ROW === PITS && i !== store) continue; // skip other players' stores
      b[i]++;
      hand--;
      steps.push([from, i]);
    }
    // avalanche: landing on a non-empty pit picks it up and keeps going
    if (g.mode === 'avalanche' && i !== store && b[i] > 1) { steps.push([i]); continue; }
    break;
  }

  // capture: last stone in my own empty pit takes the mirrored pit of every opponent
  if (g.mode === 'capture' && i !== store && Math.floor(i / ROW) === me && b[i] === 1) {
    const mirror = PITS - 1 - (i % ROW);
    const targets = [];
    for (let p = 0; p < g.n; p++) if (p !== me && b[p * ROW + mirror]) targets.push(p * ROW + mirror);
    if (targets.length) {
      for (const t of [...targets, i]) { steps.push([t, store, b[t]]); b[store] += b[t]; b[t] = 0; }
    }
  }

  g.last = start;
  g.steps = steps;
  g.moveNo++;

  // game ends when any side is empty; everyone banks what is left on their own side
  const empty = p => b.slice(p * ROW, p * ROW + PITS).every(x => !x);
  if ([...Array(g.n).keys()].some(empty)) {
    for (let p = 0; p < g.n; p++)
      for (let s = 0; s < PITS; s++) {
        const t = p * ROW + s;
        if (b[t]) steps.push([t, p * ROW + PITS, b[t]]);
        b[p * ROW + PITS] += b[t];
        b[t] = 0;
      }
    g.over = true;
    return true;
  }

  if (i !== store) nextTurn(g); // ending in your own store earns another turn
  return true;
}
