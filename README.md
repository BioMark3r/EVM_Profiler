[# 🧮 EVM Block Profiler (CLI + React UI)

A complete toolkit for profiling Ethereum-compatible blockchain traffic by block range.

Includes:
- **CLI tool (`block_profiler.py`)** — For large-scale, accurate profiling.
- **Web UI (`react_block_profiler.jsx`)** — For interactive visualization and quick on-chain inspection.

---

## ⚙️ Setup

### Prerequisites

Ensure you have **Python 3.9+**, **Node.js 18+**, and **npm** installed.

#### macOS Quick Setup
```bash
brew install python3 node
```

### Python Setup (CLI)
Install dependencies from `requirements.txt`:

```bash
pip install -r requirements.txt
```

### Node Setup (Web UI)
From your React project folder (where you copy `react_block_profiler.jsx`):

```bash
npm install react react-dom web3 recharts
```

Then import the component in your app:

```jsx
import BlockProfilerApp from './react_block_profiler.jsx';

export default function App() {
  return <BlockProfilerApp />;
}
```

Run your dev server as usual (`npm run dev` or `npm start`).

---

## 🚀 Running the CLI

The CLI connects to any **EVM JSON-RPC endpoint** (Infura, Alchemy, Ankr, QuickNode, Erigon, or local node).

Example (Ethereum mainnet via Infura):

```bash
python block_profiler.py   --rpc https://mainnet.infura.io/v3/YOUR_KEY   --start 21000000 --end 21000100   --out summary.json --csv per_block.csv
```

### Common Options
| Option | Description |
|--------|--------------|
| `--rpc` | JSON-RPC endpoint (required) |
| `--start` / `--end` | Start and end block (inclusive) |
| `--out` | JSON summary output file |
| `--csv` | Per-block CSV output |
| `--skip-contract-check` | Skip contract code lookups (faster) |
| `--tx-cap N` | Max transactions to process |
| `--concurrency N` | Threads for concurrent receipt fetching (default: 8) |
| `--chunk-size N` | Blocks per pagination chunk (default: 50) |
| `--trace [none|erigon|geth]` | Internal value tracing mode |

---

## 🧩 Example Usages

### Simple ETH transfer profiling
```bash
python block_profiler.py   --rpc https://mainnet.infura.io/v3/YOUR_KEY   --start 21000000 --end 21000100
```

### Paginated profiling for large ranges
```bash
python block_profiler.py   --rpc https://mainnet.infura.io/v3/YOUR_KEY   --start 19000000 --end 19100000   --chunk-size 200 --concurrency 16
```

### Internal value tracing (Erigon)
```bash
python block_profiler.py   --rpc https://erigon.your-node.io   --start 21000000 --end 21000100   --trace erigon
```

### Heavy tracing (Geth)
```bash
python block_profiler.py   --rpc http://localhost:8545   --start 21000000 --end 21000100   --trace geth
```

---

## 🌐 Using the Web UI

The **React Web UI** connects directly to an RPC or visualizes CLI outputs.

### Upload Mode (Offline Visualization)
You can upload your CLI’s outputs directly:
- `summary.json` → Overview summary
- `per_block.csv` → Per-block detailed breakdown

### Live RPC Mode (Interactive)
1. Enter your RPC endpoint, start and end blocks.
2. Adjust **Page Size** and click **Profile current page**.
3. Navigate through block pages using the **< >** controls.

### ERC-20 Token Lookup
If you have an RPC entered, click **Resolve token symbols via RPC** to fetch token names/symbols for the top tokens.

---

## 📊 Outputs

### `summary.json`
Aggregated statistics:
- Transaction counts by type
- Gas and ETH usage
- Top contracts and tokens
- Internal value transfer totals (if tracing enabled)

### `per_block.csv`
Detailed per-block breakdowns, suitable for graphing and deeper data analysis.

---

## ⚠️ Quick Notes

- **Erigon vs. Geth tracing:** Erigon’s `trace_block` is faster and more reliable for internal transfers.
- **Concurrency:** Adjust `--concurrency` for your RPC’s limits. Typical safe range: 4–16.
- **Chunking:** Large ranges should use `--chunk-size` (e.g., 50–500 blocks) to avoid timeouts.
- **Unique senders/receivers:** Aggregated unique address counts are set to `-1` when chunking is used (for memory efficiency).
- **Web UI limits:** Browser RPC queries are best for small windows (<1000 transactions). Use the CLI for larger analyses.
- **Token lookups:** ERC-20 metadata fetches are optional; they require the token contracts to expose `name()`, `symbol()`, and `decimals()`.

---

## 📁 Output Files

| File | Description |
|------|--------------|
| `summary.json` | High-level aggregated metrics |
| `per_block.csv` | Per-block transaction type counts |
| `requirements.txt` | Python dependencies |
| `react_block_profiler.jsx` | Web UI component |

---

## 🧠 Future Extensions

- Optional HyperLogLog unique tracking for sender/receiver counts.
- PostgreSQL export integration.
- WebSocket live-mode profiling for tailing latest blocks.

---

## 📜 License

MIT — free for personal and commercial use.
](https://github.com/ethpandaops/spamoor/blob/master/docs/scenario-developers.md)
