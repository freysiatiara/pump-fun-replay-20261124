[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/freysiatiara/pump-fun-replay-20261124/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/freysiatiara/pump-fun-replay-20261124/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Tide — Pump.fun Replay Sprint paper bot

A deterministic, selective launch-breakout bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on make.fun. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve data. Paper money only — nothing here trades for real.

## Strategy

Measured on the kit's frozen dev window (1,222 coins / 24h), buying every launch loses: coins mean-revert within ~100 slots of creation and the ~2.7% round-trip fee eats the edge. Dip-buying and naive momentum are worse. So Tide trades rarely, only while the wave is provably alive:

- **Entry (age ≤ 120 slots):** ≥5 trades, ≥2 distinct non-creator buyers (≤4 — bundled launches are dumps in waiting), real SOL 0.5–50, creator hasn't sold, creator's own buy ≤ 2.5 SOL, no single sell > 5% of real reserves, positive net flow with ≥2 fresh buyers in the last 10 slots, price making a fresh 30-slot high, run-up ≤ 2× create price.
- **Stake:** 0.1 SOL per coin (capped at 1% of real SOL), max 5 open positions, one buy per coin, no adds, no order splitting — every extra order burns a fixed 105k-lamport tx fee.
- **Exits:** +10% take-profit, −5% stop, +3%-armed 3% trailing stop, 300-slot max hold, instant exit when the creator sells, 600-slot stale exit.

Deterministic: a pure function of the batches it is fed — no clock, no randomness, no I/O, no network. All price comparisons are BigInt cross-multiplications, so the two graded executions agree byte for byte.

## Run

```sh
node main.ts
```

Node 22.18+ runs the TypeScript as-is (the grader runs Node 22.23.4). Zero dependencies.
