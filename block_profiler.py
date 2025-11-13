#!/usr/bin/env python3
"""
block_profiler.py

Profile EVM-compatible blockchain traffic over a block range.
Requires an HTTP JSON-RPC endpoint (e.g., Infura, Alchemy, local node).

Usage:
  python block_profiler.py --rpc https://mainnet.infura.io/v3/YOUR_KEY --start 21000000 --end 21000100 --out summary.json --csv per_block.csv

Install:
  pip install web3>=6.0.0 tqdm

What it does:
  - Iterates blocks [start, end] inclusive
  - Classifies each transaction into:
      * contract_creation (tx.to is None)
      * eth_transfer (tx.value > 0 and to != None and no token logs)
      * erc20_transfer (Transfer(address,address,uint256) with amount in data)
      * erc721_transfer (Transfer(address,address,uint256) with empty data)
      * erc1155_transfer (TransferSingle/TransferBatch)
      * mixed_token_activity (multiple token standards in one tx)
      * other_contract_call (contract call without the above transfers)
      * other_eoa_call (to is EOA and no value or token logs)
  - Aggregates per-type counts, gas, avg gas price, and ETH volume
  - Tracks unique senders/receivers, top contracts (by tx.to), top tokens (by events)
  - Writes JSON summary (+ optional per-block CSV)

Notes:
  - ERC-20 vs ERC-721 is inferred from Transfer event payload (amount in data vs none).
  - Internal ETH transfers aren't counted; only tx.value is summed.
  - Consider RPC rate limits; each tx fetches a receipt.
"""

from __future__ import annotations
import argparse, csv, json
from collections import Counter, defaultdict
from dataclasses import dataclass
from decimal import Decimal, getcontext
from typing import Dict, Any, Tuple, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

from web3 import Web3
from web3.types import HexBytes
from tqdm import tqdm

# High precision for ETH sums
getcontext().prec = 40

# Event signatures
SIG_TRANSFER = Web3.keccak(text="Transfer(address,address,uint256)").hex()
SIG_ERC1155_SINGLE = Web3.keccak(text="TransferSingle(address,address,address,uint256,uint256)").hex()
SIG_ERC1155_BATCH = Web3.keccak(text="TransferBatch(address,address,address,uint256[],uint256[])").hex()

@dataclass
class TxStats:
    count: int = 0
    gas_used: int = 0
    gas_price_wei_sum: int = 0
    eth_value_wei_sum: int = 0

def wei_to_eth(wei: int) -> Decimal:
    return Decimal(wei) / Decimal(10**18)

def is_contract(w3: Web3, address: str) -> bool:
    try:
        code = w3.eth.get_code(address)
        return code is not None and len(code) > 0 and code != b"\x00" and code != b""
    except Exception:
        return False

def classify_from_logs(logs) -> Tuple[str, Optional[str]]:
    """Return (type, token_or_contract_address_if_applicable) based on logs."""
    erc20_count = 0; erc721_count = 0; erc1155_count = 0
    tokens = Counter()
    for lg in logs:
        topics = lg.get("topics", [])
        if not topics:
            continue
        t0 = topics[0]
        if isinstance(t0, (bytes, bytearray, HexBytes)):
            t0 = Web3.to_hex(t0)
        t0 = t0.lower()
        addr = lg.get("address", "").lower()
        if t0 == SIG_TRANSFER.lower():
            if lg.get("data") and lg["data"] != "0x":
                erc20_count += 1
            else:
                erc721_count += 1
            if addr:
                tokens[addr] += 1
        elif t0 in (SIG_ERC1155_SINGLE.lower(), SIG_ERC1155_BATCH.lower()):
            erc1155_count += 1
            if addr:
                tokens[addr] += 1
    dominant = tokens.most_common(1)[0][0] if tokens else None
    if erc20_count > 0 and erc721_count == 0 and erc1155_count == 0:
        return "erc20_transfer", dominant
    if erc721_count > 0 and erc20_count == 0 and erc1155_count == 0:
        return "erc721_transfer", dominant
    if erc1155_count > 0 and erc20_count == 0 and erc721_count == 0:
        return "erc1155_transfer", dominant
    if erc20_count or erc721_count or erc1155_count:
        return "mixed_token_activity", dominant
    return "other_contract_call", None

