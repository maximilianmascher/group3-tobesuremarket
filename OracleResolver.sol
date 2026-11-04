// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  OracleResolver
 * @notice Bonus module for TobesureMarket (Group 3): lets a Chainlink price feed, not a person, decide a market.
 *
 * How it works
 *  - The resolver contract creates a market on TobesureMarket, so the resolver itself is the market creator.
 *  - Each market stores a price threshold and a resolve time ("Will ETH/USD be above $X at time T?").
 *  - After T, ANYONE can call resolve(id). The contract reads the latest Chainlink price, checks it is valid and
 *    fresh, and resolves YES if price > threshold, otherwise NO. No human chooses the outcome.
 *  - The 1% creator fee is paid to this contract; the owner can withdraw it.
 *
 * The core TobesureMarket contract is unchanged and already deployed; this module only uses its public functions.
 */

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface ITobesureMarket {
    function createMarket(string calldata question, uint256 durationSeconds) external returns (uint256);
    function resolveMarket(uint256 marketId, uint8 outcome) external; // enum Outcome is encoded as uint8 (1 = YES, 2 = NO)
}

contract OracleResolver {
    struct OracleMarket {
        int256 threshold;        // in feed units (e.g. 8 decimals: $3,500.00 = 350000000000)
        uint256 resolveAfter;    // unix time; equals the market's betting deadline
        bool resolved;
        int256 finalPrice;       // price used for resolution
        uint256 priceUpdatedAt;  // when Chainlink last updated that price
    }

    ITobesureMarket public immutable market;
    AggregatorV3Interface public immutable priceFeed;
    address public owner;
    uint256 public maxStaleness; // a price older than this (seconds) is rejected

    mapping(uint256 => OracleMarket) public oracleMarkets;
    uint256[] public marketIds;

    event OracleMarketCreated(uint256 indexed marketId, string question, int256 threshold, uint256 resolveAfter);
    event OracleResolved(uint256 indexed marketId, int256 price, uint256 priceUpdatedAt, bool yesWins, address triggeredBy);
    event FeesWithdrawn(address to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address market_, address priceFeed_, uint256 maxStaleness_) {
        require(market_ != address(0) && priceFeed_ != address(0), "Zero address");
        market = ITobesureMarket(market_);
        priceFeed = AggregatorV3Interface(priceFeed_);
        owner = msg.sender;
        maxStaleness = maxStaleness_;
    }

    /// @notice Open a price market on TobesureMarket. Betting closes, and resolution opens, after `durationSeconds`.
    function createPriceMarket(string calldata question, int256 threshold, uint256 durationSeconds)
        external
        onlyOwner
        returns (uint256 marketId)
    {
        require(threshold > 0, "Threshold must be > 0");
        marketId = market.createMarket(question, durationSeconds);
        oracleMarkets[marketId] = OracleMarket({
            threshold: threshold,
            resolveAfter: block.timestamp + durationSeconds,
            resolved: false,
            finalPrice: 0,
            priceUpdatedAt: 0
        });
        marketIds.push(marketId);
        emit OracleMarketCreated(marketId, question, threshold, block.timestamp + durationSeconds);
    }

    /// @notice Anyone can trigger resolution once the deadline has passed. The outcome comes from Chainlink.
    function resolve(uint256 marketId) external {
        OracleMarket storage om = oracleMarkets[marketId];
        require(om.resolveAfter != 0, "Not an oracle market");
        require(!om.resolved, "Already resolved");
        require(block.timestamp >= om.resolveAfter, "Too early");

        (int256 price, uint256 updatedAt) = _validatedPrice();
        bool yesWins = price > om.threshold;

        om.resolved = true;
        om.finalPrice = price;
        om.priceUpdatedAt = updatedAt;

        market.resolveMarket(marketId, yesWins ? 1 : 2);
        emit OracleResolved(marketId, price, updatedAt, yesWins, msg.sender);
    }

    /// @notice Current oracle price, with the same validity checks used for resolution.
    function latestPrice() external view returns (int256 price, uint256 updatedAt) {
        return _validatedPrice();
    }

    function marketCount() external view returns (uint256) {
        return marketIds.length;
    }

    /// @notice Creator fees (1% of each pool) arrive here; the owner can collect them.
    function withdrawFees() external onlyOwner {
        uint256 amount = address(this).balance;
        require(amount > 0, "Nothing to withdraw");
        (bool ok, ) = payable(owner).call{value: amount}("");
        require(ok, "Withdraw failed");
        emit FeesWithdrawn(owner, amount);
    }

    function setMaxStaleness(uint256 seconds_) external onlyOwner {
        maxStaleness = seconds_;
    }

    receive() external payable {}

    function _validatedPrice() private view returns (int256 price, uint256 updatedAt) {
        (uint80 roundId, int256 answer, , uint256 updated, uint80 answeredInRound) = priceFeed.latestRoundData();
        require(answer > 0, "Invalid price");
        require(updated != 0 && answeredInRound >= roundId, "Incomplete round");
        require(block.timestamp - updated <= maxStaleness, "Stale price");
        return (answer, updated);
    }
}
