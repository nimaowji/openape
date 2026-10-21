// GET /api/tx?sig=<signature> -> parsed transaction for the OpenApe wallet.
// Finalized transactions never change, so successful responses are cached at the edge for a long time;
// this is what keeps /api/wallet from hammering the public RPCs.
const { fetchTx } = require("../lib/solana");
const mem = globalThis.__oaTx ||= new Map();
module.exports = async (req, res) => {
  const sig = String(req.query?.sig || "");
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) return res.status(400).json({ error: "bad signature" });
  try {
    let t = mem.get(sig);
    if (!t) { t = await fetchTx(sig); if (t.time && Date.now() / 1e3 - t.time > 60) mem.set(sig, t); }
    const old = t.time && Date.now() / 1e3 - t.time > 60;
    res.setHeader("Cache-Control", old ? "public, s-maxage=31536000, max-age=86400, immutable" : "s-maxage=10");
    res.status(200).json(t);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ error: String(e.message || e) });
  }
};
