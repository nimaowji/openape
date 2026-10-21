const WALLET = "ERgkQNWX29AZKnMpPZDRybCz9DFQkVekay79BTo6rarp";
const RPCS = [process.env.SOLANA_RPC_URL, "https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"].filter(Boolean);
const SOL = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
async function rpc(method, params) {
  let err;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { err = e; }
  }
  throw err;
}
async function prices(mints) {
  const out = {};
  try {
    for (let i = 0; i < mints.length; i += 50) {
      const r = await fetch("https://lite-api.jup.ag/price/v3?ids=" + mints.slice(i, i + 50).join(","));
      const j = await r.json();
      for (const [k, v] of Object.entries(j || {})) if (v && v.usdPrice) out[k] = { usd: v.usdPrice, ch24: v.priceChange24h };
    }
  } catch {}
  return out;
}
async function meta(mints) {
  const out = {};
  try {
    for (let i = 0; i < mints.length; i += 30) {
      const r = await fetch("https://api.dexscreener.com/tokens/v1/solana/" + mints.slice(i, i + 30).join(","));
      const j = await r.json();
      for (const p of j || []) {
        const m = p.baseToken?.address; if (!m || out[m]) continue;
        out[m] = { symbol: p.baseToken.symbol, name: p.baseToken.name, icon: p.info?.imageUrl, priceUsd: Number(p.priceUsd) || null, url: p.url };
      }
    }
  } catch {}
  return out;
}
module.exports = async (req, res) => {
  try {
    const [bal, sigs, ...tas] = await Promise.all([
      rpc("getBalance", [WALLET]),
      rpc("getSignaturesForAddress", [WALLET, { limit: 25 }]),
      ...TOKEN_PROGRAMS.map(p => rpc("getTokenAccountsByOwner", [WALLET, { programId: p }, { encoding: "jsonParsed" }]).catch(() => ({ value: [] })))
    ]);
    const tokens = tas.flatMap(t => t.value).map(a => a.account.data.parsed.info)
      .map(i => ({ mint: i.mint, amount: i.tokenAmount.uiAmount || 0 })).filter(t => t.amount > 0);
    const mints = tokens.map(t => t.mint);
    const [pr, md] = await Promise.all([prices([SOL, ...mints]), meta(mints)]);
    for (const t of tokens) {
      const m = md[t.mint] || {};
      const price = pr[t.mint]?.usd ?? m.priceUsd ?? null;
      Object.assign(t, { symbol: m.symbol || t.mint.slice(0, 4) + "…", name: m.name || "Unknown token", icon: m.icon || null, dex: m.url || null, price, usd: price != null ? price * t.amount : null, ch24: pr[t.mint]?.ch24 ?? null });
    }
    tokens.sort((a, b) => (b.usd || 0) - (a.usd || 0));
    // Enrich the most recent txs with SOL / token deltas
    const txs = [];
    const detail = await Promise.all(sigs.slice(0, 12).map(s => rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]).catch(() => null)));
    sigs.forEach((s, idx) => {
      const t = { sig: s.signature, time: s.blockTime, ok: !s.err, kind: "tx", sol: null, changes: [] };
      const d = detail[idx];
      if (d && d.meta) {
        const keys = d.transaction.message.accountKeys.map(k => k.pubkey || k);
        const i = keys.indexOf(WALLET);
        if (i >= 0) t.sol = (d.meta.postBalances[i] - d.meta.preBalances[i]) / 1e9;
        const pre = {}, post = {};
        for (const b of d.meta.preTokenBalances || []) if (b.owner === WALLET) pre[b.mint] = b.uiTokenAmount.uiAmount || 0;
        for (const b of d.meta.postTokenBalances || []) if (b.owner === WALLET) post[b.mint] = b.uiTokenAmount.uiAmount || 0;
        for (const m of new Set([...Object.keys(pre), ...Object.keys(post)])) {
          const delta = (post[m] || 0) - (pre[m] || 0);
          if (Math.abs(delta) > 0) t.changes.push({ mint: m, delta, symbol: md[m]?.symbol || m.slice(0, 4) + "…" });
        }
        const logs = (d.meta.logMessages || []).join(" ");
        t.kind = t.changes.length && (/JUP|Jupiter|swap|Swap|Raydium|pump/i.test(logs) || t.changes.length) ? (t.changes.some(c => c.delta > 0) ? "BUY" : "SELL") : (t.sol > 0 ? "DEPOSIT" : t.sol < 0 ? "SEND" : "TX");
      }
      txs.push(t);
    });
    const solPrice = pr[SOL]?.usd ?? null;
    const sol = bal.value / 1e9;
    const total = (solPrice ? sol * solPrice : 0) + tokens.reduce((a, t) => a + (t.usd || 0), 0);
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
    res.status(200).json({ wallet: WALLET, sol, solPrice, solCh24: pr[SOL]?.ch24 ?? null, totalUsd: total, tokens, txs, updated: Date.now() });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
};
