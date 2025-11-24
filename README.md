# EVM Profiler — Pro Plus (Tokens + CSV)

Browser-only Ethereum traffic profiler with:

- Concurrent block scanning
- Provider presets (Infura, Alchemy, Erigon, Public Node, Local)
- Optional dual-pass token detection (logs + receipts)
- Rich tx-type breakdown (ETH, ERC-20/721/1155, mixed token activity)
- Token metadata panel (ERC-20 name/symbol/decimals)
- CSV upload for offline visualization
- Spamoor scenario YAML export (combined + per-scenario)
- Live/Offline mode indicator

Everything runs in your browser using a JSON-RPC endpoint (no backend service).

---

## 1. Files

- **`EVM_Profiler_pro_plus_tokens_csv.html`** – single-page app, open directly in a modern browser.
- Output artifacts created via buttons in the UI:
  - `summary.json` – JSON summary of the run
  - `per_block.csv` – per-block stats for the scanned range
  - `tokens.json` – resolved token metadata and usage counts
  - `spamoor_scenarios.yaml` – combined Spamoor scenarios approximating the observed mix
  - `spamoor_<scenario>.yaml` – one YAML file per scenario (e.g. `spamoor_eoatx.yaml`, `spamoor_erctx.yaml`, etc.)

You do **not** need `block_profiler.py` for the browser-only mode, but you can still use CSV upload to visualize outputs from a separate CLI if you want.

---

## 2. Requirements

- Modern browser (Chrome / Edge / Firefox / Safari).
- An Ethereum JSON-RPC URL with archive or near-archive coverage for your target range, for example:
  - Infura
  - Alchemy
  - Public Node
  - Local Erigon / Geth / Nethermind

No Node.js or Python is required for this HTML-only workflow.

---

## 3. Live vs Offline mode

At the top of the page, next to the subtitle, there is a **mode pill**:

- 🟢 **Live RPC** – the current view is based on a live RPC scan.
- 🟠 **Offline CSV** – the current view is based purely on a loaded CSV file.

The mode pill updates automatically when:

- You run a new profile via RPC (Live RPC).
- You load a CSV (Offline CSV).

This makes it clear at a glance whether the charts and tables are coming from a live run or an offline artifact.

---

## 4. Basic usage (live RPC mode)

1. **Open the HTML file**

   Open `EVM_Profiler_pro_plus_tokens_csv.html` in your browser (double-click or drag into a tab).

2. **Connect to RPC**

   - Paste your RPC URL into the **RPC** field.
   - Click **Connect**.
   - Status will show **Connected** and the heartbeat indicator turns green if successful.

3. **Choose a provider preset** (optional but recommended)

   Use the **Provider** dropdown:

   - `Infura` – conservative page size and concurrency
   - `Alchemy` – slightly larger page & higher concurrency
   - `Erigon` / `Local` – aggressive settings for local nodes
   - `Public Node` – safer settings for shared endpoints
   - `Custom` – lets you manually tune everything

   The preset will auto-fill:

   - **Page** – number of blocks per chunk
   - **Conc.** – concurrency for block fetching
   - Internal logs-scan step size for dual-pass mode

4. **Set block range**

   - **Start** – starting block number (inclusive)
   - **End** – ending block number (inclusive)

5. **Optional settings**

   - **Page** – chunk size in blocks (overrides preset if changed)
   - **Conc.** – number of concurrent block fetch workers
   - **Skip contract check** – if enabled (default), skips `eth_getCode` checks (faster).
   - **Dual-pass (logs + receipts)** – if enabled:
     - Pass 1 scans logs for token transfers and collects tx hashes.
     - Pass 2 fetches receipts only for token-related txs.
   - **Tx cap** – optional integer to stop after a given number of txs (even if block range is not fully processed).

6. **Run & Stop**

   - Click **▶ Run** to start profiling.
   - Progress bar and block text show how far the scan has progressed.
   - The heartbeat indicator shows the current activity (logs scan, block, etc.).
   - Click **■ Stop** to safely request cancellation:
     - All loops and workers check a shared cancellation flag.
     - Logs pass and block pass both terminate cleanly.

7. **Inspect results**

   After a successful run:

   - **Overview** panel shows:
     - Block range and count
     - Total tx and approximate tx/sec
     - Dominant tx type and count
     - Chain ID and whether data is live or from CSV
   - **Transaction types** section:
     - Bar chart of tx counts by type
     - Doughnut chart of share by type
   - **Tx-type table**:
     - Per-type count
     - Gas used
     - Avg gas price in gwei

