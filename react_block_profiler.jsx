import React, { useMemo, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import Web3 from "web3";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
} from "recharts";

// --- Constants: topic signatures ---
const SIG_TRANSFER = Web3.utils.keccak256("Transfer(address,address,uint256)");
const SIG_ERC1155_SINGLE = Web3.utils.keccak256(
  "TransferSingle(address,address,address,uint256,uint256)"
);
const SIG_ERC1155_BATCH = Web3.utils.keccak256(
  "TransferBatch(address,address,address,uint256[],uint256[])"
);

const DEFAULT_TYPES = [
  "eth_transfer",
  "contract_creation",
  "erc20_transfer",
  "erc721_transfer",
  "erc1155_transfer",
  "other_contract_call",
  "mixed_token_activity",
  "other_eoa_call",
];

function bytesToHexTopic(x) {
  if (!x) return "";
  if (typeof x === "string") return x.toLowerCase();
  try {
    return Web3.utils.bytesToHex(x).toLowerCase();
  } catch {
    return String(x).toLowerCase();
  }
}

function classifyFromLogs(logs) {
  let erc20 = 0,
    erc721 = 0,
    erc1155 = 0;
  const tokens = new Map();

  for (const lg of logs || []) {
    if (!lg.topics || lg.topics.length === 0) continue;
    const topic0 = bytesToHexTopic(lg.topics[0]);
    const addr = (lg.address || "").toLowerCase();
    if (topic0 === SIG_TRANSFER.toLowerCase()) {
      if (lg.data && lg.data !== "0x") {
        erc20 += 1;
      } else {
        erc721 += 1;
      }
      tokens.set(addr, (tokens.get(addr) || 0) + 1);
    } else if (
      topic0 === SIG_ERC1155_SINGLE.toLowerCase() ||
      topic0 === SIG_ERC1155_BATCH.toLowerCase()
    ) {
      erc1155 += 1;
      tokens.set(addr, (tokens.get(addr) || 0) + 1);
    }
  }

  const topToken = [...tokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  if (erc20 > 0 && erc721 === 0 && erc1155 === 0) return ["erc20_transfer", topToken];
  if (erc721 > 0 && erc20 === 0 && erc1155 === 0) return ["erc721_transfer", topToken];
  if (erc1155 > 0 && erc20 === 0 && erc721 === 0) return ["erc1155_transfer", topToken];
  if (erc20 || erc721 || erc1155) return ["mixed_token_activity", topToken];
  return ["other_contract_call", null];
}

function weiToEth(wei) {
  try {
    return Number(Web3.utils.fromWei(String(wei), "ether"));
  } catch {
    return 0;
  }
}

function prettyNum(n) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(n);
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadCsv(rows, filename) {
  const csv = rows
    .map((r) => r.map((v) => (typeof v === "string" && v.includes(",") ? `"${v}"` : v)).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function BlockProfilerApp() {
  const [rpcUrl, setRpcUrl] = useState("");
  const [startBlock, setStartBlock] = useState(0);
  const [endBlock, setEndBlock] = useState(0);
  const [selectedTypes, setSelectedTypes] = useState(new Set(DEFAULT_TYPES));
  const [skipContractCheck, setSkipContractCheck] = useState(true);
  const [limitTx, setLimitTx] = useState(1000);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState(null);
  const [perBlock, setPerBlock] = useState([]);
  const w3Ref = useRef(null);
  const contractCacheRef = useRef(new Map());

  const canProfile = rpcUrl && startBlock > 0 && endBlock >= startBlock;

  async function ensureWeb3() {
    if (!w3Ref.current) {
      w3Ref.current = new Web3(new Web3.providers.HttpProvider(rpcUrl, { timeout: 60_000 }));
    }
    return w3Ref.current;
  }

  function toggleType(t) {
    const next = new Set(selectedTypes);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setSelectedTypes(next);
  }

  async function isContract(address) {
    try {
      const cache = contractCacheRef.current;
      const key = address.toLowerCase();
      if (cache.has(key)) return cache.get(key);
      const code = await w3Ref.current.eth.getCode(address);
      const isC = !!code && code !== "0x";
      cache.set(key, isC);
      return isC;
    } catch {
      return false;
    }
  }

  async function runProfile() {
    try {
      setSummary(null);
      setPerBlock([]);
      setStatus("Connecting...");
      const w3 = await ensureWeb3();
      const connected = await w3.eth.net.isListening().catch(() => false);
      if (!connected) throw new Error("Could not connect to RPC endpoint");
      const chainId = await w3.eth.getChainId();

      const txTypeStats = new Map(); // type -> {count, gasUsed, gasPriceSum, ethValueSum}
      const initStats = () => ({ count: 0, gasUsed: 0, gasPriceWeiSum: 0n, ethValueWeiSum: 0n });
      const uniqueFrom = new Set();
      const uniqueTo = new Set();
      let totalEthWei = 0n;
      let totalTx = 0;
      const topContracts = new Map();
      const topTokens = new Map();

      const rows = [];
      const blockCount = endBlock - startBlock + 1;

      let txProcessed = 0;
      setStatus("Fetching blocks...");

      for (let b = startBlock; b <= endBlock; b++) {
        const blk = await w3.eth.getBlock(b, true);
        const blockCounts = new Map();
        let blockGasUsed = 0n;

        for (const tx of blk.transactions) {
          if (txProcessed >= Number(limitTx)) break;
          totalTx += 1;
          txProcessed += 1;
          if (tx.from) uniqueFrom.add(tx.from.toLowerCase());
          if (tx.to) uniqueTo.add(tx.to.toLowerCase());

          const receipt = await w3.eth.getTransactionReceipt(tx.hash);
          blockGasUsed += BigInt(receipt.gasUsed || 0);
          const gasPriceWei = BigInt(tx.gasPrice || 0);
          const valueWei = BigInt(tx.value || 0);

          let txType = "";
          let tokenOrContract = null;

          if (!tx.to) {
            txType = "contract_creation";
          } else {
            const [cls, tok] = classifyFromLogs(receipt.logs || []);
            txType = cls;
            tokenOrContract = tok;
            if (txType === "other_contract_call") {
              if (valueWei > 0n) {
                txType = "eth_transfer";
              } else if (!skipContractCheck) {
                const isC = await isContract(tx.to);
                if (!isC) txType = valueWei > 0n ? "eth_transfer" : "other_eoa_call";
              }
            }
          }

          // Update per-type stats
          if (!txTypeStats.has(txType)) txTypeStats.set(txType, initStats());
          const s = txTypeStats.get(txType);
          s.count += 1;
          s.gasUsed += Number(receipt.gasUsed || 0);
          s.gasPriceWeiSum += gasPriceWei;
          s.ethValueWeiSum += valueWei;

          blockCounts.set(txType, (blockCounts.get(txType) || 0) + 1);
          totalEthWei += valueWei;

          if (tx.to) topContracts.set(tx.to.toLowerCase(), (topContracts.get(tx.to.toLowerCase()) || 0) + 1);
          if (tokenOrContract) topTokens.set(tokenOrContract.toLowerCase(), (topTokens.get(tokenOrContract.toLowerCase()) || 0) + 1);

          setProgress(Math.round(((b - startBlock) / blockCount) * 100));
        }

        rows.push([
          blk.number,
          blk.timestamp,
          blk.transactions.length,
          DEFAULT_TYPES.map((t) => blockCounts.get(t) || 0).join("|"), // keep compact
          Number(blk.gasUsed || blockGasUsed),
          Number(blk.gasLimit || 0),
        ]);
      }

      const txTypesObj = {};
      for (const [k, v] of txTypeStats.entries()) {
        txTypesObj[k] = {
          count: v.count,
          gas_used: v.gasUsed,
          avg_gas_price_gwei: Number(v.gasPriceWeiSum) / Math.max(v.count, 1) / 1e9,
          eth_value_sum_eth: weiToEth(v.ethValueWeiSum),
        };
      }

      const topContractsArr = [...topContracts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
      const topTokensArr = [...topTokens.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

      const summaryObj = {
        start_block: startBlock,
        end_block: endBlock,
        chain_id: Number(chainId),
        block_count: endBlock - startBlock + 1,
        total_tx: totalTx,
        unique_senders: uniqueFrom.size,
        unique_receivers: uniqueTo.size,
        total_eth_transferred_eth: weiToEth(totalEthWei),
        tx_types: txTypesObj,
        top_contracts_by_tx: topContractsArr,
        top_tokens_by_events: topTokensArr,
        notes: [
          "ERC20 vs ERC721 is inferred from Transfer event payload (amount vs none).",
          "Mixed token activity indicates multiple token standards in a single tx.",
          "ETH transferred sums only tx.value; internal transfers not included.",
          `Caution: client-side profiling is rate limited; you limited to ${limitTx} tx.`,
        ],
      };

      setSummary(summaryObj);
      setPerBlock(rows);
      setStatus("Done");
      setProgress(100);
    } catch (e) {
      console.error(e);
      setStatus("Error: " + (e?.message || String(e)));
    }
  }

  const chartData = useMemo(() => {
    if (!summary) return [];
    const entries = Object.entries(summary.tx_types || {});
    return entries.map(([k, v]) => ({ type: k, count: v.count }));
  }, [summary]);

  const filteredTxTypes = useMemo(() => new Set(selectedTypes), [selectedTypes]);

  const perBlockTable = useMemo(() => {
    const header = [
      "Block",
      "Timestamp",
      "Tx Count",
      ...DEFAULT_TYPES,
      "Block Gas Used",
      "Gas Limit",
    ];

    const rows = perBlock.map((r) => {
      const counts = (r[3] || "").split("|").map((x) => Number(x || 0));
      const record = {};
      DEFAULT_TYPES.forEach((t, i) => (record[t] = counts[i]));
      const filteredCount = [...filteredTxTypes].reduce((acc, t) => acc + (record[t] || 0), 0);
      return {
        block: r[0],
        timestamp: new Date(r[1] * 1000).toLocaleString(),
        tx: r[2],
        ...record,
        filteredCount,
        gasUsed: r[4],
        gasLimit: r[5],
      };
    });

    return { header, rows };
  }, [perBlock, filteredTxTypes]);

  function exportSummary() {
    if (summary) downloadJson(summary, `summary_${startBlock}_${endBlock}.json`);
  }

  function exportCSV() {
    const header = [
      "block_number",
      "timestamp",
      "tx_count",
      ...DEFAULT_TYPES,
      "block_gas_used",
      "block_gas_limit",
    ];
    const data = perBlock.map((r) => [
      r[0],
      r[1],
      r[2],
      ...(r[3] || "").split("|").map((x) => Number(x || 0)),
      r[4],
      r[5],
    ]);
    downloadCsv([header, ...data], `per_block_${startBlock}_${endBlock}.csv`);
  }

  return (
    <div style={{ fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial", padding: 20, lineHeight: 1.4 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>EVM Block Profiler</h1>
      <p style={{ color: "#444" }}>
        Select a block range and filters, then profile activity directly from your RPC.
        For best results, keep ranges modest in the browser and use a provider that allows receipts & code lookups.
      </p>

      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12, alignItems: "end" }}>
        <div style={{ gridColumn: "1 / -1" }}>
          <label style={{ display: "block", fontWeight: 600 }}>RPC URL</label>
          <input
            value={rpcUrl}
            onChange={(e) => setRpcUrl(e.target.value)}
            placeholder="https://mainnet.infura.io/v3/YOUR_KEY"
            style={{ width: "100%", padding: 8, border: "1px solid #ccc", borderRadius: 8 }}
          />
        </div>
        <div>
          <label style={{ display: "block", fontWeight: 600 }}>Start Block</label>
          <input
            type="number"
            value={startBlock}
            onChange={(e) => setStartBlock(Number(e.target.value))}
            style={{ width: "100%", padding: 8, border: "1px solid #ccc", borderRadius: 8 }}
          />
        </div>
        <div>
          <label style={{ display: "block", fontWeight: 600 }}>End Block</label>
          <input
            type="number"
            value={endBlock}
            onChange={(e) => setEndBlock(Number(e.target.value))}
            style={{ width: "100%", padding: 8, border: "1px solid #ccc", borderRadius: 8 }}
          />
        </div>
        <div>
          <label style={{ display: "block", fontWeight: 600 }}>Tx Scan Limit</label>
          <input
            type="number"
            value={limitTx}
            onChange={(e) => setLimitTx(Number(e.target.value))}
            title="Max transactions to process for this run"
            style={{ width: "100%", padding: 8, border: "1px solid #ccc", borderRadius: 8 }}
          />
          <small style={{ color: "#666" }}>Caps processed txs to stay friendly with RPCs.</small>
        </div>
        <div>
          <label style={{ display: "block", fontWeight: 600 }}>Options</label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={skipContractCheck}
              onChange={(e) => setSkipContractCheck(e.target.checked)}
            />
            Skip contract code checks (faster)
          </label>
        </div>
      </section>

      <section style={{ marginTop: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Filter by transaction type</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {DEFAULT_TYPES.map((t) => (
            <label key={t} style={{ border: "1px solid #ccc", borderRadius: 16, padding: "6px 10px", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={selectedTypes.has(t)}
                onChange={() => toggleType(t)}
                style={{ marginRight: 8 }}
              />
              {t}
            </label>
          ))}
        </div>
      </section>

      <section style={{ marginTop: 16, display: "flex", gap: 8 }}>
        <button
          onClick={runProfile}
          disabled={!canProfile}
          style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #888", background: canProfile ? "#111" : "#999", color: "#fff", cursor: canProfile ? "pointer" : "not-allowed" }}
        >
          {status && status.startsWith("Error") ? "Retry" : "Profile"}
        </button>
        <div style={{ alignSelf: "center", color: status.startsWith("Error") ? "#b00020" : "#444" }}>{status}</div>
      </section>

      {progress > 0 && progress < 100 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ height: 8, background: "#eee", borderRadius: 8 }}>
            <div style={{ width: `${progress}%`, height: 8, background: "#4a90e2", borderRadius: 8 }} />
          </div>
          <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>{progress}%</div>
        </div>
      )}

      {summary && (
        <section style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 20, margin: 0 }}>Summary</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginTop: 12 }}>
            <Stat label="Blocks" value={`${summary.block_count}`} />
            <Stat label="Total tx" value={`${summary.total_tx}`} />
            <Stat label="Unique senders" value={`${summary.unique_senders}`} />
            <Stat label="Unique receivers" value={`${summary.unique_receivers}`} />
            <Stat label="ETH transferred" value={`${prettyNum(summary.total_eth_transferred_eth)} ETH`} />
            <Stat label="Range" value={`${summary.start_block} – ${summary.end_block}`} />
            <Stat label="Chain ID" value={`${summary.chain_id}`} />
          </div>

          <div style={{ height: 280, marginTop: 20, border: "1px solid #eee", borderRadius: 8, padding: 8 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="type" angle={-15} textAnchor="end" height={55} />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="count" name="Tx count" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button onClick={exportSummary} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #888", background: "#fff" }}>Download summary.json</button>
            <button onClick={exportCSV} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #888", background: "#fff" }}>Download per_block.csv</button>
          </div>

          <div style={{ marginTop: 16 }}>
            <h3 style={{ margin: 0 }}>Per-block (filtered counts)</h3>
            <div style={{ maxHeight: 320, overflow: "auto", border: "1px solid #eee", borderRadius: 8 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <Th>Block</Th>
                    <Th>Time</Th>
                    <Th>Tx</Th>
                    {DEFAULT_TYPES.map((t) => (
                      <Th key={t}>{t}</Th>
                    ))}
                    <Th>Gas Used</Th>
                    <Th>Gas Limit</Th>
                  </tr>
                </thead>
                <tbody>
                  {perBlockTable.rows.map((r) => (
                    <tr key={r.block}>
                      <Td>{r.block}</Td>
                      <Td>{r.timestamp}</Td>
                      <Td>{r.tx}</Td>
                      {DEFAULT_TYPES.map((t) => (
                        <Td key={t}>{r[t]}</Td>
                      ))}
                      <Td>{r.gasUsed}</Td>
                      <Td>{r.gasLimit}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <h3 style={{ margin: 0 }}>Top addresses</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 8 }}>
              <Card title="Top contracts by tx">
                <ol style={{ margin: 0, paddingLeft: 18 }}>
                  {summary.top_contracts_by_tx.map(([addr, c]) => (
                    <li key={addr} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {addr} — {c}
                    </li>
                  ))}
                </ol>
              </Card>
              <Card title="Top tokens by events">
                <ol style={{ margin: 0, paddingLeft: 18 }}>
                  {summary.top_tokens_by_events.map(([addr, c]) => (
                    <li key={addr} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {addr} — {c}
                    </li>
                  ))}
                </ol>
              </Card>
            </div>
          </div>
        </section>
      )}

      <footer style={{ marginTop: 24, color: "#666", fontSize: 12 }}>
        Tips: Use small ranges client-side (hundreds to a few thousand tx). For larger jobs, run the CLI and upload the JSON/CSV here in a future iteration to visualize without hitting RPC limits.
      </footer>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 10 }}>
      <div style={{ color: "#666", fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function Th({ children }) {
  return (
    <th style={{
      textAlign: "left",
      position: "sticky",
      top: 0,
      background: "#fafafa",
      borderBottom: "1px solid #eee",
      padding: "8px 10px",
      fontWeight: 600,
      fontSize: 12,
    }}>
      {children}
    </th>
  );
}

function Td({ children }) {
  return (
    <td style={{ borderBottom: "1px solid #f0f0f0", padding: "8px 10px", fontSize: 12 }}>{children}</td>
  );
}

// Optional: mount automatically if used standalone
if (typeof document !== "undefined" && !document.getElementById("root")) {
  const el = document.createElement("div");
  el.id = "root";
  document.body.appendChild(el);
  const root = createRoot(el);
  root.render(<BlockProfilerApp />);
}