# ---- Internal value transfer tracing ----
def trace_internal_value_erigon(w3: Web3, block_number: int) -> int:
    """
    Uses Erigon/OpenEthereum 'trace_block' to sum value moved internally within the block.
    Returns total value in wei of all 'call' traces with >0 value.
    """
    try:
        result = w3.provider.make_request("trace_block", [hex(block_number)])
        traces = result.get("result", []) or []
        total = 0
        for tr in traces:
            if tr.get("type") == "call":
                val_hex = tr.get("action", {}).get("value", "0x0")
                if isinstance(val_hex, str) and val_hex.startswith("0x"):
                    total += int(val_hex, 16)
        return total
    except Exception:
        return 0

def trace_internal_value_geth(w3: Web3, block_number: int) -> int:
    """
    Uses Geth 'debug_traceBlockByNumber' with 'callTracer' to sum internal value transfers.
    NOTE: This is heavy and may be disabled by providers. Prefer Erigon when possible.
    """
    try:
        params = [hex(block_number), {"tracer": "callTracer"}]
        result = w3.provider.make_request("debug_traceBlockByNumber", params)
        calls = result.get("result", []) or []
        total = 0
        def walk(node):
            nonlocal total
            val = node.get("value")
            if isinstance(val, str) and val.startswith("0x"):
                total += int(val, 16)
            for child in node.get("calls", []) or []:
                if isinstance(child, dict):
                    walk(child)
        for txres in calls:
            root = txres.get("result") or txres.get("calls") or txres
            if isinstance(root, dict):
                walk(root)
            elif isinstance(root, list):
                for c in root:
                    if isinstance(c, dict):
                        walk(c)
        return total
    except Exception:
        return 0

# ---- Core profiling helpers ----
def profile_chunk(
    w3: Web3, start: int, end: int, *,
    skip_contract_check: bool, tx_cap: Optional[int],
    receipt_workers: int, trace_mode: str, csv_writer=None
) -> Dict[str, Any]:
    tx_type_stats: Dict[str, TxStats] = defaultdict(TxStats)
    unique_from = set(); unique_to = set()
    total_eth_wei = 0; total_tx = 0
    top_contracts = Counter(); top_tokens = Counter()
    DEFAULT_TYPES = [
        "eth_transfer","contract_creation","erc20_transfer","erc721_transfer",
        "erc1155_transfer","other_contract_call","mixed_token_activity","other_eoa_call",
    ]
    contract_cache: Dict[str, bool] = {}

    def fetch_receipt(tx_hash):
        return w3.eth.get_transaction_receipt(tx_hash)

    for bnum in range(start, end + 1):
        block = w3.eth.get_block(bnum, full_transactions=True)
        txs = block["transactions"]

        with ThreadPoolExecutor(max_workers=max(1, receipt_workers)) as pool:
            futures = {pool.submit(fetch_receipt, tx["hash"]): tx for tx in txs}
            block_counts = Counter(); block_gas_used_sum = 0

            for fut in as_completed(futures):
                tx = futures[fut]
                try:
                    receipt = fut.result()
                except Exception:
                    continue

                total_tx += 1
                if tx.get("from"):
                    unique_from.add(tx["from"].lower())
                if tx.get("to"):
                    unique_to.add(tx["to"].lower())

                gas_used = int(receipt.get("gasUsed", 0) or 0); block_gas_used_sum += gas_used
                gas_price_wei = int(tx.get("gasPrice", 0) or 0)
                value_wei = int(tx.get("value", 0) or 0)

                if tx.get("to") is None:
                    tx_type = "contract_creation"; token_or_contract = None
                else:
                    tx_type, token_or_contract = classify_from_logs(receipt.get("logs", []))
                    if tx_type == "other_contract_call":
                        if value_wei > 0:
                            tx_type = "eth_transfer"
                        elif not skip_contract_check:
                            addr = tx["to"].lower()
                            if addr not in contract_cache:
                                contract_cache[addr] = is_contract(w3, addr)
                            if not contract_cache[addr]:
                                tx_type = "other_eoa_call"

                stats = tx_type_stats[tx_type]
                stats.count += 1
                stats.gas_used += gas_used
                stats.gas_price_wei_sum += gas_price_wei
                stats.eth_value_wei_sum += value_wei

                block_counts[tx_type] += 1
                total_eth_wei += value_wei

                if tx.get("to"):
                    top_contracts[tx["to"].lower()] += 1
                if token_or_contract:
                    top_tokens[token_or_contract.lower()] += 1

                if tx_cap is not None and total_tx >= tx_cap:
                    break

        if csv_writer:
            row = [block["number"], block["timestamp"], len(txs)]
            for t in DEFAULT_TYPES:
                row.append(block_counts.get(t, 0))
            row.extend([
                block.get("gasUsed", 0) if "gasUsed" in block else block_gas_used_sum,
                block.get("gasLimit", 0),
            ])
            csv_writer.writerow(row)

        if tx_cap is not None and total_tx >= tx_cap:
            break

    internal_total = 0
    if trace_mode and trace_mode != "none":
        for bnum in range(start, end + 1):
            if trace_mode == "erigon":
                internal_total += trace_internal_value_erigon(w3, bnum)
            elif trace_mode == "geth":
                internal_total += trace_internal_value_geth(w3, bnum)

    summary = {
        "start_block": start,
        "end_block": end,
        "block_count": end - start + 1,
        "total_tx": total_tx,
        "unique_senders": len(unique_from),
        "unique_receivers": len(unique_to),
        "total_eth_transferred_eth": str(wei_to_eth(total_eth_wei)),
        "total_internal_value_eth": str(wei_to_eth(internal_total)),
        "tx_types": {
            k: {
                "count": v.count,
                "gas_used": v.gas_used,
                "avg_gas_price_gwei": (Decimal(v.gas_price_wei_sum) / Decimal(max(v.count, 1)) / Decimal(1e9)).quantize(Decimal("0.0001")) if v.count else "0",
                "eth_value_sum_eth": str(wei_to_eth(v.eth_value_wei_sum)),
            }
            for k, v in sorted(tx_type_stats.items(), key=lambda kv: kv[0])
        },
        "top_contracts_by_tx": Counter(top_contracts).most_common(20),
        "top_tokens_by_events": Counter(top_tokens).most_common(20),
    }
    return summary

