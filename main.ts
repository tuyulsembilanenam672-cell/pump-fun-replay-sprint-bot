// Pump.fun Replay Sprint — Paper Bot, Real Ranking
// Deterministic selective momentum grinder (24h window, 10 SOL paper capital).
//
// Strategy: enter only coins still rising near their own peak (price +2% to +50%
// over creation, within 5% of the peak since creation, >=8 recorded buys, real
// reserve >= 3 SOL, age <= 3000 slots). One round trip per coin, 0.02 SOL per
// buy, max 5 open positions. Exit on +15% take-profit, -10% stop-loss, a
// trailing stop (-6% under peak once up +4%), or a 400-slot hold timeout.
// Fully deterministic: every decision comes from the harness state and the
// slot number only — no clock, no environment, no unseeded randomness.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, BotState } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- parameters
const P = {
  buyLamports: 20_000_000n, // 0.02 SOL per buy
  minBuys: 8, // recorded buys on the coin before entry
  minRealReserveLamports: 3_000_000_000n, // 3 SOL real reserve
  maxAgeSlots: 3000,
  minGainBps: 200, // +2% over creation price
  maxGainBps: 5000, // +50% over creation price
  nearPeakBps: 500, // within 5% of the peak since creation
  takeProfitBps: 1500, // +15%
  stopLossBps: 1000, // -10%
  trailArmBps: 400, // trailing stop arms once up +4%
  trailDropBps: 600, // sell at -6% under the peak since entry
  holdSlots: 400,
  slippageBps: 500,
};

// ---------------------------------------------------------------- per-mint state
interface MintStats {
  createdSlot: number;
  createPrice: number; // SOL per token at creation (virtual reserves ratio)
  peakPrice: number; // highest price seen since creation
  buys: number; // TradeEvents with is_buy seen on this mint
}

interface Entry {
  price: number; // effective entry price (SOL per token) from the buy fill
  slot: number; // slot the buy filled at
  peak: number; // highest price seen since entry
}

const stats = new Map<string, MintStats>();
const entries = new Map<string, Entry>();
const pendingSells = new Set<string>();
const traded = new Set<string>(); // mints ever bought: one round trip per coin

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

// (num / den - 1) in basis points, as a float.
function gainBps(num: number, den: number): number {
  return (num / den - 1) * 10000;
}

// ---------------------------------------------------------------- bot loop
await runBot({
  onBatch(state: BotState, batch: Batch) {
    const orders: import('./vendor/makefun-bot.ts').OrderInput[] = [];

    // 1. Fold this batch's events into per-mint stats.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const s: MintStats = stats.get(e.mint) ?? { createdSlot: e.slot, createPrice: 0, peakPrice: 0, buys: 0 };
        s.createdSlot = e.slot;
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (s.createPrice === 0) s.createPrice = p;
        if (p > s.peakPrice) s.peakPrice = p;
        stats.set(e.mint, s);
      } else if (e.event === 'TradeEvent') {
        const c = state.curves.get(e.mint);
        if (c === undefined) continue;
        const s: MintStats = stats.get(e.mint) ?? {
          createdSlot: c.created_slot ?? batch.slot,
          createPrice: 0,
          peakPrice: 0,
          buys: 0,
        };
        const p = priceOf(c.virtual_quote_reserves, c.virtual_token_reserves);
        if (s.createPrice === 0) s.createPrice = p;
        if (p > s.peakPrice) s.peakPrice = p;
        if (e.is_buy) s.buys += 1;
        stats.set(e.mint, s);
      }
    }

    // 2. Fold fills: record entry prices on buy fills, clear state on sell fills.
    for (const f of batch.fills) {
      if (f.status === 'rejected') {
        if (f.side === 'sell') pendingSells.delete(f.mint);
        continue;
      }
      if (f.status !== 'filled') continue; // failed tx: nothing traded
      if (f.side === 'buy') {
        const tokens = BigInt(f.token_amount);
        const quote = BigInt(f.quote_lamports);
        if (tokens > 0n) {
          const price = Number(quote) / Number(tokens);
          entries.set(f.mint, { price, slot: f.slot, peak: price });
          traded.add(f.mint);
        }
      } else {
        entries.delete(f.mint);
        pendingSells.delete(f.mint);
      }
    }

    // 3. Drop entry records for positions the harness already closed.
    for (const mint of [...entries.keys()]) {
      if (!state.positions.has(mint)) entries.delete(mint);
    }

    // 4. Exits: take-profit, stop-loss, trailing stop, hold timeout.
    for (const [mint, pos] of state.positions) {
      if (pendingSells.has(mint)) continue;
      const en = entries.get(mint);
      const c = state.curves.get(mint);
      if (en === undefined || c === undefined || c.complete) continue;
      const p = priceOf(c.virtual_quote_reserves, c.virtual_token_reserves);
      if (p <= 0) continue;
      if (p > en.peak) en.peak = p;
      const g = gainBps(p, en.price);
      const dropFromPeakBps = (1 - p / en.peak) * 10000;
      let exit = false;
      if (g >= P.takeProfitBps) exit = true;
      else if (g <= -P.stopLossBps) exit = true;
      else if (g >= P.trailArmBps && dropFromPeakBps >= P.trailDropBps) exit = true;
      else if (batch.slot - en.slot >= P.holdSlots) exit = true;
      if (exit) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: P.slippageBps });
        pendingSells.add(mint);
      }
    }

    // 5. Entries: only mints touched by this batch's events.
    const seen = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'CompleteEvent') continue;
      const mint = e.mint;
      if (seen.has(mint)) continue;
      seen.add(mint);
      if (state.positions.has(mint) || traded.has(mint)) continue;
      if (state.committedPositionCount() >= state.hello.caps.max_open_positions) continue;
      const c = state.curves.get(mint);
      const s = stats.get(mint);
      if (c === undefined || s === undefined || c.complete) continue;
      if (s.buys < P.minBuys) continue;
      if (c.real_quote_reserves < P.minRealReserveLamports) continue;
      const age = batch.slot - s.createdSlot;
      if (age < 0 || age > P.maxAgeSlots) continue;
      const p = priceOf(c.virtual_quote_reserves, c.virtual_token_reserves);
      if (p <= 0 || s.createPrice <= 0) continue;
      const g = gainBps(p, s.createPrice);
      if (g < P.minGainBps || g > P.maxGainBps) continue;
      if (p < s.peakPrice * (1 - P.nearPeakBps / 10000)) continue;
      let pendingBuy = false;
      for (const po of state.pending.values()) {
        if (po.order.side === 'buy' && po.order.mint === mint) {
          pendingBuy = true;
          break;
        }
      }
      if (pendingBuy) continue;
      const cap = state.maxBuyLamports(mint);
      const size = P.buyLamports < cap ? P.buyLamports : cap;
      if (size <= 0n) continue;
      if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
      orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: P.slippageBps });
    }

    return orders;
  },

  onDone(state: BotState) {
    const cashSol = Number(state.cash) / Number(LAMPORTS_PER_SOL);
    console.error(`done: cash ${cashSol.toFixed(4)} SOL, positions ${state.positions.size}, coins traded ${traded.size}`);
  },
});
