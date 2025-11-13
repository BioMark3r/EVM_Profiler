import React, { useMemo, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import Web3 from "web3";
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend } from "recharts";

const SIG_TRANSFER = Web3.utils.keccak256("Transfer(address,address,uint256)");
const SIG_ERC1155_SINGLE = Web3.utils.keccak256("TransferSingle(address,address,address,uint256,uint256)");
const SIG_ERC1155_BATCH = Web3.utils.keccak256("TransferBatch(address,address,address,uint256[],uint256[])");

const DEFAULT_TYPES = ["eth_transfer","contract_creation","erc20_transfer","erc721_transfer","erc1155_transfer","other_contract_call","mixed_token_activity","other_eoa_call"];

const MIN_ERC20_ABI = [
  { "constant": true, "inputs": [], "name": "name", "outputs": [{"name":"","type":"string"}], "type": "function" },
  { "constant": true, "inputs": [], "name": "symbol", "outputs": [{"name":"","type":"string"}], "type": "function" },
  { "constant": true, "inputs": [], "name": "decimals", "outputs": [{"name":"","type":"uint8"}], "type": "function" },
];

function prettyNum(n) { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(n); }

function toHexTopic(x) {
  if (typeof x === "string") return x.toLowerCase();
  try { return Web3.utils.bytesToHex(x).toLowerCase(); } catch { return String(x).toLowerCase(); }
}
function classifyFromLogs(logs) {
  let erc20 = 0, erc721 = 0, erc1155 = 0;
  for (const lg of logs || []) {
    if (!lg.topics || lg.topics.length === 0) continue;
    const topic0 = toHexTopic(lg.topics[0]);
    if (topic0 === SIG_TRANSFER.toLowerCase()) {
      if (lg.data && lg.data !== "0x") erc20 += 1; else erc721 += 1;
    } else if (topic0 === SIG_ERC1155_SINGLE.toLowerCase() || topic0 === SIG_ERC1155_BATCH.toLowerCase()) {
      erc1155 += 1;
    }
  }
  if (erc20 > 0 && erc721 === 0 && erc1155 === 0) return "erc20_transfer";
  if (erc721 > 0 && erc20 === 0 && erc1155 === 0) return "erc721_transfer";
  if (erc1155 > 0 && erc20 === 0 && erc721 === 0) return "erc1155_transfer";
  if (erc20 || erc721 || erc1155) return "mixed_token_activity";
  return "other_contract_call";
}

