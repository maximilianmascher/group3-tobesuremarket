
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  TobesureMarket
 * @notice Binary (YES / NO) prediction markets paid in ETH — Group 3, Blockchain & Decentralized Systems (IE MDBI).
 *
 * Model: pari-mutuel pool (inspired by Polymarket, simplified).
 *  - Anyone can create a market with a question and a betting deadline.
 *  - Anyone can bet test ETH on YES or NO until the deadline.
 *  - The market creator (or the platform owner as fallback arbiter) resolves the outcome.
 *  - On resolution the contract automatically:
 *        1. pays the platform fee to the platform owner,
 *        2. pays the creator fee to the market creator,
 *        3. splits the remaining pool among winning bettors, pro rata to their stake.
 *  - If the outcome is INVALID, or nobody bet on the winning side, everyone is refunded and no fees are charged.
 *  - Any transfer that fails (e.g. a contract wallet that rejects ETH) is credited to a pull-withdrawal
 *    balance, so one bad recipient can never block the whole market.
 */
contract TobesureMarket {
    // ─────────────────────────────── Types ───────────────────────────────
    enum Outcome { Unresolved, Yes, No, Invalid }

    struct Market {
        string  question;
        address creator;
        uint256 deadline;      // betting closes at this timestamp
        uint256 yesPool;       // total wei staked on YES
        uint256 noPool;        // total wei staked on NO
        Outcome outcome;
        bool    resolved;
    }

    // ───────────────────────────── Constants ─────────────────────────────
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 1_000;      // fees can never exceed 10% combined
    uint256 public constant MAX_BETTORS = 200;        // bounds the payout loop's gas cost
    uint256 public constant MIN_BET = 0.0001 ether;

    // ───────────────────────────── Storage ───────────────────────────────
    address public owner;                 // the platform
    uint256 public platformFeeBps;        // e.g. 200 = 2%
    uint256 public creatorFeeBps;         // e.g. 100 = 1%
    uint256 public marketCount;

    mapping(uint256 => Market) public markets;
    mapping(uint256 => mapping(address => uint256)) public yesStake;
    mapping(uint256 => mapping(address => uint256)) public noStake;
    mapping(uint256 => address[]) private bettors;
    mapping(uint256 => mapping(address => bool)) private isBettor;
    mapping(uint256 => mapping(address => uint256)) public paidOut;   // what each address received per market

    mapping(address => uint256) public pendingWithdrawals;            // fallback for failed pushes

    bool private locked;

    // ───────────────────────────── Events ────────────────────────────────
    event MarketCreated(uint256 indexed marketId, address indexed creator, string question, uint256 deadline);
    event BetPlaced(uint256 indexed marketId, address indexed bettor, bool isYes, uint256 amount);
    event MarketResolved(uint256 indexed marketId, Outcome outcome, uint256 totalPool, uint256 platformFee, uint256 creatorFee);
    event FeePaid(uint256 indexed marketId, address indexed to, uint256 amount, bool isPlatformFee);
    event Payout(uint256 indexed marketId, address indexed to, uint256 amount);
    event PayoutDeferred(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event FeesUpdated(uint256 platformFeeBps, uint256 creatorFeeBps);

    // ──────────────────────────── Modifiers ──────────────────────────────
    modifier onlyOwner() {
        require(msg.sender == owner, "Not platform owner");
        _;
    }

    modifier nonReentrant() {
        require(!locked, "Reentrancy");
        locked = true;
        _;
        locked = false;
    }

    modifier marketExists(uint256 marketId) {
        require(marketId < marketCount, "Market does not exist");
        _;
    }

    // ─────────────────────────── Constructor ─────────────────────────────
    constructor(uint256 _platformFeeBps, uint256 _creatorFeeBps) {
        require(_platformFeeBps + _creatorFeeBps <= MAX_FEE_BPS, "Fees too high");
        owner = msg.sender;
        platformFeeBps = _platformFeeBps;
        creatorFeeBps = _creatorFeeBps;
        emit FeesUpdated(_platformFeeBps, _creatorFeeBps);
    }

    // ──────────────────────────── Core logic ─────────────────────────────

    /// @notice Open a new YES/NO market. Betting stays open for `durationSeconds`.
    function createMarket(string calldata question, uint256 durationSeconds) external returns (uint256 marketId) {
        require(bytes(question).length > 0, "Empty question");
        require(durationSeconds > 0, "Duration must be > 0");

        marketId = marketCount++;
        Market storage m = markets[marketId];
        m.question = question;
        m.creator = msg.sender;
        m.deadline = block.timestamp + durationSeconds;

        emit MarketCreated(marketId, msg.sender, question, m.deadline);
    }

    /// @notice Stake ETH on YES (`isYes = true`) or NO (`isYes = false`).
    function placeBet(uint256 marketId, bool isYes) external payable marketExists(marketId) {
        Market storage m = markets[marketId];
        require(!m.resolved, "Market resolved");
        require(block.timestamp < m.deadline, "Betting closed");
        require(msg.value >= MIN_BET, "Bet below minimum");

        if (!isBettor[marketId][msg.sender]) {
            require(bettors[marketId].length < MAX_BETTORS, "Bettor limit reached");
            isBettor[marketId][msg.sender] = true;
            bettors[marketId].push(msg.sender);
        }

        if (isYes) {
            m.yesPool += msg.value;
            yesStake[marketId][msg.sender] += msg.value;
        } else {
            m.noPool += msg.value;
            noStake[marketId][msg.sender] += msg.value;
        }

        emit BetPlaced(marketId, msg.sender, isYes, msg.value);
    }

    /// @notice Settle the market and distribute all funds. Callable by the market creator or the platform owner.
    function resolveMarket(uint256 marketId, Outcome outcome) external nonReentrant marketExists(marketId) {
        Market storage m = markets[marketId];
        require(msg.sender == m.creator || msg.sender == owner, "Not creator or owner");
        require(!m.resolved, "Already resolved");
        require(outcome != Outcome.Unresolved, "Invalid outcome value");

        // Effects first (checks-effects-interactions)
        m.resolved = true;
        m.outcome = outcome;

        uint256 total = m.yesPool + m.noPool;
        uint256 winningPool = outcome == Outcome.Yes ? m.yesPool : (outcome == Outcome.No ? m.noPool : 0);
        address[] storage list = bettors[marketId];

        // Refund path: INVALID outcome, or nobody backed the winning side → return stakes, no fees.
        if (outcome == Outcome.Invalid || winningPool == 0) {
            emit MarketResolved(marketId, outcome, total, 0, 0);
            for (uint256 i = 0; i < list.length; i++) {
                address b = list[i];
                uint256 stake = yesStake[marketId][b] + noStake[marketId][b];
                if (stake > 0) _pay(marketId, b, stake);
            }
            return;
        }

        uint256 platformFee = (total * platformFeeBps) / BPS;
        uint256 creatorFee = (total * creatorFeeBps) / BPS;
        uint256 distributable = total - platformFee - creatorFee;

        emit MarketResolved(marketId, outcome, total, platformFee, creatorFee);

        // Pay winners pro rata; track what was actually sent so rounding dust is accounted for.
        uint256 distributed;
        for (uint256 i = 0; i < list.length; i++) {
            address b = list[i];
            uint256 stake = outcome == Outcome.Yes ? yesStake[marketId][b] : noStake[marketId][b];
            if (stake == 0) continue;
            uint256 share = (stake * distributable) / winningPool;
            distributed += share;
            _pay(marketId, b, share);
        }

        // Rounding dust goes to the platform so the contract never keeps stray wei.
        platformFee += distributable - distributed;

        if (creatorFee > 0) {
            _sendFee(marketId, m.creator, creatorFee, false);
        }
        if (platformFee > 0) {
            _sendFee(marketId, owner, platformFee, true);
        }
    }

    /// @notice Pull any payout that could not be pushed automatically.
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        pendingWithdrawals[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Withdraw failed");
        emit Withdrawn(msg.sender, amount);
    }

    // ───────────────────────────── Admin ─────────────────────────────────
    function setFees(uint256 _platformFeeBps, uint256 _creatorFeeBps) external onlyOwner {
        require(_platformFeeBps + _creatorFeeBps <= MAX_FEE_BPS, "Fees too high");
        platformFeeBps = _platformFeeBps;
        creatorFeeBps = _creatorFeeBps;
        emit FeesUpdated(_platformFeeBps, _creatorFeeBps);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }

    // ───────────────────────────── Views ─────────────────────────────────
    /// @notice Full market struct: (question, creator, deadline, yesPool, noPool, outcome, resolved).
    function getMarket(uint256 marketId) external view marketExists(marketId) returns (Market memory) {
        return markets[marketId];
    }

    function bettorCount(uint256 marketId) external view marketExists(marketId) returns (uint256) {
        return bettors[marketId].length;
    }

    /// @notice Implied probability of YES in basis points (5000 = 50%), Polymarket-style "price".
    function yesProbabilityBps(uint256 marketId) external view marketExists(marketId) returns (uint256) {
        Market storage m = markets[marketId];
        uint256 total = m.yesPool + m.noPool;
        if (total == 0) return 5_000;
        return (m.yesPool * BPS) / total;
    }

    /// @notice What `user` would receive if the market resolved to `outcome` right now (after fees).
    function previewPayout(uint256 marketId, address user, bool yesWins)
        external
        view
        marketExists(marketId)
        returns (uint256)
    {
        Market storage m = markets[marketId];
        uint256 total = m.yesPool + m.noPool;
        uint256 winningPool = yesWins ? m.yesPool : m.noPool;
        uint256 stake = yesWins ? yesStake[marketId][user] : noStake[marketId][user];
        if (winningPool == 0 || stake == 0) return 0;
        uint256 distributable = total - (total * (platformFeeBps + creatorFeeBps)) / BPS;
        return (stake * distributable) / winningPool;
    }

    function getBettors(uint256 marketId) external view marketExists(marketId) returns (address[] memory) {
        return bettors[marketId];
    }

    // ──────────────────────────── Internals ──────────────────────────────

    /// @dev Push ETH with a gas cap; if the recipient rejects it, credit a pull balance instead.
    function _pay(uint256 marketId, address to, uint256 amount) private {
        paidOut[marketId][to] += amount;
        (bool ok, ) = payable(to).call{value: amount, gas: 30_000}("");
        if (ok) {
            emit Payout(marketId, to, amount);
        } else {
            pendingWithdrawals[to] += amount;
            emit PayoutDeferred(to, amount);
        }
    }

    function _sendFee(uint256 marketId, address to, uint256 amount, bool isPlatform) private {
        (bool ok, ) = payable(to).call{value: amount, gas: 30_000}("");
        if (ok) {
            emit FeePaid(marketId, to, amount, isPlatform);
        } else {
            pendingWithdrawals[to] += amount;
            emit PayoutDeferred(to, amount);
        }
    }
}
