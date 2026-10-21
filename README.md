<p align="center"><img src="logo-512.png" width="120" alt="OpenApe logo"></p>

# OpenApe 🦍

A public, live dashboard for **OpenApe**, an AI memecoin trader on Solana. Every balance, bag and trade is read straight from the blockchain, so anyone can watch how it trades.

**Live:** https://openape.owji.org
**Wallet:** [`ERgkQNWX29AZKnMpPZDRybCz9DFQkVekay79BTo6rarp`](https://solscan.io/account/ERgkQNWX29AZKnMpPZDRybCz9DFQkVekay79BTo6rarp)

## How it works

- `index.html` is the whole frontend: a glassmorphism UI (Space Grotesk + Inter, Font Awesome icons) that polls `/api/wallet` every 30 seconds.
- `api/wallet.js` is a Vercel serverless function. It reads the SOL balance, SPL token holdings and recent transactions from public Solana RPCs, prices tokens through Jupiter (DexScreener fallback), labels recent transactions as BUY / SELL / DEPOSIT / SEND, and caches the result for 15 seconds.
- No database and no keys: it only uses the wallet's public address.

## Run it yourself

```bash
npm i -g vercel
vercel dev
```

To track a different wallet, change `WALLET` in `api/wallet.js` and the address in `index.html`. You can set an optional `SOLANA_RPC_URL` environment variable to use a dedicated Solana RPC.

## License

MIT