export default function BlockProfilerApp() {
  const [rpcUrl, setRpcUrl] = useState("");
  const [startBlock, setStartBlock] = useState(0);
  const [endBlock, setEndBlock] = useState(0);
  const [pageSize, setPageSize] = useState(200);
  const [pageIndex, setPageIndex] = useState(0);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState(null);
  const [perBlock, setPerBlock] = useState([]);
  const [tokenMeta, setTokenMeta] = useState({});
  const w3Ref = useRef(null);

  const canProfile = rpcUrl && startBlock > 0 && endBlock >= startBlock;

  async function ensureWeb3() {
    if (!w3Ref.current) w3Ref.current = new Web3(new Web3.providers.HttpProvider(rpcUrl, { timeout: 60_000 }));
    return w3Ref.current;
  }

  async function runPage() {
    try {
      setStatus("Connecting...");
      const w3 = await ensureWeb3();
      const connected = await w3.eth.net.isListening().catch(() => false);
      if (!connected) throw new Error("Could not connect to RPC endpoint");
      const chainId = await w3.eth.getChainId();

      const pageStart = startBlock + pageIndex * pageSize;
      const pageEnd = Math.min(endBlock, pageStart + pageSize - 1);
      if (pageStart > pageEnd) throw new Error("Page out of range");

      const rows = []; let totalTx = 0; let totalEth = 0n;
      const txTypeStats = {};
      for (let b = pageStart; b <= pageEnd; b++) {
        const blk = await w3.eth.getBlock(b, true);
        const blockCounts = {}; let blockGasUsed = 0n;
        const receipts = await Promise.all(blk.transactions.map(tx => w3.eth.getTransactionReceipt(tx.hash)));
        for (let i = 0; i < blk.transactions.length; i++) {
          const tx = blk.transactions[i]; const rc = receipts[i];
          totalTx += 1;
          const gasUsed = BigInt(rc.gasUsed || 0); blockGasUsed += gasUsed;
          const gasPrice = BigInt(tx.gasPrice || 0); const value = BigInt(tx.value || 0);

          let typ = tx.to ? classifyFromLogs(rc.logs || []) : "contract_creation";
          if (typ !== "contract_creation") typ = typ || "other_contract_call";
          if (typ === "other_contract_call" && value > 0n) typ = "eth_transfer";

          if (!txTypeStats[typ]) txTypeStats[typ] = { count: 0, gas_used: 0, gas_price_wei_sum: 0n, eth_value_wei_sum: 0n };
          const s = txTypeStats[typ];
          s.count += 1; s.gas_used += Number(gasUsed); s.gas_price_wei_sum += gasPrice; s.eth_value_wei_sum += value;
          blockCounts[typ] = (blockCounts[typ] || 0) + 1; totalEth += value;
        }
        rows.push([blk.number, blk.timestamp, blk.transactions.length, DEFAULT_TYPES.map(t => blockCounts[t] || 0).join("|"), Number(blockGasUsed), Number(blk.gasLimit || 0)]);
        setProgress(Math.round(((b - pageStart) / (pageEnd - pageStart + 1)) * 100));
      }

      const txTypesObj = {};
      for (const [k, v] of Object.entries(txTypeStats)) {
        txTypesObj[k] = {
          count: v.count,
          gas_used: v.gas_used,
          avg_gas_price_gwei: Number(v.gas_price_wei_sum) / Math.max(v.count,1) / 1e9,
          eth_value_sum_eth: Number(Web3.utils.fromWei(String(v.eth_value_wei_sum), "ether")),
        };
      }

      const summaryObj = {
        start_block: pageStart, end_block: pageEnd, chain_id: Number(chainId),
        block_count: pageEnd - pageStart + 1, total_tx: totalTx,
        total_eth_transferred_eth: Number(Web3.utils.fromWei(String(totalEth), "ether")),
        tx_types: txTypesObj,
        notes: ["Client-side page profiling only — for full-range + traces use the CLI."],
      };
      setSummary(summaryObj); setPerBlock(rows); setStatus("Done"); setProgress(100);
    } catch (e) { console.error(e); setStatus("Error: " + (e?.message || String(e))); }
  }

  function onUploadSummary(evt) {
    const file = evt.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { setSummary(JSON.parse(reader.result)); setStatus("Loaded summary.json"); }
      catch { setStatus("Invalid JSON"); }
    };
    reader.readAsText(file);
  }
  function onUploadCSV(evt) {
    const file = evt.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const lines = String(reader.result).trim().split(/\r?\n/);
      const rows = lines.slice(1).map(line => {
        const parts = line.split(",");
        const [block, ts, txCount, ...rest] = parts;
        const counts = rest.slice(0, DEFAULT_TYPES.length).join("|");
        const [gasUsed, gasLimit] = rest.slice(DEFAULT_TYPES.length);
        return [Number(block), Number(ts), Number(txCount), counts, Number(gasUsed), Number(gasLimit)];
      });
      setPerBlock(rows); setStatus("Loaded per_block.csv");
    };
    reader.readAsText(file);
  }

  async function resolveTokenMeta() {
    try {
      if (!rpcUrl || !(summary?.top_tokens_by_events?.length)) return;
      const w3 = await ensureWeb3();
      const addrs = summary.top_tokens_by_events.map(([addr]) => addr);
      const out = {};
      for (const a of addrs) {
        try {
          const c = new w3.eth.Contract(MIN_ERC20_ABI, a);
          const [name, symbol, decimals] = await Promise.all([
            c.methods.name().call(), c.methods.symbol().call(), c.methods.decimals().call()
          ]);
          out[a.toLowerCase()] = { name, symbol, decimals: Number(decimals) };
        } catch {
          out[a.toLowerCase()] = { name: "Unknown", symbol: "?", decimals: 18 };
        }
      }
      setTokenMeta(out);
    } catch {
      setStatus("Token metadata lookup failed");
    }
  }

  const chartData = useMemo(() => {
    if (!summary) return [];
    return Object.entries(summary.tx_types || {}).map(([k, v]) => ({ type: k, count: v.count }));
  }, [summary]);

  return (
    <div style={{ fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial", padding: 20 }}>
      <h1>EVM Block Profiler</h1>
      <p>Profile live via RPC (paged) or upload CLI outputs (<code>summary.json</code>/<code>per_block.csv</code>) for visualization.</p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "end" }}>
        <div style={{ gridColumn: "1 / -1" }}>
          <label>RPC URL</label>
          <input value={rpcUrl} onChange={e => setRpcUrl(e.target.value)} placeholder="https://mainnet.infura.io/v3/YOUR_KEY" style={{ width: "100%", padding: 8, border: "1px solid #ccc", borderRadius: 8 }} />
        </div>
        <div><label>Start Block</label><input type="number" value={startBlock} onChange={e => setStartBlock(Number(e.target.value))} style={{ width: "100%", padding: 8, border: "1px solid #ccc", borderRadius: 8 }} /></div>
        <div><label>End Block</label><input type="number" value={endBlock} onChange={e => setEndBlock(Number(e.target.value))} style={{ width: "100%", padding: 8, border: "1px solid #ccc", borderRadius: 8 }} /></div>
        <div><label>Page Size</label><input type="number" value={pageSize} onChange={e => setPageSize(Number(e.target.value))} style={{ width: "100%", padding: 8, border: "1px solid #ccc", borderRadius: 8 }} /></div>
      </div>

      <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={runPage} disabled={!canProfile} style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #888", background: "#111", color: "#fff" }}>
          Profile current page
        </button>
        <div>Page:</div>
        <button onClick={()=>setPageIndex(Math.max(0, pageIndex-1))}>&lt;</button>
        <div>{pageIndex+1}</div>
        <button onClick={()=>setPageIndex(pageIndex+1)}>&gt;</button>
        <div style={{ color: status.startsWith("Error") ? "#b00020" : "#444", marginLeft: 12 }}>{status}</div>
      </div>

      <div style={{ marginTop: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Or upload CLI outputs</div>
        <label style={{ border: "1px solid #ccc", borderRadius: 8, padding: "6px 10px", marginRight: 8 }}>
          <input type="file" accept=".json,application/json" onChange={onUploadSummary} /> Load summary.json
        </label>
        <label style={{ border: "1px solid #ccc", borderRadius: 8, padding: "6px 10px" }}>
          <input type="file" accept=".csv,text/csv" onChange={onUploadCSV} /> Load per_block.csv
        </label>
        {rpcUrl && (summary?.top_tokens_by_events?.length>0) && (
          <button onClick={resolveTokenMeta} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #888", background: "#fff", marginLeft: 8 }}>
            Resolve token symbols via RPC
          </button>
        )}
      </div>

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
          <h2>Summary</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginTop: 12 }}>
            <Stat label="Blocks" value={`${summary.block_count}`} />
            <Stat label="Total tx" value={`${summary.total_tx}`} />
            {"unique_senders" in summary && summary.unique_senders>=0 && <Stat label="Unique senders" value={`${summary.unique_senders}`} />}
            {"unique_receivers" in summary && summary.unique_receivers>=0 && <Stat label="Unique receivers" value={`${summary.unique_receivers}`} />}
            {"total_eth_transferred_eth" in summary && <Stat label="ETH transferred" value={`${prettyNum(summary.total_eth_transferred_eth)} ETH`} />}
            {"total_internal_value_eth" in summary && <Stat label="Internal value" value={`${prettyNum(summary.total_internal_value_eth)} ETH`} />}
            {"chain_id" in summary && <Stat label="Chain ID" value={`${summary.chain_id}`} />}
          </div>

          <div style={{ height: 280, marginTop: 20, border: "1px solid #eee", borderRadius: 8, padding: 8 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={Object.entries(summary.tx_types || {}).map(([k, v]) => ({ type: k, count: v.count }))}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="type" angle={-15} textAnchor="end" height={55} />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="count" name="Tx count" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div style={{ marginTop: 16 }}>
            <h3>Top tokens (with symbols if resolved)</h3>
            <ul>
              {(summary.top_tokens_by_events || []).map(([addr, c]) => {
                const meta = tokenMeta[addr?.toLowerCase()];
                const label = meta ? `${meta.symbol || "?"} (${meta.name || "?"})` : addr;
                return <li key={addr} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label} — {c}</li>
              })}
            </ul>
          </div>
        </section>
      )}
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

// Auto-mount when opened directly
if (typeof document !== "undefined" && !document.getElementById("root")) {
  const el = document.createElement("div");
  el.id = "root";
  document.body.appendChild(el);
  const root = createRoot(el);
  root.render(<BlockProfilerApp />);
}
