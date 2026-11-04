# TobesureMarket — a Polymarket-style prediction market on Sepolia

**Group 3 · Blockchain & Decentralized Systems · IE MDBI** — Ben, Ale, Sarita, Anthony, Max

**Live website:** open the GitHub Pages link of this repository (Settings → Pages). It works in any browser:
without a wallet you can watch the markets, odds, bets and payouts live; with MetaMask on Sepolia you can bet.

**Contract on Sepolia:** [`0xe4cE7A7C30241596A9B21DF477A1CcC518c54b6F`](https://sepolia.etherscan.io/address/0xe4cE7A7C30241596A9B21DF477A1CcC518c54b6F)

## What it does
- Anyone creates a YES/NO market with a betting deadline: `createMarket(question, durationSeconds)`
- Anyone bets test ETH on YES or NO before the deadline: `placeBet(marketId, isYes)` (payable, min 0.0001 ETH)
- The creator or the platform resolves it: `resolveMarket(marketId, outcome)` — in the same transaction the contract pays
  2% to the platform, 1% to the creator and 97% to the winners **pro rata to their stake** (pari-mutuel pool)
- INVALID outcome, or nobody on the winning side → everyone is refunded, no fees
- Bonus: `OracleResolver` lets a **Chainlink price feed** decide a market — after the deadline anyone calls `resolve(marketId)`,
  the contract reads the price and resolves YES if price > threshold. No human picks the winner.

## Repository
| Path | Content |
|---|---|
| `index.html`, `app.js`, `style.css`, `config.js`, `members.js`, `vendor/` | The website (plain HTML/JS + ethers.js v6, no backend) |
| `contracts/TobesureMarket.sol` | The prediction market contract (Solidity 0.8.20) |
| `contracts/OracleResolver.sol` | Bonus: Chainlink oracle resolution |
| `notebooks/Group3_TobesureMarket_Sepolia.ipynb` | Deploy, create market, all members bet, resolve, payouts (via Infura) |
| `notebooks/Group3_Oracle_Bonus.ipynb` | Deploy the oracle module and resolve a market with Chainlink |
| `notebooks/Group3_Frontend.ipynb` | Run the website locally |
| `proof/` | Transaction hashes of the Sepolia run (deploy, market, 5 bets, resolution) |

## Security
- No private key or Infura key is in this repository. The website never holds keys: every transaction is signed by the user in MetaMask.
- All rules (deadline, minimum bet, who may resolve, fee cap 10%, max 200 bettors) are enforced by the contract, not the website.
- Reentrancy guard + checks-effects-interactions; failed payouts fall back to `withdraw()` so one bad recipient cannot block a market.
