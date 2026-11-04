// TobesureMarket frontend — Group 3
// Plain JavaScript + ethers.js v6. No backend: the page reads the contract and asks MetaMask to sign.
// Each user action calls exactly one contract function (see the "ACTIONS" section).
(() => {
  "use strict";
  const E = window.ethers;
  const CFG = window.TOBESURE_CONFIG;
  const ABI = window.TOBESURE_ABI;
  const MEMBERS = {};
  for (const [a, n] of Object.entries(window.TOBESURE_MEMBERS || {})) MEMBERS[a.toLowerCase()] = n;

  const iMarket = new E.Interface(ABI.market);
  const iOracle = new E.Interface(ABI.oracle);
  const OUTCOME = ["Unresolved", "YES", "NO", "INVALID"];
  const HEX_CHAIN = "0x" + CFG.chainId.toString(16);

  const S = {
    pub: null,            // public read-only provider
    bp: null,             // MetaMask BrowserProvider
    signer: null,
    account: null,        // connected address (checksummed)
    chainOk: false,
    owner: null, feeBps: { p: 200n, c: 100n },
    markets: [],          // [{id, question, creator, deadline, yesPool, noPool, outcome, resolved, bettors, oracle}]
    selected: null,
    detail: null,         // stakes etc. for selected market
    oracleByCreator: {},  // creator(lowercase) -> bool
    feedInfo: {},         // oracle address -> {feedAddr, description, decimals, maxStaleness}
    price: {},            // feedAddr -> {answer, updatedAt}
    balances: {}, deltas: {},
    events: [], seen: new Set(), cursors: {}, chunk: 5000, blockTs: {},
    lastBlock: 0, refreshing: false, again: false, firstLoad: true,
    betEth: CFG.defaultBetEth,
  };

  // ────────────────────────── helpers ──────────────────────────
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lc = (a) => (a || "").toLowerCase();
  const short = (a) => a ? a.slice(0, 6) + "…" + a.slice(-4) : "";
  const eq = (a, b) => !!a && !!b && lc(a) === lc(b);
  function fmtEth(wei, dp = 5) {
    const n = Number(E.formatEther(wei ?? 0n));
    if (n === 0) return "0";
    let s = n.toFixed(dp);
    if (Number(s) === 0) s = n.toPrecision(2);
    return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }
  function signedEth(wei) { return (wei > 0n ? "+" : "−") + fmtEth(wei < 0n ? -wei : wei, 6); }
  function name(addr) {
    if (!addr) return "";
    const k = lc(addr);
    if (MEMBERS[k]) return MEMBERS[k];
    if (eq(addr, S.owner)) return "Platform";
    if (S.oracleByCreator[k]) return "Oracle contract";
    return short(addr);
  }
  const txLink = (h, label) => `<a href="${CFG.explorer}/tx/${h}" target="_blank" rel="noopener">${esc(label || short(h))} ↗</a>`;
  const addrLink = (a) => `<a href="${CFG.explorer}/address/${a}" target="_blank" rel="noopener">${esc(short(a))}</a>`;
  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec));
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  const now = () => Math.floor(Date.now() / 1000);
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  // Reads go through MetaMask when it is connected to Sepolia (same node MetaMask shows balances from),
  // otherwise through a public read-only RPC.
  const reader = () => (S.bp && S.chainOk) ? S.bp : S.pub;
  const marketRead = () => new E.Contract(CFG.marketAddress, ABI.market, reader());
  const oracleRead = (addr) => new E.Contract(addr, ABI.oracle, reader());

  // ────────────────────────── wallet discovery ──────────────────────────
  // Several wallet extensions can fight over window.ethereum. EIP-6963 lets each wallet announce itself,
  // so we pick MetaMask by name and ignore the others.
  const announced = [];
  window.addEventListener("eip6963:announceProvider", (e) => { if (e.detail && e.detail.provider) announced.push(e.detail); });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  let WALLET = null;
  function pickWallet() {
    const mm = announced.find((d) => /^io\.metamask/.test((d.info && d.info.rdns) || ""));
    if (mm) return mm.provider;
    const list = window.ethereum && window.ethereum.providers;
    if (Array.isArray(list)) { const p = list.find((x) => x.isMetaMask && !x.isBraveWallet); if (p) return p; }
    if (announced.length) return announced[0].provider;
    return window.ethereum || null;
  }
  const ask = (method, params, ms = 0) => {
    const p = WALLET.request(params ? { method, params } : { method });
    return ms ? withTimeout(p, ms) : p;
  };

  // ────────────────────────── providers ──────────────────────────
  async function initPublic() {
    const net = E.Network.from(CFG.chainId);
    for (const url of CFG.readRpcUrls) {
      try {
        const p = new E.JsonRpcProvider(url, net, { staticNetwork: net });
        await withTimeout(p.getBlockNumber(), 7000);
        return p;
      } catch (e) { console.warn("RPC not usable:", url, e.message); }
    }
    return null;
  }

  async function connect(silent = false) {
    if (S.connecting) return;
    S.connecting = true;
    try { await connectInner(silent); } finally { S.connecting = false; }
  }
  async function connectInner(silent) {
    if (location.protocol === "file:") {
      showBanner(`<b>Open the page through the notebook, not as a file.</b> MetaMask only works on a web address. Run cell 2 of <b>Group3_Frontend.ipynb</b> and use the <b>http://localhost:8000</b> tab it opens.`);
      return;
    }
    WALLET = WALLET || pickWallet();
    if (!WALLET) {
      if (!silent) showBanner(`MetaMask was not found in this browser. Install it from <a href="https://metamask.io" target="_blank" rel="noopener">metamask.io</a>, or open this page in the browser where MetaMask is installed. You can still watch the market without it.`);
      return;
    }
    try {
      const method = silent ? "eth_accounts" : "eth_requestAccounts";
      const accs = await ask(method, null, silent ? 4000 : 0);
      if (!accs || !accs.length) return;
      await ensureChain(silent);
      S.bp = new E.BrowserProvider(WALLET);
      await setAccount(accs[0]);
      if (!S._listening) {
        S._listening = true;
        WALLET.on?.("accountsChanged", (a) => a && a.length ? setAccount(a[0]).then(() => refresh(true)) : disconnect());
        WALLET.on?.("chainChanged", () => window.location.reload());
      }
      refresh(true);
    } catch (e) {
      if (!silent) toastError("Could not connect", e);
    }
  }
  async function ensureChain(silent) {
    const id = await ask("eth_chainId", null, 8000);
    S.chainOk = parseInt(id, 16) === CFG.chainId;
    if (S.chainOk || silent) return;
    try {
      await ask("wallet_switchEthereumChain", [{ chainId: HEX_CHAIN }]);
      S.chainOk = true;
    } catch (e) {
      showBanner(`MetaMask is on the wrong network. Switch it to <b>Sepolia</b> (network menu in MetaMask) and reload.`);
      throw e;
    }
  }
  async function setAccount(addr) {
    S.account = E.getAddress(addr);
    S.signer = await S.bp.getSigner(S.account);
    hideBanner();
    renderWalletBar();
  }
  // Opens MetaMask's account picker so all group accounts can be connected at once
  async function pickAccounts() {
    try {
      await ask("wallet_requestPermissions", [{ eth_accounts: {} }]);
      const accs = await ask("eth_accounts", null, 5000);
      if (accs && accs.length) { await setAccount(accs[0]); refresh(true); }
    } catch (e) { if (!(e?.code === 4001 || e?.code === "ACTION_REJECTED")) toastError("Could not change accounts", e); }
  }
  function disconnect() { S.account = null; S.signer = null; renderWalletBar(); renderDetail(); }

  // ────────────────────────── data loading ──────────────────────────
  async function loadMarkets() {
    const c = marketRead();
    const [count, owner, pf, cf] = await Promise.all([c.marketCount(), c.owner(), c.platformFeeBps(), c.creatorFeeBps()]);
    S.owner = owner; S.feeBps = { p: pf, c: cf };
    const ids = [...Array(Number(count)).keys()];
    const list = await Promise.all(ids.map(async (id) => {
      const [m, bettors] = await Promise.all([c.getMarket(id), c.getBettors(id)]);
      return { id, question: m.question, creator: m.creator, deadline: Number(m.deadline), yesPool: m.yesPool, noPool: m.noPool,
               outcome: Number(m.outcome), resolved: m.resolved, bettors: [...bettors] };
    }));
    // Oracle markets: the creator is an OracleResolver contract that knows this market id.
    await Promise.all(list.map(async (m) => {
      const k = lc(m.creator);
      if (S.oracleByCreator[k] === undefined) {
        const known = (CFG.oracleAddresses || []).some((a) => eq(a, m.creator));
        const code = known ? "0x01" : await reader().getCode(m.creator);
        S.oracleByCreator[k] = code !== "0x";
      }
      if (!S.oracleByCreator[k]) return;
      try {
        const om = await oracleRead(m.creator).oracleMarkets(m.id);
        if (om.resolveAfter > 0n) m.oracle = { address: m.creator, threshold: om.threshold, resolveAfter: Number(om.resolveAfter),
          resolved: om.resolved, finalPrice: om.finalPrice, priceUpdatedAt: Number(om.priceUpdatedAt) };
      } catch { S.oracleByCreator[k] = false; }
    }));
    S.markets = list;
    if (S.selected === null || S.selected >= list.length) S.selected = pickDefault();
  }
  function pickDefault() {
    const fromHash = /^#market-(\d+)$/.exec(location.hash);
    if (fromHash && Number(fromHash[1]) < S.markets.length) return Number(fromHash[1]);
    const open = [...S.markets].reverse().find((m) => !m.resolved && m.deadline > now());
    if (open) return open.id;
    return S.markets.length ? S.markets.length - 1 : null;
  }

  async function loadDetail() {
    const m = S.markets[S.selected];
    if (!m) { S.detail = null; return; }
    const c = marketRead();
    const people = [...m.bettors];
    const rows = await Promise.all(people.map(async (a) => {
      const [y, n, p] = await Promise.all([c.yesStake(m.id, a), c.noStake(m.id, a), c.paidOut(m.id, a)]);
      return { addr: a, yes: y, no: n, paid: p };
    }));
    let mine = { yes: 0n, no: 0n, pending: 0n };
    if (S.account) {
      const [y, n, p] = await Promise.all([c.yesStake(m.id, S.account), c.noStake(m.id, S.account), c.pendingWithdrawals(S.account)]);
      mine = { yes: y, no: n, pending: p };
    }
    const prob = Number(await c.yesProbabilityBps(m.id)) / 100;
    S.detail = { id: m.id, rows, mine, prob };
    if (m.oracle) await loadOracle(m.oracle.address);
  }

  async function loadOracle(addr) {
    const k = lc(addr);
    if (!S.feedInfo[k]) {
      const o = oracleRead(addr);
      const [feedAddr, maxStaleness] = await Promise.all([o.priceFeed(), o.maxStaleness()]);
      const f = new E.Contract(feedAddr, ABI.feed, reader());
      const [description, decimals] = await Promise.all([f.description().catch(() => "Chainlink price feed"), f.decimals()]);
      S.feedInfo[k] = { feedAddr, description, decimals: Number(decimals), maxStaleness: Number(maxStaleness) };
    }
    const info = S.feedInfo[k];
    try {
      const r = await new E.Contract(info.feedAddr, ABI.feed, reader()).latestRoundData();
      S.price[lc(info.feedAddr)] = { answer: r.answer, updatedAt: Number(r.updatedAt) };
    } catch (e) { console.warn("feed read failed", e); }
  }

  async function loadBalances() {
    const addrs = walletList().map((w) => w.addr);
    if (S.account && !addrs.some((a) => eq(a, S.account))) addrs.push(S.account);
    const vals = await Promise.all(addrs.map((a) => reader().getBalance(a).catch(() => null)));
    addrs.forEach((a, i) => {
      const k = lc(a), v = vals[i];
      if (v === null) return;
      const prev = S.balances[k];
      if (prev !== undefined && prev !== v) S.deltas[k] = { d: v - prev, t: Date.now() };
      S.balances[k] = v;
    });
  }
  function walletList() {
    const out = [], seen = new Set();
    const add = (a, n) => { if (!a || seen.has(lc(a))) return; seen.add(lc(a)); out.push({ addr: E.getAddress(a), name: n || name(a) }); };
    if (S.owner) add(S.owner, MEMBERS[lc(S.owner)] || "Platform");
    for (const [a, n] of Object.entries(window.TOBESURE_MEMBERS || {})) add(a, n);
    if (Object.keys(MEMBERS).length < 2) for (const m of S.markets) m.bettors.forEach((b) => add(b));
    return out;
  }

  // On-chain events → activity feed. Scans from the deploy block in chunks, then only new blocks.
  async function scanEvents(latest) {
    const addrs = [CFG.marketAddress, ...Object.keys(S.oracleByCreator).filter((k) => S.oracleByCreator[k])];
    let added = 0;
    for (const a of addrs) {
      let from = S.cursors[lc(a)] ?? CFG.deployBlock;
      while (from <= latest) {
        const to = Math.min(from + S.chunk - 1, latest);
        let logs = null;
        // Event history comes from the public RPC first (wallet RPCs often refuse large log ranges), then the wallet.
        for (const prov of [S.pub, reader()].filter((x, i, arr) => x && arr.indexOf(x) === i)) {
          try { logs = await withTimeout(prov.getLogs({ address: a, fromBlock: from, toBlock: to }), 15000); break; }
          catch (e) { console.warn("getLogs failed", e?.shortMessage || e?.message); }
        }
        if (logs === null) {
          if (S.chunk > 250) { S.chunk = Math.floor(S.chunk / 2); continue; }
          return added;
        }
        for (const log of logs) if (addEvent(log)) added++;
        from = to + 1;
        S.cursors[lc(a)] = from;
      }
    }
    if (added) S.events.sort((x, y) => y.block - x.block || y.idx - x.idx);
    return added;
  }
  function addEvent(log) {
    const key = log.transactionHash + ":" + log.index;
    if (S.seen.has(key)) return false;
    let ev = null;
    try { ev = iMarket.parseLog(log); } catch { /* not a market event */ }
    if (!ev) try { ev = iOracle.parseLog(log); } catch { /* unknown */ }
    if (!ev) return false;
    S.seen.add(key);
    S.events.push({ name: ev.name, args: ev.args, block: log.blockNumber, idx: log.index, tx: log.transactionHash,
                    fresh: !S.firstLoad, at: Date.now() });
    return true;
  }
  async function fillTimestamps(evs) {
    const need = [...new Set(evs.map((e) => e.block))].filter((b) => !S.blockTs[b]).slice(0, 25);
    await Promise.all(need.map(async (b) => {
      try { const blk = await (S.pub || reader()).getBlock(b); if (blk) S.blockTs[b] = blk.timestamp; } catch { /* ignore */ }
    }));
  }

  // One refresh = new block seen, or after our own transaction.
  async function refresh(force = false) {
    if (S.refreshing) { S.again = true; return; }
    S.refreshing = true;
    try {
      const p = reader();
      if (!p) return;
      const bn = await withTimeout(p.getBlockNumber(), 10000);
      setNet(true, bn);
      if (!force && bn === S.lastBlock) return;
      S.lastBlock = bn;
      await loadMarkets();
      await Promise.all([loadDetail(), loadBalances()]);
      await scanEvents(bn);
      renderAll();
      const shown = feedEvents().slice(0, 30);
      await fillTimestamps(shown);
      renderFeed();
      S.firstLoad = false;
    } catch (e) {
      console.warn("refresh failed", e);
      setNet(false);
    } finally {
      S.refreshing = false;
      if (S.again) { S.again = false; setTimeout(() => refresh(true), 50); }
    }
  }

  // ────────────────────────── ACTIONS (one contract call each) ──────────────────────────
  async function sendTx(label, build) {
    if (!S.signer) { await connect(); if (!S.signer) return null; }
    if (!S.chainOk) { await ensureChain(false).catch(() => null); if (!S.chainOk) return null; }
    const t = toast("wait", label, "Confirm in MetaMask…");
    try {
      const c = new E.Contract(CFG.marketAddress, ABI.market, S.signer);
      const tx = await build(c);
      t.set("wait", label, `Sent — waiting for a block (~12 s) · ${txLink(tx.hash, "view on Etherscan")}`);
      const r = await tx.wait();
      if (!r || r.status !== 1) throw new Error("Transaction failed on-chain");
      const fee = r.fee ?? (r.gasUsed * (r.gasPrice ?? 0n));
      t.set("ok", label + " ✓", `Confirmed in block ${r.blockNumber.toLocaleString()} · gas used ${Number(r.gasUsed).toLocaleString()} · fee ${fmtEth(fee, 9)} ETH · ${txLink(r.hash, "Etherscan")}`, 14000);
      await refresh(true);
      return r;
    } catch (e) {
      t.set("err", label + " failed", esc(errText(e)), 16000);
      return null;
    }
  }

  // placeBet(marketId, isYes) payable
  function bet(isYes) {
    const m = S.markets[S.selected];
    let wei;
    try { wei = E.parseEther(String(S.betEth || "0")); } catch { return toast("err", "Invalid amount", "Enter an amount like 0.001", 6000); }
    if (wei < E.parseEther("0.0001")) return toast("err", "Amount too small", "The contract's minimum bet is 0.0001 ETH.", 6000);
    sendTx(`Bet ${S.betEth} ETH on ${isYes ? "YES" : "NO"}`, (c) => c.placeBet(m.id, isYes, { value: wei }));
  }
  // resolveMarket(marketId, outcome) — creator or platform owner only
  function resolve(outcome) {
    const m = S.markets[S.selected];
    sendTx(`Resolve market #${m.id} as ${OUTCOME[outcome]}`, (c) => c.resolveMarket(m.id, outcome));
  }
  // createMarket(question, durationSeconds)
  async function createMarket(question, minutes) {
    const r = await sendTx("Create market", (c) => c.createMarket(question, BigInt(Math.round(minutes * 60))));
    if (r) {
      const log = r.logs.map((l) => { try { return iMarket.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "MarketCreated");
      if (log) selectMarket(Number(log.args.marketId));
    }
  }
  // withdraw() — only needed if a push payout failed
  function withdraw() { sendTx("Withdraw pending payout", (c) => c.withdraw()); }
  // OracleResolver.resolve(marketId) — anyone can trigger; Chainlink decides
  async function oracleResolve() {
    const m = S.markets[S.selected];
    if (!S.signer) { await connect(); if (!S.signer) return; }
    const t = toast("wait", "Resolve with Chainlink", "Confirm in MetaMask…");
    try {
      const o = new E.Contract(m.oracle.address, ABI.oracle, S.signer);
      const tx = await o.resolve(m.id);
      t.set("wait", "Resolve with Chainlink", `Sent — waiting for a block · ${txLink(tx.hash, "view on Etherscan")}`);
      const r = await tx.wait();
      const fee = r.fee ?? (r.gasUsed * (r.gasPrice ?? 0n));
      t.set("ok", "Resolved by Chainlink ✓", `Block ${r.blockNumber.toLocaleString()} · gas ${Number(r.gasUsed).toLocaleString()} · fee ${fmtEth(fee, 9)} ETH · ${txLink(r.hash, "Etherscan")}`, 14000);
      await refresh(true);
    } catch (e) { t.set("err", "Oracle resolve failed", esc(errText(e)), 16000); }
  }

  // Readable error messages, including the contract's own revert reasons.
  const REASONS = {
    "Betting closed": "Betting is closed — the market's deadline has passed.",
    "Market resolved": "This market is already resolved.",
    "Bet below minimum": "The minimum bet is 0.0001 ETH.",
    "Not creator or owner": "Only the market creator or the Platform wallet can resolve this market.",
    "Already resolved": "This market is already resolved.",
    "Too early": "Too early — the oracle can resolve only after the deadline.",
    "Stale price": "The Chainlink price is too old (older than the allowed staleness).",
    "Nothing to withdraw": "Nothing to withdraw for this wallet.",
    "Bettor limit reached": "This market has reached its 200-bettor limit.",
  };
  function errText(e) {
    if (e?.code === "ACTION_REJECTED" || e?.info?.error?.code === 4001 || e?.code === 4001) return "You rejected the request in MetaMask — nothing was sent.";
    if (e?.code === "INSUFFICIENT_FUNDS") return "Not enough Sepolia ETH in this wallet to pay the bet plus gas.";
    const raw = e?.reason || e?.revert?.args?.[0] || e?.info?.error?.data?.message || e?.info?.error?.message || e?.error?.message || e?.shortMessage || e?.message || String(e);
    for (const [k, v] of Object.entries(REASONS)) if (raw.includes(k)) return `${v} (contract: "${k}")`;
    if (/insufficient funds/i.test(raw)) return "Not enough Sepolia ETH in this wallet to pay the bet plus gas.";
    return raw.length > 220 ? raw.slice(0, 220) + "…" : raw;
  }

  // ────────────────────────── rendering ──────────────────────────
  function renderAll() { renderWalletBar(); renderList(); renderDetail(); renderWallets(); renderCreate(); }

  function setNet(ok, bn) {
    const el = $("#net");
    el.classList.toggle("ok", ok); el.classList.toggle("bad", !ok);
    if (ok) {
      const via = (S.bp && S.chainOk) ? "via MetaMask" : "read-only";
      $("#netText").textContent = `Sepolia · block ${Number(bn).toLocaleString()} · ${via}`;
      if (bn !== S._lastNetBlock) { const d = el.querySelector(".dot"); d.classList.remove("pulse"); void d.offsetWidth; d.classList.add("pulse"); S._lastNetBlock = bn; }
    } else $("#netText").textContent = "No connection to Sepolia — retrying…";
  }

  function deltaChip(addr) {
    const d = S.deltas[lc(addr)];
    if (!d || Date.now() - d.t > 60000) return "";
    return `<span class="delta ${d.d > 0n ? "up" : "down"}">${signedEth(d.d)} ETH</span>`;
  }

  function renderWalletBar() {
    const w = $("#wallet");
    if (!S.account) {
      w.innerHTML = `<button class="btn primary" id="connectBtn" type="button">Connect MetaMask</button>`;
      $("#connectBtn").onclick = () => connect(false);
      return;
    }
    const bal = S.balances[lc(S.account)];
    const low = bal !== undefined && bal < E.parseEther(String(CFG.lowBalanceEth));
    w.innerHTML = `
      <div class="who"><span class="name">${esc(name(S.account))}</span><span class="addr">${esc(short(S.account))}</span></div>
      <div class="bal"><div class="l">Your balance</div><div class="v">${bal === undefined ? "…" : fmtEth(bal, 6)} ETH</div>${deltaChip(S.account)}</div>
      <button class="btn ghost small" id="acctBtn" type="button" title="Pick which MetaMask accounts this page may use">Change accounts</button>`;
    $("#acctBtn").onclick = pickAccounts;
    if (low) { showBanner(`This wallet has less than ${CFG.lowBalanceEth} ETH — top it up before betting (gas is paid in ETH too).`); S.lowBanner = true; }
    else if (S.lowBanner) { hideBanner(); S.lowBanner = false; }
  }

  function status(m) {
    if (m.resolved) return { cls: OUTCOME[m.outcome] === "YES" ? "yes" : OUTCOME[m.outcome] === "NO" ? "no" : "", text: `Resolved · ${OUTCOME[m.outcome]}` };
    if (m.deadline > now()) return { cls: "open", text: "Open" };
    return { cls: "closed", text: "Betting closed" };
  }

  function renderList() {
    $("#marketCount").textContent = S.markets.length ? `${S.markets.length} total` : "";
    const el = $("#marketList");
    if (!S.markets.length) { el.innerHTML = `<p class="muted pad">No markets yet.</p>`; return; }
    el.innerHTML = [...S.markets].reverse().map((m) => {
      const total = m.yesPool + m.noPool, st = status(m);
      const yesPct = total ? Number(m.yesPool * 1000n / total) / 10 : 50;
      return `<button class="mitem ${m.id === S.selected ? "sel" : ""}" data-id="${m.id}" type="button">
        <span class="qrow"><span class="q">#${m.id} · ${esc(m.question)}</span><span class="mchance">${m.resolved ? esc(OUTCOME[m.outcome]) : Math.round(yesPct) + "%"}</span></span>
        <span class="minibar"><span style="width:${yesPct}%"></span></span>
        <span class="meta"><span class="pill ${st.cls}">${esc(st.text)}${m.oracle ? "" : ""}</span><span>${fmtEth(total, 4)} ETH${m.oracle ? " · oracle" : ""}</span></span>
      </button>`;
    }).join("");
    el.querySelectorAll(".mitem").forEach((b) => b.onclick = () => selectMarket(Number(b.dataset.id)));
  }

  function selectMarket(id) {
    S.selected = id;
    history.replaceState(null, "", "#market-" + id);
    S.detail = null;
    renderList(); renderDetail(); renderFeed();
    loadDetail().then(() => { renderDetail(); renderFeed(); }).catch((e) => console.warn(e));
  }

  function renderDetail() {
    const box = $("#detail");
    const m = S.markets[S.selected];
    if (!m) { box.innerHTML = `<div class="card pad"><p class="muted">No market selected.</p></div>`; return; }
    const total = m.yesPool + m.noPool, st = status(m);
    const d = S.detail && S.detail.id === m.id ? S.detail : null;
    const yesPct = d ? d.prob : (total ? Number(m.yesPool * 10000n / total) / 100 : 50);
    const open = !m.resolved && m.deadline > now();
    const isAdmin = S.account && (eq(S.account, S.owner) || eq(S.account, m.creator));

    let html = `
    <section class="card mhead">
      <div class="tags"><span class="pill ${st.cls}">${esc(st.text)}</span>${m.oracle ? `<span class="pill oracle">Chainlink oracle</span>` : ""}<span class="muted small">Market #${m.id} · created by ${esc(name(m.creator))}</span></div>
      <div class="titlerow"><h1>${esc(m.question)}</h1><div class="chance" title="yesProbabilityBps()"><b>${m.resolved ? esc(OUTCOME[m.outcome]) : Math.round(yesPct) + "%"}</b><span>${m.resolved ? "final outcome" : "chance YES"}</span></div></div>
      <div class="facts">
        <span>Total pool<b>${fmtEth(total, 5)} ETH</b></span>
        <span>Bettors<b>${m.bettors.length}</b></span>
        <span>${open ? "Betting closes in" : "Deadline"}<b ${open ? `data-deadline="${m.deadline}"` : ""}>${open ? fmtDur(m.deadline - now()) : new Date(m.deadline * 1000).toLocaleString()}</b></span>
        <span>Fees<b>${Number(S.feeBps.p) / 100}% + ${Number(S.feeBps.c) / 100}%</b></span>
      </div>
      <div class="odds">
        <div class="oddsbar" title="yesProbabilityBps() — share of the pool on YES">
          <div class="y" style="flex-basis:${Math.max(yesPct, 0.001)}%">${yesPct >= 12 ? `YES ${yesPct.toFixed(1)}%` : ""}</div>
          <div class="n" style="flex-basis:${Math.max(100 - yesPct, 0.001)}%">${100 - yesPct >= 12 ? `${(100 - yesPct).toFixed(1)}% NO` : ""}</div>
        </div>
        <div class="oddslegend"><span>YES ${yesPct.toFixed(1)}% · pool ${fmtEth(m.yesPool)} ETH</span><span>NO ${(100 - yesPct).toFixed(1)}% · pool ${fmtEth(m.noPool)} ETH</span></div>
      </div>
    </section>`;

    if (m.oracle) html += oracleCard(m);

    if (m.resolved) html += resultCard(m, d);
    else html += betCard(m, d, open);

    if (d && d.mine.pending > 0n) html += `<section class="card betbox"><div class="note"><b>${fmtEth(d.mine.pending, 6)} ETH</b> could not be pushed to this wallet automatically and is waiting for you.</div><button class="btn primary" id="wdBtn" type="button">Withdraw ${fmtEth(d.mine.pending, 6)} ETH</button></section>`;

    html += bettorsCard(m, d);
    if (isAdmin && !m.resolved) html += adminCard(m);
    const active = document.activeElement && document.activeElement.id === "amt" ? document.activeElement : null;
    const caret = active ? (() => { try { return active.selectionStart; } catch { return null; } })() : null;
    box.innerHTML = html;
    wireDetail(m);
    if (active) { const a = $("#amt"); if (a) { a.focus(); try { if (caret !== null) a.setSelectionRange(caret, caret); } catch { /* number input */ } } }
  }

  function betCard(m, d, open) {
    const amt = (() => { try { return E.parseEther(String(S.betEth || "0")); } catch { return 0n; } })();
    const mine = d ? d.mine : { yes: 0n, no: 0n };
    const prev = (yesSide) => {
      if (amt <= 0n) return "—";
      const yesPool = m.yesPool + (yesSide ? amt : 0n), noPool = m.noPool + (yesSide ? 0n : amt);
      const total = yesPool + noPool;
      const dist = total - total * (S.feeBps.p + S.feeBps.c) / 10000n;
      const stake = (yesSide ? mine.yes : mine.no) + amt;
      const pay = stake * dist / (yesSide ? yesPool : noPool);
      const mult = Number(pay * 1000n / stake) / 1000;
      return `${fmtEth(pay, 6)} ETH <span class="muted small">(${mult.toFixed(2)}×)</span>`;
    };
    const mult = (yesSide) => {
      if (amt <= 0n) return "&nbsp;";
      const yesPool = m.yesPool + (yesSide ? amt : 0n), noPool = m.noPool + (yesSide ? 0n : amt);
      const total = yesPool + noPool, dist = total - total * (S.feeBps.p + S.feeBps.c) / 10000n;
      const stake = (yesSide ? mine.yes : mine.no) + amt;
      const pay = stake * dist / (yesSide ? yesPool : noPool);
      return `pays ${(Number(pay * 1000n / stake) / 1000).toFixed(2)}× if ${yesSide ? "YES" : "NO"} wins`;
    };
    if (!open) return `<section class="card betbox"><div class="note">Betting closed at ${new Date(m.deadline * 1000).toLocaleTimeString()}. ${m.oracle ? "Anyone can now trigger the Chainlink resolution above." : "Waiting for the creator or the Platform wallet to resolve."}</div></section>`;
    return `
    <section class="card betbox">
      <div class="card-head" style="padding:0"><h2>Place a bet</h2><span class="muted small">placeBet(marketId, isYes) — payable</span></div>
      <div class="amountrow">
        <div><label for="amt">Amount (ETH)</label><input id="amt" type="number" min="0.0001" step="0.0005" inputmode="decimal" value="${esc(S.betEth)}"></div>
        <div class="chips">${["0.0005", "0.001", "0.002"].map((v) => `<button class="btn ghost small chip" data-v="${v}" type="button">${v}</button>`).join("")}</div>
      </div>
      <div class="betbtns">
        <button class="btn yes big" id="betYes" type="button"><span>Bet YES</span><small>${mult(true)}</small></button>
        <button class="btn no big" id="betNo" type="button"><span>Bet NO</span><small>${mult(false)}</small></button>
      </div>
      <div class="preview">
        <div>If YES wins you get<b>${prev(true)}</b></div>
        <div>If NO wins you get<b>${prev(false)}</b></div>
      </div>
      ${S.account ? `<div class="mystake">Your stake: <b>${fmtEth(mine.yes, 6)}</b> ETH on YES · <b>${fmtEth(mine.no, 6)}</b> ETH on NO</div>` : `<div class="note">Connect MetaMask to bet. You can watch everything without a wallet.</div>`}
    </section>`;
  }

  function resultCard(m, d) {
    const out = OUTCOME[m.outcome];
    const cls = out === "YES" ? "yes" : out === "NO" ? "no" : "";
    const total = m.yesPool + m.noPool;
    const refund = out === "INVALID" || (out === "YES" ? m.yesPool : m.noPool) === 0n;
    const paidTotal = d ? d.rows.reduce((s, r) => s + r.paid, 0n) : null;
    let mineTxt = "";
    if (d && S.account) {
      const r = d.rows.find((x) => eq(x.addr, S.account));
      if (r) mineTxt = r.paid > 0n ? `<span class="pill open">You received ${fmtEth(r.paid, 6)} ETH</span>` : `<span class="pill">You lost ${fmtEth(r.yes + r.no, 6)} ETH</span>`;
    }
    let oracleTxt = "";
    if (m.oracle && m.oracle.resolved) {
      const info = S.feedInfo[lc(m.oracle.address)];
      oracleTxt = info ? `<span class="muted">Chainlink price ${fmtPrice(m.oracle.finalPrice, info.decimals)} vs threshold ${fmtPrice(m.oracle.threshold, info.decimals)}</span>` : "";
    }
    return `<section class="card result ${cls}">
      <div><div class="muted small">Outcome</div><div class="big">${esc(out)}</div></div>
      <div style="flex:1;min-width:200px">${refund ? "Nobody won or the market was INVALID — all stakes were refunded, no fees." :
        `Pool ${fmtEth(total)} ETH → ${Number(S.feeBps.p) / 100}% platform + ${Number(S.feeBps.c) / 100}% creator, the rest paid to ${out} bettors pro rata${paidTotal !== null ? ` (${fmtEth(paidTotal, 6)} ETH paid out)` : ""}.`}
        <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">${mineTxt}${oracleTxt}</div></div>
      <button class="btn primary newMarketBtn" type="button">+ New market</button>
    </section>`;
  }

  function bettorsCard(m, d) {
    const rows = d ? [...d.rows].sort((a, b) => Number((b.yes + b.no) - (a.yes + a.no))) : null;
    const body = !rows ? `<tr><td colspan="4" class="muted">Loading…</td></tr>` : !rows.length ? `<tr><td colspan="4" class="muted">No bets yet — be the first.</td></tr>` :
      rows.map((r) => `<tr class="${eq(r.addr, S.account) ? "me" : ""}"><td>${esc(name(r.addr))}${name(r.addr) !== short(r.addr) ? ` <span class="muted mono">${esc(short(r.addr))}</span>` : ""}</td>
        <td class="num">${r.yes ? fmtEth(r.yes, 6) : "—"}</td><td class="num">${r.no ? fmtEth(r.no, 6) : "—"}</td>
        <td class="num ${r.paid ? "gain" : ""}">${m.resolved ? (r.paid ? "+" + fmtEth(r.paid, 6) : "0") : "—"}</td></tr>`).join("");
    return `<section class="card"><div class="card-head"><h2>Bettors</h2><span class="muted small">getBettors · yesStake · noStake · paidOut</span></div>
      <div class="tablewrap"><table><thead><tr><th>Who</th><th class="num">YES (ETH)</th><th class="num">NO (ETH)</th><th class="num">Paid out</th></tr></thead><tbody>${body}</tbody></table></div></section>`;
  }

  function adminCard(m) {
    const role = eq(S.account, S.owner) ? "Platform wallet" : "market creator";
    const buttons = `<div class="row">
        ${[[1, "yes", "Resolve YES"], [2, "no", "Resolve NO"], [3, "ghost", "INVALID (refund all)"]].map(([o, c, t]) => {
          const armed = S.armed && S.armed.o === o && S.armed.id === m.id && S.armed.until > Date.now();
          return `<button class="btn ${c} resolve ${armed ? "armed" : ""}" data-o="${o}" type="button">${armed ? "Click again to confirm" : t}</button>`;
        }).join("")}</div>
      <span class="muted small">Click once to arm, click again within 5 s to send. resolveMarket(marketId, outcome) pays fees and winners in the same transaction.</span>`;
    return `<section class="card admin">
      <div class="card-head" style="padding:0"><h2>Resolve market</h2><span class="muted small">You are the ${role}</span></div>
      ${m.oracle ? `<details><summary>Owner override — this market should be decided by Chainlink (button above)</summary><div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">${buttons}</div></details>` : buttons}
    </section>`;
  }

  function fmtPrice(v, dec) {
    const n = Number(E.formatUnits(v, dec));
    return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function oracleCard(m) {
    const info = S.feedInfo[lc(m.oracle.address)];
    if (!info) return `<section class="card ocard"><div class="cell full">Loading Chainlink feed…</div></section>`;
    const p = S.price[lc(info.feedAddr)];
    const age = p ? now() - p.updatedAt : null;
    const stale = age !== null && age > info.maxStaleness;
    const after = m.oracle.resolveAfter <= now();
    const winning = p ? (p.answer > m.oracle.threshold ? "YES" : "NO") : "—";
    const canResolve = !m.resolved && after && !stale;
    return `<section class="card ocard">
      <div class="cell">Feed<b>${esc(info.description)}</b><a class="mono" href="${CFG.explorer}/address/${info.feedAddr}" target="_blank" rel="noopener">${esc(short(info.feedAddr))}</a></div>
      <div class="cell">Live Chainlink price<b>${p ? fmtPrice(p.answer, info.decimals) : "—"}</b>${age !== null ? `updated ${fmtDur(age)} ago${stale ? " · <b style='display:inline;font-size:inherit;color:var(--loss)'>stale</b>" : ""}` : ""}</div>
      <div class="cell">YES wins if price &gt;<b>${fmtPrice(m.oracle.threshold, info.decimals)}</b>threshold set on-chain</div>
      <div class="cell">${m.resolved ? "Decided at" : "Would win right now"}<b>${m.resolved && m.oracle.resolved ? fmtPrice(m.oracle.finalPrice, info.decimals) : winning}</b>${m.resolved ? "price used by the contract" : "if resolved now"}</div>
      ${m.resolved ? "" : `<div class="full"><span class="muted small">${after ? "The deadline has passed — anyone can trigger resolve(); the contract reads Chainlink and pays out. No human picks the winner." : `Oracle resolution opens in <b data-deadline="${m.oracle.resolveAfter}">${fmtDur(m.oracle.resolveAfter - now())}</b>`}</span>
        <button class="btn primary" id="oracleBtn" type="button" ${canResolve ? "" : "disabled"}>Resolve with Chainlink</button></div>`}
    </section>`;
  }

  function wireDetail(m) {
    const amt = $("#amt");
    if (amt) {
      amt.oninput = () => { S.betEth = amt.value; const pos = amt.selectionStart; renderDetailPreviewOnly(); amt.focus(); try { amt.setSelectionRange(pos, pos); } catch { /* number inputs */ } };
      document.querySelectorAll(".chip").forEach((b) => b.onclick = () => { S.betEth = b.dataset.v; renderDetail(); });
      $("#betYes").onclick = () => bet(true);
      $("#betNo").onclick = () => bet(false);
    }
    const wd = $("#wdBtn"); if (wd) wd.onclick = withdraw;
    document.querySelectorAll("#detail .newMarketBtn").forEach((b) => b.onclick = focusCreate);
    const ob = $("#oracleBtn"); if (ob) ob.onclick = oracleResolve;
    document.querySelectorAll(".resolve").forEach((b) => b.onclick = () => {
      const o = Number(b.dataset.o);
      if (S.armed && S.armed.o === o && S.armed.id === m.id && S.armed.until > Date.now()) { S.armed = null; renderDetail(); resolve(o); return; }
      S.armed = { o, id: m.id, until: Date.now() + 5000 };
      renderDetail();
      setTimeout(() => { if (S.armed && S.armed.until <= Date.now()) { S.armed = null; renderDetail(); } }, 5100);
    });
  }
  function renderDetailPreviewOnly() {
    // re-render just the preview numbers without losing the input focus
    const m = S.markets[S.selected]; const d = S.detail && S.detail.id === m.id ? S.detail : null;
    const tmp = document.createElement("div"); tmp.innerHTML = betCard(m, d, true);
    const p = tmp.querySelector(".preview"), cur = document.querySelector(".preview");
    if (p && cur) cur.innerHTML = p.innerHTML;
    for (const id of ["#betYes", "#betNo"]) { const a = tmp.querySelector(id + " small"), b = document.querySelector(id + " small"); if (a && b) b.innerHTML = a.innerHTML; }
  }

  // "New market" is always available: the contract lets any wallet create a market.
  // The creator can later resolve it and receives the 1% creator fee.
  function renderCreate() {
    const box = $("#createBox");
    if (!box.dataset.ready) {
      box.dataset.ready = "1"; // build once, so typing is never interrupted by a refresh
      box.innerHTML = `<form id="createForm" style="padding:12px 16px 16px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:10px">
        <h2>New market</h2>
        <div><label for="cq">Question (YES / NO)</label><input id="cq" type="text" maxlength="200" placeholder="Will Group 3's live demo work on the first try?" required></div>
        <div><label for="cd">Betting open for (minutes)</label><input id="cd" type="number" min="1" step="1" value="120" required></div>
        <button class="btn primary" id="createBtn" type="submit">Create market</button>
        <span class="muted small" id="createHint"></span></form>`;
      $("#createForm").onsubmit = (ev) => {
        ev.preventDefault();
        const q = $("#cq").value.trim(), mins = Number($("#cd").value);
        if (!q || !(mins > 0)) return;
        createMarket(q, mins).then((r) => { if (r) $("#cq").value = ""; });
      };
    }
    const who = S.account ? name(S.account) : null;
    $("#createBtn").textContent = who ? `Create market as ${who}` : "Connect MetaMask & create";
    $("#createHint").textContent = who ? `createMarket(question, durationSeconds) — ${who} becomes the creator, can resolve it and earns the 1% creator fee.` : "createMarket(question, durationSeconds) — any wallet can create a market.";
  }
  function focusCreate() {
    const f = $("#createForm"); if (!f) return;
    f.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => $("#cq").focus(), 350);
  }

  function renderWallets() {
    const list = walletList();
    const el = $("#wallets");
    if (!list.length) { el.innerHTML = `<p class="muted pad">Connect or wait for bets to see wallets.</p>`; return; }
    el.innerHTML = `<ul class="wlist">${list.map((w) => {
      const k = lc(w.addr), b = S.balances[k], d = S.deltas[k], fresh = d && Date.now() - d.t < 3000;
      return `<li class="${eq(w.addr, S.account) ? "me" : ""} ${fresh ? (d.d > 0n ? "flash-up" : "flash-down") : ""}">
        <span class="n">${esc(w.name)}</span><span class="a">${esc(short(w.addr))}</span>
        <span class="b">${b === undefined ? "…" : fmtEth(b, 6) + " ETH"}${deltaChip(w.addr)}</span></li>`;
    }).join("")}</ul>`;
  }

  function feedEvents() {
    const id = S.selected;
    return S.events.filter((e) => e.args.marketId === undefined ? true : Number(e.args.marketId) === id);
  }
  function renderFeed() {
    const el = $("#feed");
    $("#feedScope").textContent = S.selected !== null ? `market #${S.selected}` : "";
    const evs = feedEvents().slice(0, 40);
    if (!evs.length) { el.innerHTML = `<li class="muted pad">No events for this market yet.</li>`; return; }
    el.innerHTML = evs.map((e) => {
      const a = e.args; let ic = "fee", sym = "·", text = "";
      switch (e.name) {
        case "MarketCreated": ic = "new"; sym = "+"; text = `<b>${esc(name(a.creator))}</b> created the market`; break;
        case "BetPlaced": ic = a.isYes ? "bet-yes" : "bet-no"; sym = a.isYes ? "Y" : "N"; text = `<b>${esc(name(a.bettor))}</b> bet ${fmtEth(a.amount, 6)} ETH on <b>${a.isYes ? "YES" : "NO"}</b>`; break;
        case "MarketResolved": ic = "res"; sym = "✓"; text = `Resolved <b>${OUTCOME[Number(a.outcome)]}</b> · pool ${fmtEth(a.totalPool)} ETH`; break;
        case "Payout": ic = "pay"; sym = "$"; text = `<b>${esc(name(a.to))}</b> received <b class="gain">${fmtEth(a.amount, 6)} ETH</b>`; break;
        case "FeePaid": ic = "fee"; sym = "%"; text = `${a.isPlatformFee ? "Platform" : "Creator"} fee ${fmtEth(a.amount, 6)} ETH → ${esc(name(a.to))}`; break;
        case "PayoutDeferred": ic = "fee"; sym = "!"; text = `${fmtEth(a.amount, 6)} ETH held for ${esc(name(a.to))} (withdraw)`; break;
        case "Withdrawn": ic = "pay"; sym = "↓"; text = `${esc(name(a.to))} withdrew ${fmtEth(a.amount, 6)} ETH`; break;
        case "OracleMarketCreated": return "";
        case "OracleResolved": {
          const info = S.feedInfo[lc(S.markets[Number(a.marketId)]?.creator)];
          ic = "res"; sym = "⛓"; text = `Chainlink price ${info ? fmtPrice(a.price, info.decimals) : a.price.toString()} → <b>${a.yesWins ? "YES" : "NO"}</b> wins · triggered by ${esc(name(a.triggeredBy))}`; break;
        }
        default: return "";
      }
      const ts = S.blockTs[e.block];
      const when = ts ? new Date(ts * 1000).toLocaleTimeString() : `block ${e.block.toLocaleString()}`;
      return `<li class="${e.fresh && Date.now() - e.at < 4000 ? "new" : ""}"><span class="ic ${ic}">${sym}</span><span>${text}</span><span class="t2">${when} · ${txLink(e.tx, "tx")}</span></li>`;
    }).join("");
  }

  // ────────────────────────── toasts & banner ──────────────────────────
  function toast(kind, title, msg, ttl) {
    const el = document.createElement("div");
    $("#toasts").appendChild(el);
    let timer = null;
    const api = {
      set(k, t, m, life) {
        el.className = "toast " + (k === "ok" ? "ok" : k === "err" ? "err" : "");
        el.innerHTML = `${k === "wait" ? `<span class="spin"></span>` : `<span>${k === "ok" ? "✓" : "✕"}</span>`}<strong>${esc(t)}</strong><button class="x" type="button" aria-label="Close">×</button><span class="s">${m || ""}</span>`;
        el.querySelector(".x").onclick = () => el.remove();
        clearTimeout(timer);
        if (life) timer = setTimeout(() => el.remove(), life);
      },
    };
    api.set(kind, title, kind === "err" ? esc(msg) : msg, ttl);
    return api;
  }
  function toastError(title, e) { toast("err", title, errText(e), 12000); }
  function showBanner(html) { const b = $("#banner"); b.innerHTML = html; b.hidden = false; }
  function hideBanner() { $("#banner").hidden = true; }

  // ────────────────────────── start ──────────────────────────
  function tick() {
    document.querySelectorAll("[data-deadline]").forEach((el) => {
      const left = Number(el.dataset.deadline) - now();
      if (left >= 0) el.textContent = fmtDur(left);
    });
    // when a deadline passes, re-render so buttons switch state
    const m = S.markets[S.selected];
    if (m && !m.resolved) {
      const crossed = [m.deadline, m.oracle?.resolveAfter].some((t) => t && t <= now() && t > now() - 1);
      if (crossed) { renderDetail(); renderList(); }
    }
  }

  async function start() {
    const link = $("#contractLink");
    link.href = `${CFG.explorer}/address/${CFG.marketAddress}`; link.textContent = short(CFG.marketAddress);
    if (store.get("tobesure-present") === "1" || /present/.test(location.search)) document.documentElement.classList.add("present");
    $("#presentBtn").onclick = togglePresent;
    document.addEventListener("keydown", (e) => { if (e.key === "p" && !/input|textarea/i.test(e.target.tagName)) togglePresent(); });
    $("#connectBtn").onclick = () => connect(false);
    $("#newTop").onclick = focusCreate;
    renderCreate();
    window.addEventListener("hashchange", () => { const m = /^#market-(\d+)$/.exec(location.hash); if (m && Number(m[1]) !== S.selected && Number(m[1]) < S.markets.length) selectMarket(Number(m[1])); });

    await new Promise((r) => setTimeout(r, 300));   // give wallets time to announce themselves
    WALLET = pickWallet();
    S.pub = await initPublic();
    if (!S.pub) { setNet(false); showBanner("Could not reach Sepolia through the public RPC. Check the internet connection, or connect MetaMask."); }
    await refresh(true);
    connect(true);                            // reconnect silently if MetaMask already allowed this site (never blocks the page)
    setInterval(() => refresh(false), CFG.pollMs);
    setInterval(tick, 1000);
    setInterval(() => { renderWallets(); if (S.account) { const b = document.querySelector(".bal"); if (b) renderWalletBar(); } }, 15000);
  }
  function togglePresent() {
    const on = document.documentElement.classList.toggle("present");
    store.set("tobesure-present", on ? "1" : "0");
  }

  start();
})();
