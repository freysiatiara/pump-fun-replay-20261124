// Tide — a selective launch-breakout paper bot for agent-fun/replay/v2.
//
// Thesis (measured on the kit's frozen dev window, 1,222 coins / 24h):
//   * Buying every launch loses: the average coin mean-reverts within ~100 slots
//     of creation and the ~2.7% round-trip fee (1.25% curve each way + tx fees)
//     eats the small edge. Loose launch-sniping backtests at about -0.43 SOL.
//   * Selectivity is the only lever that moved the needle: requiring >=5 trades
//     plus live buy flow (recent distinct buyers, positive net flow) before entry
//     took the same engine from -0.43 SOL to ~0.00 SOL. Dip-buying (-0.30..-4.02)
//     and naive momentum (-9.39) are far worse, and chasing deep coins fails
//     because the 2-slot latency means the pump wave is over by the fill.
//   * So Tide trades rarely and only while the wave is provably alive: a young
//     coin (>=5 trades, >=2 distinct buyers, creator not sold, no big sells)
//     whose price is making a fresh 30-slot high on positive recent net flow.
//   * Exits are fast and mechanical: +10% take-profit, -5% stop, a +3%-armed
//     3% trailing stop to bank partial runs, 300-slot max hold, instant exit
//     when the creator sells, 600-slot stale exit. One buy per coin, no adds,
//     no splitting (each extra order burns a fixed 105k-lamport tx fee).
//   * Stake is 0.1 SOL per coin, at most 5 open; most of the 10 SOL stays cash.
//
// Pure function of the batches it is fed: no clock, no randomness, no I/O,
// no network. All comparisons are BigInt cross-multiplications, so the two
// graded executions agree byte for byte.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest / oldest age (slots since create) at which a first buy may be decided. */
  minAge: number;
  maxAge: number;
  /** Lamports to spend per coin (each buy still capped at 1% of real SOL). */
  stakeLamports: bigint;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: bigint;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: bigint;
  maxRealSol: bigint;
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuy: bigint;
  maxDevBuy: bigint;
  /** Trades seen and distinct (non-creator) buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Distinct non-creator buyers before entry, at most (a launch bundled by many wallets is a dump in waiting). */
  maxBuyers: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: bigint;
  /** The recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowLamports: bigint;
  minRecentBuyers: number;
  /** Breakout window (slots): entry needs the price at its high over this window. */
  highWindow: number;
  /** Price now over the create price, as a ratio in bps (20000 = 2x), at most. */
  maxRunupBps: bigint;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: bigint;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: bigint;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: bigint;
  trailBps: bigint;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 120,
  stakeLamports: 100_000_000n,
  minBuyLamports: 20_000_000n,
  minRealSol: 500_000_000n,
  maxRealSol: 50_000_000_000n,
  minDevBuy: 0n,
  maxDevBuy: 2_500_000_000n,
  minTrades: 5,
  minBuyers: 2,
  maxBuyers: 4,
  maxBigSellBps: 500n,
  flowWindow: 10,
  minFlowLamports: 1n,
  minRecentBuyers: 2,
  highWindow: 30,
  maxRunupBps: 20000n,
  skipDevSold: true,
  buySlippageBps: 500,
  tpBps: 1000n,
  slBps: 500n,
  trailArmBps: 300n,
  trailBps: 300n,
  maxHold: 300,
  exitOnDevSell: true,
  staleSlots: 600,
};

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
  /** Post-trade reserves (price = vq / vt). */
  vq: bigint;
  vt: bigint;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** The create-time reserves: the run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  devSold: boolean;
  bigSellBps: bigint;
  lastTradeSlot: number;
  /** Trades in the recent window (older ones dropped as new ones come). */
  recent: Tick[];
  buysSent: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** SOL paid for the tokens still held: buy fills (curve fees included) + tx fees. */
  paid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) would pay after curve fees (protocol + creator, 95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          devSold: false,
          bigSellBps: 0n,
          lastTradeSlot: e.slot,
          recent: [],
          buysSent: 0,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({
          slot: e.slot,
          isBuy: e.is_buy,
          sol,
          user: e.user,
          vq: BigInt(e.virtual_quote_reserves),
          vt: BigInt(e.virtual_token_reserves),
        });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold and the distinct buyers, over the last flowWindow slots. */
  function flow(c: Coin, slot: number): { net: bigint; buyers: number } {
    const from = slot - P.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else net -= t.sol;
    }
    return { net, buyers: buyers.size };
  }

  /** Highest price (vq/vt) seen over the last highWindow slots, as a (vq, vt) pair. */
  function windowHigh(c: Coin, slot: number): { vq: bigint; vt: bigint } | null {
    const from = slot - P.highWindow;
    let best: { vq: bigint; vt: bigint } | null = null;
    for (const t of c.recent) {
      if (t.slot <= from) continue;
      if (best === null || t.vq * best.vt > best.vq * t.vt) best = { vq: t.vq, vt: t.vt };
    }
    return best;
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      // Fold fills: track what each position really cost, and drop closed positions.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.side === 'buy' && f.status === 'filled') {
          const h = held.get(f.mint);
          const paid = BigInt(f.quote_lamports) + BigInt(f.tx_fee_lamports);
          if (h === undefined) {
            held.set(f.mint, {
              openedSlot: f.slot,
              paid,
              best: 0n,
              devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
            });
          } else {
            h.paid += paid;
          }
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      // Exits first: every held position is re-priced every batch.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, paid: pos.cost_lamports + tx, best: 0n, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = h.paid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + P.tpBps)) exit = true;
          if (value * BPS <= basis * (BPS - P.slBps)) exit = true;
          if (h.best * BPS >= basis * (BPS + P.trailArmBps) && value * BPS <= h.best * (BPS - P.trailBps)) exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined) {
          if (P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: one buy per coin, only while the wave is provably alive.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        if (c.buysSent > 0) continue;
        const age = state.slot - c.createSlot;
        if (age > P.maxAge) {
          c.done = true;
          continue;
        }
        if (age < P.minAge) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && P.skipDevSold) {
          c.done = true;
          continue;
        }
        // Rug and bundle filters.
        const rq = curve.real_quote_reserves;
        if (rq < P.minRealSol || rq > P.maxRealSol) continue;
        if (c.devBuy < P.minDevBuy || c.devBuy > P.maxDevBuy) continue;
        if (c.trades < P.minTrades || c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) continue;
        if (c.bigSellBps > P.maxBigSellBps) continue;
        // Run-up guard: do not chase a launch that already pumped past 2x create.
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (vq * c.vt0 * BPS > P.maxRunupBps * vt * c.vq0) continue;
        // The wave must be alive right now: positive recent net flow, fresh buyers...
        const fl = flow(c, state.slot);
        if (fl.net < P.minFlowLamports || fl.buyers < P.minRecentBuyers) continue;
        // ...and the price must be making a fresh high over the breakout window.
        const high = windowHigh(c, state.slot);
        if (high !== null && vq * high.vt < high.vq * vt) continue;
        // Size: the stake, capped at 1% of real SOL, never below the guardrail minimum.
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = P.stakeLamports < maxBuy ? P.stakeLamports : maxBuy;
        if (amount < P.minBuyLamports) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.buysSent += 1;
        open += 1;
      }
      return orders;
    },
  };
}
