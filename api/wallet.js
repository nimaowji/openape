// GET /api/wallet -> live state of the OpenApe wallet (balance, holdings, recent activity).
const { WALLET, SOL_MINT, TOKEN_PROGRAMS, rpc, fetchJson, fetchTx, sleep } = require("../lib/solana");
const TX_LIMIT = 25;
const cache = globalThis.__oaCache ||= { tx: new Map(), meta: new Map(), holdings: null };

async function holdings(errors) {
  // Query both sources in parallel:
  //  - RPC getTokenAccountsByOwner for SPL Token AND Token-2022 (pump.fun coins are Token-2022), with retries across RPCs.
  //    Public RPCs often rate-limit this call from Vercel IPs ("Too many requests for a specific RPC call").
  //  - Jupiter's holdings index as an independent fallback.
  // A failure is reported in `errors`, never silently treated as "no tokens".
  const viaRpc = Promise.all(TOKEN_PROGRAMS.map(p => rpc("getTokenAccountsByOwner", [WALLET, { programId: p }, { encoding: "jsonParsed", commitment: "confirmed" }])))
    .then(res => res.flatMap(r => r.value || []).map(a => {
      const i = a.account.data.parsed.info;
      return { mint: i.mint, amount: Number(i.tokenAmount.uiAmountString ?? i.tokenAmount.uiAmount ?? 0), decimals: i.tokenAmount.decimals, frozen: i.state === "frozen", program: a.account.owner };
    }));
  const jupHoldings = async () => {
    let err;
    for (const [i, host] of ["https://lite-api.jup.ag", "https://api.jup.ag", "https://lite-api.jup.ag"].entries()) {
      try { return await fetchJson(host + "/ultra/v1/holdings/" + WALLET, {}, 5000); } catch (e) { err = e; if (i < 2) await sleep(500); }
    }
    throw err;
  };
  const viaJup = jupHoldings().then(j => {
    if (!j || typeof j.tokens !== "object") throw new Error("unexpected response");
    const list = [];
    for (const [mint, accs] of Object.entries(j.tokens)) for (const a of accs) list.push({ mint, amount: Number(a.uiAmountString ?? a.uiAmount ?? 0), decimals: a.decimals, frozen: !!a.isFrozen, program: a.programId });
    return { list, sol: j.uiAmount };
  });
  // Prefer the RPC answer, but once Jupiter has answered don't wait more than ~2.5s for slow RPC retries.
  const jSettled = viaJup.then(v => ({ status: "fulfilled", value: v }), e => ({ status: "rejected", reason: e }));
  const rSettled = viaRpc.then(v => ({ status: "fulfilled", value: v }), e => ({ status: "rejected", reason: e }));
  const j = await jSettled;
  const r = j.status === "fulfilled"
    ? await Promise.race([rSettled, sleep(2500).then(() => ({ status: "rejected", reason: new Error("timed out (rate limited)") }))])
    : await rSettled;
  if (r.status === "rejected") errors.push("token accounts (rpc): " + r.reason.message);
  if (j.status === "rejected") errors.push("holdings (jupiter): " + j.reason.message);
  if (r.status === "fulfilled") return { list: r.value, source: "rpc", sol: j.value?.sol };
  if (j.status === "fulfilled") return { list: j.value.list, source: "jupiter", sol: j.value.sol };
  return null;
}

// Last-resort holdings: read the wallet's token accounts seen in recent transactions directly (getMultipleAccounts is
// not an indexed call, so public RPCs rarely rate-limit it). Closed accounts come back null and are skipped.
async function holdingsFromAccounts(txs, errors) {
  const accs = [...new Map(txs.flatMap(t => t.accounts || []).map(a => [a.pubkey, a])).values()];
  if (!accs.length) return null;
  try {
    const list = [];
    for (let i = 0; i < accs.length; i += 100) {
      const r = await rpc("getMultipleAccounts", [accs.slice(i, i + 100).map(a => a.pubkey), { encoding: "jsonParsed", commitment: "confirmed" }]);
      for (const a of r.value || []) {
        const info = a?.data?.parsed?.info; if (!info || info.owner !== WALLET) continue;
        list.push({ mint: info.mint, amount: Number(info.tokenAmount.uiAmountString ?? info.tokenAmount.uiAmount ?? 0), decimals: info.tokenAmount.decimals, frozen: info.state === "frozen", program: a.owner });
      }
    }
    return { list, source: "recent-accounts" };
  } catch (e) { errors.push("token accounts (getMultipleAccounts): " + e.message); return null; }
}

async function prices(mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 50) {
    try {
      const j = await fetchJson("https://lite-api.jup.ag/price/v3?ids=" + mints.slice(i, i + 50).join(","), {}, 6000);
      for (const [k, v] of Object.entries(j || {})) if (v && v.usdPrice) out[k] = { usd: v.usdPrice, ch24: v.priceChange24h ?? null, liq: v.liquidity ?? null };
    } catch {}
  }
  return out;
}

