// Shared helpers for the OpenApe API: resilient Solana RPC + transaction parsing.
const WALLET = "ERgkQNWX29AZKnMpPZDRybCz9DFQkVekay79BTo6rarp";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
// SOLANA_RPC_URL (optional, comma-separated) is tried first. The public endpoints below are free but rate limited,
// so every call retries with backoff and rotates through them.
const RPCS = [
  ...(process.env.SOLANA_RPC_URL || "").split(",").map(s => s.trim()).filter(Boolean),
  "https://api.mainnet-beta.solana.com",
  "https://api.mainnet.solana.com",
  "https://solana-rpc.publicnode.com",
];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { throw new Error(`HTTP ${r.status}: ${text.slice(0, 120)}`); }
    if (!r.ok && !j?.error) throw new Error(`HTTP ${r.status}`);
    return j;
  } finally { clearTimeout(t); }
}

// Call an RPC method, rotating through endpoints with retries. Throws a descriptive error if all fail.
async function rpc(method, params, { attempts = 2, timeoutMs = 8000 } = {}) {
  const errs = [];
  for (let a = 0; a < attempts; a++) {
    for (const url of RPCS) {
      try {
        const j = await fetchJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }, timeoutMs);
        if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
        if (j.result === undefined) throw new Error("empty result");
        return j.result;
      } catch (e) {
        if (/not supported by the requesting client|Invalid param|invalid type|WrongSize/i.test(e.message)) throw e; // deterministic, don't retry
        errs.push(`${new URL(url).host}: ${String(e.message || e).slice(0, 100)}`);
      }
    }
    if (a < attempts - 1) await sleep(400 * (a + 1) + Math.random() * 300);
  }
  const err = new Error(`${method} failed on all RPCs (${errs.slice(-3).join(" | ")})`);
  err.details = errs;
  throw err;
}

const LAMPORTS = 1e9;
const amt = b => { const t = b?.uiTokenAmount; if (!t) return 0; const n = Number(t.amount) / 10 ** (t.decimals || 0); return Number.isFinite(n) ? n : Number(t.uiAmountString || t.uiAmount || 0); };

// Parse a jsonParsed transaction into what it meant for WALLET.
function parseTx(sig, d) {
  const out = { sig, time: d?.blockTime ?? null, ok: !d?.meta?.err, kind: "TX", sol: null, changes: [] };
  if (!d || !d.meta) return out;
  const m = d.meta;
  const keys = (d.transaction?.message?.accountKeys || []).map(k => (typeof k === "string" ? k : k.pubkey));
  const wi = keys.indexOf(WALLET);
  let lamports = wi >= 0 ? m.postBalances[wi] - m.preBalances[wi] : 0;

  // Token balances owned by the wallet, keyed by account index (an account closed in this tx simply has no post entry => 0).
  const byIdx = {};
  for (const [side, list] of [["pre", m.preTokenBalances], ["post", m.postTokenBalances]]) {
    for (const b of list || []) {
      if (b.owner !== WALLET) continue;
      const e = (byIdx[b.accountIndex] ||= { mint: b.mint, pre: 0, post: 0, pubkey: keys[b.accountIndex] });
      e[side] = amt(b);
    }
  }
  const deltas = {};
  for (const [idx, e] of Object.entries(byIdx)) {
    if (e.mint === SOL_MINT) {
      // Wrapped SOL account owned by the wallet: count its lamport change as SOL (handles wrap/unwrap/close correctly).
      lamports += (m.postBalances[idx] ?? 0) - (m.preBalances[idx] ?? 0);
      continue;
    }
    deltas[e.mint] = (deltas[e.mint] || 0) + (e.post - e.pre);
  }
  out.sol = lamports / LAMPORTS;
  // Wallet-owned token accounts touched by this tx (used as a holdings fallback when indexed RPC calls are rate limited).
  out.accounts = Object.values(byIdx).filter(e => e.mint !== SOL_MINT && e.pubkey).map(e => ({ pubkey: e.pubkey, mint: e.mint }));
  for (const [mint, delta] of Object.entries(deltas)) if (Math.abs(delta) > 1e-12) out.changes.push({ mint, delta });

  const logs = (m.logMessages || []).join("\n");
  const ins = out.changes.filter(c => c.delta > 0), outs = out.changes.filter(c => c.delta < 0);
  const s = out.sol;
  if (!out.ok) out.kind = "FAILED";
  else if (ins.length && outs.length) out.kind = "SWAP";
  else if (ins.length) out.kind = s < -0.002 ? "BUY" : "RECEIVE";
  else if (outs.length) out.kind = s > 0.0005 ? "SELL" : "SEND";
  else if (/CreatorFee|creator_fee|CollectCoinCreatorFee/i.test(logs) && s > 0) out.kind = "FEES";
  else if (s > 0) out.kind = "DEPOSIT";
  else if (s < 0) out.kind = "SEND";
  if (/JUP[0-9A-Za-z]{30,}|Jupiter/.test(logs)) out.via = "Jupiter";
  else if (/6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P|pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA/.test(logs)) out.via = "pump.fun";
  else if (/675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8|CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK|CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C/.test(logs)) out.via = "Raydium";
  else if (/LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo|cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG/.test(logs)) out.via = "Meteora";
  return out;
}

async function fetchTx(sig) {
  const d = await rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }], { attempts: 3 });
  if (!d) throw new Error("transaction not found yet");
  return parseTx(sig, d);
}

module.exports = { WALLET, SOL_MINT, TOKEN_PROGRAMS, RPCS, rpc, fetchJson, parseTx, fetchTx, sleep };
