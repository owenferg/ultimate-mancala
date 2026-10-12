// Pure game rules. The board is one flat ring: each player owns 6 pits followed by their store.
const PITS = 6, ROW = PITS + 1;

function newGame(n, stones, mode) {
  const board = [];
  for (let p = 0; p < n; p++) board.push(...Array(PITS).fill(stones), 0);
  return { n, mode, board, turn: 0, out: [], over: false, last: -1 };
}

const score = (g, p) => g.board[p * ROW + PITS];

function nextTurn(g) {
  for (let k = 0; k < g.n; k++) {
    g.turn = (g.turn + 1) % g.n;
    if (!g.out.includes(g.turn)) return;
  }
}

// Current player plays pit `slot` (0-5). Returns false if the move is illegal.
function play(g, slot) {
  const me = g.turn, len = g.n * ROW, b = g.board, store = me * ROW + PITS;
  const start = me * ROW + slot;
  if (g.over || !Number.isInteger(slot) || slot < 0 || slot >= PITS || !b[start]) return false;

  let i = start;
  for (;;) {
    let hand = b[i];
    b[i] = 0;
    while (hand) {
      i = (i + 1) % len;
      if (i % ROW === PITS && i !== store) continue; // skip other players' stores
      b[i]++;
      hand--;
    }
    // avalanche: landing on a non-empty pit picks it up and keeps going
    if (g.mode === 'avalanche' && i !== store && b[i] > 1) continue;
    break;
  }

  // capture: last stone in my own empty pit takes the mirrored pit of every opponent
  if (g.mode === 'capture' && i !== store && Math.floor(i / ROW) === me && b[i] === 1) {
    const mirror = PITS - 1 - (i % ROW);
    const targets = [];
    for (let p = 0; p < g.n; p++) if (p !== me && b[p * ROW + mirror]) targets.push(p * ROW + mirror);
    if (targets.length) {
      for (const t of [...targets, i]) { b[store] += b[t]; b[t] = 0; }
    }
  }

  g.last = start;

  // game ends when any side is empty; everyone banks what is left on their own side
  const empty = p => b.slice(p * ROW, p * ROW + PITS).every(x => !x);
  if ([...Array(g.n).keys()].some(empty)) {
    for (let p = 0; p < g.n; p++)
      for (let s = 0; s < PITS; s++) { b[p * ROW + PITS] += b[p * ROW + s]; b[p * ROW + s] = 0; }
    g.over = true;
    return true;
  }

  if (i !== store) nextTurn(g); // ending in your own store = go again
  return true;
}