async function meta(mints) {
  const now = Date.now();
  const need = mints.filter(m => !cache.meta.has(m) || now - cache.meta.get(m).at > 60000);
  const seen = new Set();
  for (let i = 0; i < need.length; i += 30) {
    try {
      const j = await fetchJson("https://api.dexscreener.com/tokens/v1/solana/" + need.slice(i, i + 30).join(","), {}, 6000);
      for (const p of Array.isArray(j) ? j : []) {
        const m = p.baseToken?.address; if (!m || seen.has(m)) continue; seen.add(m);
        cache.meta.set(m, { symbol: p.baseToken.symbol, name: p.baseToken.name, icon: p.info?.imageUrl || null, dex: p.url || null, priceUsd: Number(p.priceUsd) || null, ch24: p.priceChange?.h24 ?? null, liq: p.liquidity?.usd ?? null, at: now });
      }
    } catch {}
  }
  const still = need.filter(m => !seen.has(m) && !cache.meta.has(m));
  if (still.length) {
    try {
      const j = await fetchJson("https://lite-api.jup.ag/tokens/v2/search?query=" + still.slice(0, 100).join(","), {}, 6000);
      for (const t of Array.isArray(j) ? j : []) cache.meta.set(t.id, { symbol: t.symbol, name: t.name, icon: t.icon || null, dex: null, priceUsd: t.usdPrice || null, ch24: t.stats24h?.priceChange ?? null, liq: t.liquidity ?? null, at: now });
    } catch {}
  }
  const out = {};
  for (const m of mints) out[m] = cache.meta.get(m) || {};
  return out;
}

// Enrich signatures: memory cache -> our own edge-cached /api/tx -> direct RPC. Limited concurrency + deadline.
async function enrich(sigs, origin, deadline) {
  const out = new Array(sigs.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < sigs.length && Date.now() < deadline) {
      const i = next++; const s = sigs[i];
      const hit = cache.tx.get(s.signature);
      if (hit) { out[i] = hit; continue; }
      let t = null;
      try {
        if (origin) { const j = await fetchJson(`${origin}/api/tx?v=2&sig=${s.signature}`, {}, Math.max(1000, deadline - Date.now())); if (!j.error) t = j; }
      } catch {}
      if (!t && Date.now() < deadline - 1500) { try { t = await fetchTx(s.signature); } catch {} }
      if (t) { out[i] = t; if (s.confirmationStatus === "finalized") cache.tx.set(s.signature, t); }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

module.exports = async (req, res) => {
  const errors = [];
  const deadline = Date.now() + 9000;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const origin = host && !/^localhost|^127\./.test(host) ? `https://${host}` : null;
  try {
    let [bal, sigs, hold] = await Promise.all([
      rpc("getBalance", [WALLET, { commitment: "confirmed" }]).then(r => r.value / 1e9).catch(e => { errors.push("balance: " + e.message); return null; }),
      rpc("getSignaturesForAddress", [WALLET, { limit: TX_LIMIT }]).catch(e => { errors.push("signatures: " + e.message); return null; }),
      holdings(errors),
    ]);
    const txRaw = sigs ? await enrich(sigs, origin, deadline) : [];
    const txs = (sigs || []).map((s, i) => txRaw[i] || { sig: s.signature, time: s.blockTime, ok: !s.err, kind: s.err ? "FAILED" : "PENDING", sol: null, changes: [] });

    let tokensPartial = false;
    if (!hold) {
      // Both full-holdings sources failed: read the token accounts seen in recent txs, and keep any older
      // holdings we last saw on this instance for mints those txs didn't touch.
      const recent = await holdingsFromAccounts(txs, errors);
      if (recent) {
        const seen = new Set(txs.flatMap(t => (t.accounts || []).map(a => a.mint)));
        const older = (cache.holdings?.list || []).filter(t => !seen.has(t.mint));
        hold = { list: [...recent.list, ...older], source: older.length ? "recent-accounts+cache" : "recent-accounts" };
        tokensPartial = !cache.holdings;
      }
    }
    let sol = bal ?? hold?.sol ?? null;
    if (hold && !tokensPartial) cache.holdings = { list: hold.list, at: Date.now() };
    const tokenList = hold?.list || cache.holdings?.list || null;  // stale-but-real beats empty
    const tokensStale = !hold && !!cache.holdings;

    const held = (tokenList || []).filter(t => t.amount > 0);
    const txsOut = txs.map(({ accounts, ...t }) => t);
    const mints = [...new Set([...held.map(t => t.mint), ...txs.flatMap(t => t.changes.map(c => c.mint))])];
    const [pr, md] = await Promise.all([prices([SOL_MINT, ...held.map(t => t.mint)]), meta(mints)]);

    const tokens = [], spam = [];
    for (const t of held) {
      const m = md[t.mint] || {};
      const price = pr[t.mint]?.usd ?? m.priceUsd ?? null;
      const row = { mint: t.mint, amount: t.amount, symbol: m.symbol || t.mint.slice(0, 4) + "…", name: m.name || "Unknown token", icon: m.icon || null, dex: m.dex || null, price, usd: price != null ? price * t.amount : null, ch24: m.ch24 ?? pr[t.mint]?.ch24 ?? null, frozen: t.frozen };
      // Frozen or unpriced airdrops are almost always scam bait: keep them off the main list.
      (t.frozen || price == null ? spam : tokens).push(row);
    }
    tokens.sort((a, b) => (b.usd || 0) - (a.usd || 0));
    for (const t of txs) for (const c of t.changes) c.symbol = md[c.mint]?.symbol || c.mint.slice(0, 4) + "…";

    const solPrice = pr[SOL_MINT]?.usd ?? null;
    const totalUsd = solPrice != null && sol != null ? sol * solPrice + tokens.reduce((a, t) => a + (t.usd || 0), 0) : null;
    if (sol == null && !tokenList && !sigs) throw new Error(errors.join("; ") || "all data sources failed");
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=60, stale-if-error=600");
    res.status(200).json({
      wallet: WALLET, sol, solPrice, solCh24: pr[SOL_MINT]?.ch24 ?? null, totalUsd,
      tokens, tokensOk: !!tokenList, tokensStale, tokensPartial, tokensSource: hold?.source || (tokensStale ? "cache" : null),
      spam: spam.map(s => ({ mint: s.mint, amount: s.amount })),
      txs: txsOut, errors, updated: Date.now(),
    });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e.message || e), errors });
  }
};