def profile_range(
    rpc: str, start: int, end: int, *,
    out: str, csv_path: Optional[str], skip_contract_check: bool,
    tx_cap: Optional[int], concurrency: int, chunk_size: int, trace_mode: str
) -> Dict[str, Any]:
    if end < start:
        raise ValueError("--end must be >= --start")
    w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 60}))
    if not w3.is_connected():
        raise SystemExit("Could not connect to RPC endpoint.")
    chain_id = w3.eth.chain_id

    # CSV init
    csv_writer = None; csv_file = None
    if csv_path:
        csv_file = open(csv_path, "w", newline="")
        csv_writer = csv.writer(csv_file)
        csv_writer.writerow([
            "block_number","timestamp","tx_count",
            "eth_transfer","contract_creation","erc20_transfer","erc721_transfer","erc1155_transfer",
            "other_contract_call","mixed_token_activity","other_eoa_call",
            "block_gas_used","block_gas_limit"
        ])

    overall = {
        "start_block": start,
        "end_block": end,
        "chain_id": chain_id,
        "block_count": end - start + 1,
        "total_tx": 0,
        "unique_senders": -1,   # not exact across chunk merges (kept simple)
        "unique_receivers": -1, # not exact across chunk merges
        "total_eth_transferred_eth": "0",
        "total_internal_value_eth": "0",
        "tx_types": {},
        "top_contracts_by_tx": [],
        "top_tokens_by_events": [],
        "notes": [
            "ERC20 vs ERC721 inferred from Transfer event payload (amount vs none).",
            "Mixed token activity indicates multiple token standards in a single tx.",
            "ETH transferred sums only tx.value; internal transfers via traces (optional).",
        ],
        "limits": {
            "tx_cap": tx_cap,
            "skip_contract_check": skip_contract_check,
            "concurrency": concurrency,
            "chunk_size": chunk_size,
            "trace_mode": trace_mode,
        }
    }

    tx_types_agg: Dict[str, TxStats] = defaultdict(TxStats)
    top_contracts, top_tokens = Counter(), Counter()
    total_eth_wei_acc = 0; internal_wei_acc = 0; total_tx_acc = 0

    cur = start
    pbar = tqdm(total=end - start + 1, desc="Blocks")
    while cur <= end:
        chunk_end = min(cur + chunk_size - 1, end)
        chunk = profile_chunk(
            w3, cur, chunk_end,
            skip_contract_check=skip_contract_check,
            tx_cap=tx_cap,
            receipt_workers=concurrency,
            trace_mode=trace_mode,
            csv_writer=csv_writer
        )
        total_tx_acc += chunk["total_tx"]
        total_eth_wei_acc += int(Decimal(chunk["total_eth_transferred_eth"]) * Decimal(10**18))
        internal_wei_acc += int(Decimal(chunk["total_internal_value_eth"]) * Decimal(10**18))

        for k, v in chunk["tx_types"].items():
            s = tx_types_agg[k]
            s.count += v["count"]
            s.gas_used += v["gas_used"]
            s.gas_price_wei_sum += int(Decimal(str(v["avg_gas_price_gwei"])) * Decimal(1e9) * Decimal(v["count"]))
            s.eth_value_wei_sum += int(Decimal(str(v["eth_value_sum_eth"])) * Decimal(10**18))

        for addr, c in chunk["top_contracts_by_tx"]:
            top_contracts[addr] += c
        for addr, c in chunk["top_tokens_by_events"]:
            top_tokens[addr] += c

        pbar.update(chunk_end - cur + 1)
        cur = chunk_end + 1
    pbar.close()

    overall["total_tx"] = total_tx_acc
    overall["total_eth_transferred_eth"] = str(wei_to_eth(total_eth_wei_acc))
    overall["total_internal_value_eth"] = str(wei_to_eth(internal_wei_acc))
    overall["tx_types"] = {
        k: {
            "count": v.count,
            "gas_used": v.gas_used,
            "avg_gas_price_gwei": (Decimal(v.gas_price_wei_sum) / Decimal(max(v.count, 1)) / Decimal(1e9)).quantize(Decimal("0.0001")) if v.count else "0",
            "eth_value_sum_eth": str(wei_to_eth(v.eth_value_wei_sum)),
        }
        for k, v in sorted(tx_types_agg.items(), key=lambda kv: kv[0])
    }
    overall["top_contracts_by_tx"] = top_contracts.most_common(20)
    overall["top_tokens_by_events"] = top_tokens.most_common(20)

    if csv_file:
        csv_file.close()

    with open(out, "w") as f:
        json.dump(overall, f, indent=2)
    return overall

