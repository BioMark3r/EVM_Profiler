# EVM Block Profiler

This package includes both a **CLI tool** and a **React web UI** for profiling Ethereum-compatible blockchain traffic.

## Setup (macOS + pip + brew)

### Prerequisites
Ensure you have Python 3.9+ and Node.js (v18+ recommended).

```bash
brew install python3 node
```

### Python CLI setup
```bash
pip install web3 tqdm
python block_profiler.py --rpc <RPC_URL> --start 21000000 --end 21000100
```

### React Web UI setup
```bash
npm install react react-dom web3 recharts
npm run dev
```