Tx types include:

- `eth_transfer`
- `contract_creation`
- `erc20_transfer`
- `erc721_transfer`
- `erc1155_transfer`
- `mixed_token_activity`
- `other_contract_call`

---

## 5. Token metadata panel

The **Token metadata** panel shows ERC-20-like contracts observed during the run and lets you resolve basic metadata.

### 5.1 How tokens are discovered

During classification, whenever a log with `Transfer(address,address,uint256)` is seen:

- The log’s `address` is treated as a token contract.
- Its address is added to the token list.
- A simple `tx_count` for that token is maintained.

### 5.2 Resolving metadata

1. Run a profile over a block range that includes token transfers.
2. In the **Token metadata** panel, click **Resolve ERC-20 metadata**.
3. For each observed token address, the app will attempt to call:
   - `symbol()`
   - `name()`
   - `decimals()`
4. The table will fill in:
   - Address
   - Symbol
   - Name
   - Decimals
   - Tx count

> Note: Some contracts may not implement standard ERC-20 methods or may revert. Those entries will keep `?`/blank fields.

### 5.3 Exporting tokens

- Click **Export tokens.json** to download a JSON array of objects:
  ```json
  {
    "address": "0x...",
    "tx_count": 123,
    "symbol": "TOKEN",
    "name": "Token Name",
    "decimals": 18,
    "resolved": true
  }
  ```

You can feed this into other tools or merge with your own token registry.

---

## 6. CSV upload (offline visualization)

You can visualize results from a previous run (or from another tool) without any RPC calls using **CSV offline mode**.

### 6.1 Expected CSV format

The UI expects a CSV roughly matching the `per_block.csv` that this tool generates, with at least:

- `block_number`
- `timestamp` (UNIX seconds)
- `tx_count`

And ideally:

- `eth_transfer`
- `contract_creation`
- `erc20_transfer`
- `erc721_transfer`
- `erc1155_transfer`
- `mixed_token_activity`
- `other_contract_call`
- `block_gas_used`
- `block_gas_limit`

Column order doesn’t matter, but header names do.

### 6.2 How to load

1. Click **Choose file** (file picker) next to *Offline mode*.
2. Select a CSV (e.g., one produced by **per_block.csv** export).
3. Click **Load CSV**.

The app will:

- Parse the CSV entirely in the browser.
- Rebuild an internal `summary` and `perBlockRows` from the data.
- Re-render:
  - Overview panel
  - Tx-type charts
  - Tx-type table

The mode pill will switch to **Offline CSV** to indicate you’re viewing offline data.

---

## 7. Spamoor scenario export

There are now **two Spamoor export buttons**:

1. **Spamoor YAML (combined)**  
   - Exports a single `spamoor_scenarios.yaml` file containing all scenarios in one YAML stream.
2. **Spamoor YAML (per scenario)**  
   - Exports one YAML file per scenario, e.g.:
     - `spamoor_eoatx.yaml`
     - `spamoor_erctx.yaml`
     - `spamoor_deploytx.yaml`
     - `spamoor_calltx.yaml`

### 7.1 How scenarios are built

- Maps tx types to scenario kinds:
  - `eth_transfer` → `eoatx`
  - `erc20_transfer` → `erctx`
  - `contract_creation` → `deploytx`
  - Everything else → `calltx`
- Estimates throughput per scenario based on:
  - Observed counts
  - Approximate slots inferred from block timestamps
- Approximates `base_fee` from average gas price minus a default tip.
- Sets basic refill, wallet, and pending config values.

You can paste or refine these scenarios inside your Spamoor configs or run them individually using the per-scenario YAMLs.

---

## 8. Tips & troubleshooting

- If your provider rate-limits you:
  - Lower **Conc.** (e.g. 2–4)
  - Lower **Page** size
  - Consider disabling **Dual-pass** if logs are heavy.
- If runs feel slow but stable:
  - Increase **Page** and **Conc.** cautiously, especially on local nodes.
- If token resolution is flaky:
  - Some tokens use non-standard ABIs or revert on metadata calls—this is expected.

---

## 9. Safety notes

- All computation happens in your browser; RPC keys are not sent anywhere else.
- RPC endpoints should be treated as secrets; do not commit this HTML with a hard-coded key.
- For very large ranges, use **Tx cap** and/or **Dual-pass** to keep calls manageable.

Enjoy profiling your chain traffic in the browser!