def main():
    ap = argparse.ArgumentParser(description="Profile blockchain traffic by block range (EVM)")
    ap.add_argument("--rpc", required=True, help="HTTP(s) JSON-RPC endpoint (e.g. Infura/Alchemy/local)")
    ap.add_argument("--start", type=int, required=True, help="Start block (inclusive)")
    ap.add_argument("--end", type=int, required=True, help="End block (inclusive)")
    ap.add_argument("--out", default="summary.json", help="Path to write JSON summary (default: summary.json)")
    ap.add_argument("--csv", default=None, help="Optional per-block CSV path (default: none)")
    ap.add_argument("--skip-contract-check", action="store_true", help="Don't check if 'to' is a contract (faster)")
    ap.add_argument("--tx-cap", type=int, default=None, help="Maximum number of transactions to process (safety cap)")
    ap.add_argument("--concurrency", type=int, default=8, help="Max concurrent receipt requests (default: 8)")
    ap.add_argument("--chunk-size", type=int, default=50, help="Blocks per chunk for pagination (default: 50)")
    ap.add_argument("--trace", choices=["none", "erigon", "geth"], default="none", help="Internal value transfer tracing mode")
    args = ap.parse_args()

    summary = profile_range(
        rpc=args.rpc, start=args.start, end=args.end, out=args.out, csv_path=args.csv,
        skip_contract_check=args.skip_contract_check, tx_cap=args.tx_cap,
        concurrency=args.concurrency, chunk_size=args.chunk_size, trace_mode=args.trace
    )
    print(f"Wrote JSON summary to {args.out}")
    if args.csv:
        print(f"Wrote per-block CSV to {args.csv}")
    print("=== Totals by type ===")
    for k, v in summary["tx_types"].items():
        print(f"{k:22s} count={v['count']:8d} gas_used={v['gas_used']:12d} avg_gas_price_gwei={v['avg_gas_price_gwei']} eth_sum={v['eth_value_sum_eth']}")

if __name__ == "__main__":
    main()

