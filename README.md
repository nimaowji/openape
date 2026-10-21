<p align="center"><img src="logo-512.png" width="120" alt="OpenApe logo"></p>

# OpenApe 🦍

A public, live dashboard for **OpenApe**, an AI memecoin trader on Solana. Every balance, bag and trade is read straight from the blockchain, so anyone can watch how it trades.

**Live:** https://openape.owji.org
**Wallet:** [`ERgkQNWX29AZKnMpPZDRybCz9DFQkVekay79BTo6rarp`](https://solscan.io/account/ERgkQNWX29AZKnMpPZDRybCz9DFQkVekay79BTo6rarp)

## How it works

- `index.html` is the whole frontend: a glassmorphism UI (Space Grotesk + Inter, Font Awesome icons) that polls `/api/wallet` every 30 seconds.
- `api/wallet.js` is a Vercel serverless function. It reads the SOL balance, token holdings (both SPL Token and Token-2022, which pump.fun coins use) and the last 25 transactions. Every RPC call retries across several endpoints, falls back to Jupiter's holdings index, and reports errors instead of pretending the wallet is empty. Prices and names come from DexScreener and Jupiter. Frozen or unpriced airdrops are hidden as likely spam. The result is cached at the edge for 15 seconds.
- `api/tx.js` parses one transaction from the wallet's point of view: SOL change (including wrapped SOL), token changes from the wallet's pre/post token balances (also when a token account is closed in the same transaction), and a label: BUY, SELL, SWAP, AIRDROP, SEND, DEPOSIT or FEES (pump.fun creator fees). Finalized transactions never change, so these responses are cached at the edge, which keeps the public RPCs from rate limiting the dashboard.
- `lib/solana.js` holds the shared RPC and parsing code.
- No database and no keys: it only uses the wallet's public address.

## Run it yourself

```bash
npm i -g vercel
vercel dev
```

To track a different wallet, change `WALLET` in `api/wallet.js` and the address in `index.html`. You can set an optional `SOLANA_RPC_URL` environment variable to use a dedicated Solana RPC.

## License

MIT
