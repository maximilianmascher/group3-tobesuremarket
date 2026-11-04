// TobesureMarket frontend — configuration (Group 3)
// Everything in this file is PUBLIC: contract addresses, ABIs, RPC URLs.
// Never put a private key or an Infura key into any frontend file.

window.TOBESURE_CONFIG = Object.assign({
  chainId: 11155111,                      // Sepolia
  chainName: "Sepolia",
  explorer: "https://sepolia.etherscan.io",

  // Our deployed contract (deploy tx 0xfc8ea73f…, block 12050936)
  marketAddress: "0xe4cE7A7C30241596A9B21DF477A1CcC518c54b6F",
  deployBlock: 12050936,

  // Optional: OracleResolver address(es). Not required — the page detects oracle
  // markets automatically (a market whose creator is an OracleResolver contract).
  oracleAddresses: [],

  // Public read-only RPCs, used when no wallet is connected (first one that answers wins)
  readRpcUrls: [
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://sepolia.drpc.org",
    "https://rpc.sepolia.org"
  ],

  pollMs: 4000,          // how often we check for a new block
  lowBalanceEth: 0.002,  // warn below this
  defaultBetEth: "0.001"
}, window.__TOBESURE_TEST__ || {});

// ── ABIs (human-readable). One line per function the page uses. ──
window.TOBESURE_ABI = {
  market: [
    // reads
    "function owner() view returns (address)",
    "function platformFeeBps() view returns (uint256)",
    "function creatorFeeBps() view returns (uint256)",
    "function marketCount() view returns (uint256)",
    "function getMarket(uint256 marketId) view returns (tuple(string question, address creator, uint256 deadline, uint256 yesPool, uint256 noPool, uint8 outcome, bool resolved))",
    "function yesProbabilityBps(uint256 marketId) view returns (uint256)",
    "function getBettors(uint256 marketId) view returns (address[])",
    "function yesStake(uint256 marketId, address user) view returns (uint256)",
    "function noStake(uint256 marketId, address user) view returns (uint256)",
    "function paidOut(uint256 marketId, address user) view returns (uint256)",
    "function pendingWithdrawals(address user) view returns (uint256)",
    // writes
    "function createMarket(string question, uint256 durationSeconds) returns (uint256)",
    "function placeBet(uint256 marketId, bool isYes) payable",
    "function resolveMarket(uint256 marketId, uint8 outcome)",
    "function withdraw()",
    // events
    "event MarketCreated(uint256 indexed marketId, address indexed creator, string question, uint256 deadline)",
    "event BetPlaced(uint256 indexed marketId, address indexed bettor, bool isYes, uint256 amount)",
    "event MarketResolved(uint256 indexed marketId, uint8 outcome, uint256 totalPool, uint256 platformFee, uint256 creatorFee)",
    "event FeePaid(uint256 indexed marketId, address indexed to, uint256 amount, bool isPlatformFee)",
    "event Payout(uint256 indexed marketId, address indexed to, uint256 amount)",
    "event PayoutDeferred(address indexed to, uint256 amount)",
    "event Withdrawn(address indexed to, uint256 amount)"
  ],
  oracle: [
    "function market() view returns (address)",
    "function priceFeed() view returns (address)",
    "function maxStaleness() view returns (uint256)",
    "function oracleMarkets(uint256 marketId) view returns (int256 threshold, uint256 resolveAfter, bool resolved, int256 finalPrice, uint256 priceUpdatedAt)",
    "function resolve(uint256 marketId)",
    "event OracleMarketCreated(uint256 indexed marketId, string question, int256 threshold, uint256 resolveAfter)",
    "event OracleResolved(uint256 indexed marketId, int256 price, uint256 priceUpdatedAt, bool yesWins, address triggeredBy)"
  ],
  feed: [
    "function decimals() view returns (uint8)",
    "function description() view returns (string)",
    "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"
  ]
};
