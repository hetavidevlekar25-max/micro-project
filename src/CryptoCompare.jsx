import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";

/* ---------------- config ---------------- */

const API = "https://api.coingecko.com/api/v3/coins/markets";
const REFRESH_SECONDS = 60;
const MAX_SELECTED = 8;

const UNIVERSE = [
  { id: "bitcoin", sym: "BTC" },
  { id: "ethereum", sym: "ETH" },
  { id: "solana", sym: "SOL" },
  { id: "binancecoin", sym: "BNB" },
  { id: "ripple", sym: "XRP" },
  { id: "dogecoin", sym: "DOGE" },
  { id: "cardano", sym: "ADA" },
  { id: "avalanche-2", sym: "AVAX" },
  { id: "chainlink", sym: "LINK" },
  { id: "polkadot", sym: "DOT" },
  { id: "litecoin", sym: "LTC" },
  { id: "tron", sym: "TRX" },
  { id: "uniswap", sym: "UNI" },
  { id: "aave", sym: "AAVE" },
  { id: "arbitrum", sym: "ARB" },
  { id: "stellar", sym: "XLM" },
];

const CURRENCIES = {
  usd: { label: "USD", locale: "en-US" },
  inr: { label: "INR", locale: "en-IN" },
  eur: { label: "EUR", locale: "de-DE" },
};

// which change field the bar chart reads
const WINDOWS = {
  "1h": "price_change_percentage_1h_in_currency",
  "24h": "price_change_percentage_24h_in_currency",
  "7d": "price_change_percentage_7d_in_currency",
};

const COLORS = [
  "#2563eb",
  "#0a8f4e",
  "#d93025",
  "#9333ea",
  "#e07b00",
  "#0891b2",
  "#be185d",
  "#4d7c0f",
];

/* ---------------- math ---------------- */

function logReturns(prices) {
  const out = [];
  for (let i = 1; i < prices.length; i++) {
    const a = prices[i - 1];
    const b = prices[i];
    out.push(a > 0 && b > 0 ? Math.log(b / a) : 0);
  }
  return out;
}

function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx;
    const b = y[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

// hourly stdev scaled by sqrt(24 * 365)
function annualisedVol(returns) {
  const n = returns.length;
  if (n < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const varc = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(varc) * Math.sqrt(8760) * 100;
}

function maxDrawdown(prices) {
  let peak = -Infinity;
  let worst = 0;
  for (const p of prices) {
    if (p > peak) peak = p;
    const dd = (p / peak - 1) * 100;
    if (dd < worst) worst = dd;
  }
  return worst;
}

/* ---------------- formatting ---------------- */

function fmtPrice(v, cur) {
  if (v == null) return "—";
  const { locale, label } = CURRENCIES[cur];
  let digits = 2;
  if (v < 1) digits = 4;
  if (v < 0.01) digits = 6;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: label,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v);
}

function fmtCompact(v, cur) {
  if (v == null) return "—";
  const { locale, label } = CURRENCIES[cur];
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: label,
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(v);
}

function fmtPct(v) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function tone(v) {
  if (v == null || Math.abs(v) < 0.005) return "flat";
  return v > 0 ? "up" : "down";
}

/* ---------------- sample fallback ---------------- */

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleMarkets(ids, cur) {
  const fx = cur === "inr" ? 88 : cur === "eur" ? 0.92 : 1;
  const base = {
    bitcoin: 96000, ethereum: 3400, solana: 178, binancecoin: 640,
    ripple: 2.1, dogecoin: 0.32, cardano: 0.88, "avalanche-2": 36,
    chainlink: 21, polkadot: 6.4, litecoin: 108, tron: 0.24,
    uniswap: 12.4, aave: 280, arbitrum: 0.72, stellar: 0.39,
  };
  return ids.map((id, k) => {
    const rnd = mulberry32(id.length * 7919 + k * 104729);
    const drift = (rnd() - 0.45) * 0.0006;
    const sigma = 0.006 + rnd() * 0.008;
    const path = [];
    let p = base[id] ?? 10;
    for (let i = 0; i < 168; i++) {
      const shock = (rnd() + rnd() + rnd() + rnd() - 2) * sigma;
      p = p * Math.exp(drift + shock);
      path.push(p * fx);
    }
    const meta = UNIVERSE.find((u) => u.id === id);
    const last = path[167];
    return {
      id,
      symbol: meta.sym.toLowerCase(),
      name: meta.sym,
      current_price: last,
      market_cap: last * 1.4e8 * fx,
      total_volume: last * 4.1e6 * fx,
      price_change_percentage_1h_in_currency: (path[167] / path[166] - 1) * 100,
      price_change_percentage_24h_in_currency: (path[167] / path[143] - 1) * 100,
      price_change_percentage_7d_in_currency: (path[167] / path[0] - 1) * 100,
      sparkline_in_7d: { price: path },
    };
  });
}

/* ---------------- styles ---------------- */

const CSS = `
.cc { font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
  background:#f7f8fa; color:#1a1a1a; font-size:13px; min-height:100%; padding:0 0 40px; }
.cc *{ box-sizing:border-box; }
.cc h1{ font-size:20px; margin:0; }
.cc h2{ font-size:14px; margin:0; font-weight:600; }
.cc-wrap{ max-width:1120px; margin:0 auto; padding:0 16px; }
.cc-top{ background:#fff; border-bottom:1px solid #e3e5e9; padding:14px 16px; }
.cc-topin{ max-width:1120px; margin:0 auto; display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
.cc-muted{ color:#6b7280; font-size:12px; }
.cc-right{ margin-left:auto; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }

.cc button{ font:inherit; cursor:pointer; }
.cc-btn{ background:#fff; border:1px solid #d0d4da; border-radius:4px; padding:6px 12px; color:#1a1a1a; }
.cc-btn:hover{ border-color:#2563eb; color:#2563eb; }
.cc-btn:disabled{ opacity:.5; cursor:not-allowed; }
.cc-btn[aria-pressed="true"]{ background:#2563eb; border-color:#2563eb; color:#fff; }
.cc-chip{ background:#fff; border:1px solid #d0d4da; border-radius:4px; padding:4px 9px; font-size:12px; color:#4b5563; }
.cc-chip:hover{ border-color:#9ca3af; }
.cc-chip:disabled{ opacity:.4; cursor:not-allowed; }
.cc select{ font:inherit; padding:5px 7px; border:1px solid #d0d4da; border-radius:4px; background:#fff; }
.cc :focus-visible{ outline:2px solid #2563eb; outline-offset:1px; }

.cc-chips{ display:flex; flex-wrap:wrap; gap:6px; padding:14px 0 2px; align-items:center; }
.cc-grid{ display:grid; grid-template-columns:1.5fr 1fr; gap:14px; margin-top:14px; }
.cc-panel{ background:#fff; border:1px solid #e3e5e9; border-radius:6px; margin-top:14px; }
.cc-grid .cc-panel{ margin-top:0; }
.cc-head{ display:flex; align-items:baseline; gap:10px; padding:10px 14px; border-bottom:1px solid #eef0f3; }
.cc-head .cc-muted{ margin-left:auto; font-size:11px; }
.cc-body{ padding:14px; }

.cc-matrix{ display:grid; gap:2px; }
.cc-cell{ aspect-ratio:1; display:flex; align-items:center; justify-content:center; font-size:10px; border-radius:2px; }
.cc-axis{ font-size:10px; color:#6b7280; display:flex; align-items:center; justify-content:center; }
.cc-axis.row{ justify-content:flex-end; padding-right:5px; }

.cc-pair{ display:flex; align-items:center; gap:18px; flex-wrap:wrap; }
.cc-stat{ display:flex; flex-direction:column; gap:2px; }
.cc-stat .k{ font-size:10px; color:#6b7280; }
.cc-stat .v{ font-size:15px; font-weight:600; }

.cc-tablewrap{ overflow-x:auto; }
.cc-table{ width:100%; border-collapse:collapse; font-size:12px; min-width:740px; }
.cc-table th{ text-align:right; padding:8px 12px; font-size:11px; font-weight:600; color:#6b7280;
  border-bottom:1px solid #e3e5e9; cursor:pointer; white-space:nowrap; }
.cc-table th:hover{ color:#2563eb; }
.cc-table td{ padding:9px 12px; text-align:right; border-bottom:1px solid #f0f1f4; white-space:nowrap; }
.cc-table th:first-child, .cc-table td:first-child{ text-align:left; }
.cc-table tbody tr:hover td{ background:#f9fafb; }
.cc-swatch{ display:inline-block; width:8px; height:8px; border-radius:2px; margin-right:8px; }

.up{ color:#0a8f4e; } .down{ color:#d93025; } .flat{ color:#6b7280; }
.cc-banner{ background:#fff8e6; border:1px solid #f0d48a; border-radius:6px; padding:11px 14px;
  margin-top:14px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
.cc-empty{ padding:40px; text-align:center; color:#6b7280; }

@media (max-width:840px){ .cc-grid{ grid-template-columns:1fr; } }
`;

/* ---------------- component ---------------- */

export default function CryptoCompare() {
  const [selected, setSelected] = useState([
    "bitcoin", "ethereum", "solana", "ripple", "dogecoin",
  ]);
  const [currency, setCurrency] = useState("usd");
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState("loading"); // loading | live | error | sample
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [countdown, setCountdown] = useState(REFRESH_SECONDS);
  const [sort, setSort] = useState({ key: "market_cap", dir: -1 });
  const [pair, setPair] = useState({ a: "ethereum", b: "bitcoin" });
  const [windowKey, setWindowKey] = useState("7d");
  const abortRef = useRef(null);

  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = CSS;
    document.head.appendChild(el);
    return () => el.remove();
  }, []);

  const load = useCallback(async (ids, cur, opts = {}) => {
    if (ids.length === 0) {
      setRows([]);
      setStatus("live");
      return;
    }
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (!opts.silent) setStatus("loading");

    const url =
      `${API}?vs_currency=${cur}&ids=${ids.join("%2C")}` +
      `&order=market_cap_desc&per_page=50&page=1&sparkline=true` +
      `&price_change_percentage=1h%2C24h%2C7d`;

    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.status === 429)
        throw new Error("Rate limit hit. The free tier allows a few calls per minute.");
      if (!res.ok) throw new Error(`CoinGecko returned ${res.status}.`);
      const json = await res.json();
      if (!Array.isArray(json)) throw new Error("Unexpected response from CoinGecko.");
      setRows(json);
      setStatus("live");
      setError(null);
      setUpdatedAt(new Date());
      setCountdown(REFRESH_SECONDS);
    } catch (e) {
      if (e.name === "AbortError") return;
      setError(e.message || "Network request failed.");
      setStatus((s) => (s === "sample" ? "sample" : "error"));
    }
  }, []);

  useEffect(() => {
    load(selected, currency);
  }, [selected, currency, load]);

  useEffect(() => {
    if (status === "sample") return;
    const t = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          load(selected, currency, { silent: true });
          return REFRESH_SECONDS;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [selected, currency, status, load]);

  const useSample = () => {
    setRows(sampleMarkets(selected, currency));
    setStatus("sample");
    setUpdatedAt(new Date());
  };

  /* derived */
  const enriched = useMemo(
    () =>
      rows.map((r) => {
        const path = r.sparkline_in_7d?.price ?? [];
        const rets = logReturns(path);
        return {
          ...r,
          sym: (r.symbol || "").toUpperCase(),
          path,
          rets,
          vol: annualisedVol(rets),
          mdd: maxDrawdown(path),
        };
      }),
    [rows]
  );

  const colorOf = useMemo(() => {
    const m = {};
    selected.forEach((id, i) => (m[id] = COLORS[i % COLORS.length]));
    return m;
  }, [selected]);

  const sorted = useMemo(() => {
    const c = [...enriched];
    c.sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (typeof av === "string") return av.localeCompare(bv) * sort.dir;
      return ((av ?? -Infinity) - (bv ?? -Infinity)) * sort.dir;
    });
    return c;
  }, [enriched, sort]);

  // one bar per asset: percent change over the selected window
  const perf = useMemo(() => {
    const field = WINDOWS[windowKey];
    return enriched
      .map((r) => ({ id: r.id, sym: r.sym, value: r[field] ?? 0 }))
      .sort((a, b) => b.value - a.value);
  }, [enriched, windowKey]);

  const matrix = useMemo(() => {
    const list = enriched.filter((r) => r.rets.length > 2);
    if (list.length === 0) return { labels: [], values: [] };
    const n = Math.min(...list.map((r) => r.rets.length));
    return {
      labels: list.map((r) => r.sym),
      values: list.map((a) => list.map((b) => pearson(a.rets.slice(-n), b.rets.slice(-n)))),
    };
  }, [enriched]);

  const pairData = useMemo(() => {
    const A = enriched.find((r) => r.id === pair.a);
    const B = enriched.find((r) => r.id === pair.b);
    if (!A || !B || A.path.length < 2 || B.path.length < 2) return null;
    const n = Math.min(A.path.length, B.path.length);
    const end = Date.now();
    const series = [];
    for (let i = 0; i < n; i++) {
      series.push({
        t: end - (n - 1 - i) * 3600 * 1000,
        ratio: A.path[A.path.length - n + i] / B.path[B.path.length - n + i],
      });
    }
    const vals = series.map((s) => s.ratio);
    const now = vals[vals.length - 1];
    return {
      A, B, series, now,
      change: (now / vals[0] - 1) * 100,
      lo: Math.min(...vals),
      hi: Math.max(...vals),
      corr: pearson(A.rets.slice(-(n - 1)), B.rets.slice(-(n - 1))),
    };
  }, [enriched, pair]);

  const toggle = (id) =>
    setSelected((s) =>
      s.includes(id)
        ? s.filter((x) => x !== id)
        : s.length >= MAX_SELECTED
        ? s
        : [...s, id]
    );

  const sortBy = (key) =>
    setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: -1 }));

  const loading = status === "loading" && rows.length === 0;

  const COLS = [
    { key: "sym", label: "Asset" },
    { key: "current_price", label: "Price" },
    { key: "price_change_percentage_1h_in_currency", label: "1h" },
    { key: "price_change_percentage_24h_in_currency", label: "24h" },
    { key: "price_change_percentage_7d_in_currency", label: "7d" },
    { key: "vol", label: "Vol (ann.)" },
    { key: "mdd", label: "Max DD 7d" },
    { key: "total_volume", label: "Turnover 24h" },
    { key: "market_cap", label: "Market cap" },
  ];

  return (
    <div className="cc">
      <header className="cc-top">
        <div className="cc-topin">
          <div>
            <h1>Crypto Comparison</h1>
            <div className="cc-muted">Live prices and 7-day statistics from CoinGecko</div>
          </div>
          <div className="cc-right">
            {Object.entries(CURRENCIES).map(([k, v]) => (
              <button
                key={k}
                className="cc-btn"
                aria-pressed={currency === k}
                onClick={() => setCurrency(k)}
              >
                {v.label}
              </button>
            ))}
            <span className="cc-muted">
              {status === "sample"
                ? "Sample data"
                : status === "error"
                ? "Disconnected"
                : updatedAt
                ? `Updated ${updatedAt.toLocaleTimeString()} · next in ${countdown}s`
                : "Connecting…"}
            </span>
            <button
              className="cc-btn"
              onClick={() => load(selected, currency)}
              disabled={status === "loading"}
            >
              Refresh
            </button>
          </div>
        </div>
      </header>

      <div className="cc-wrap">
        <div className="cc-chips">
          {UNIVERSE.map((u) => {
            const on = selected.includes(u.id);
            return (
              <button
                key={u.id}
                className="cc-chip"
                aria-pressed={on}
                disabled={!on && selected.length >= MAX_SELECTED}
                onClick={() => toggle(u.id)}
                style={
                  on
                    ? { background: colorOf[u.id], borderColor: colorOf[u.id], color: "#fff" }
                    : undefined
                }
              >
                {u.sym}
              </button>
            );
          })}
          <span className="cc-muted" style={{ marginLeft: 6 }}>
            {selected.length} of {MAX_SELECTED} selected
          </span>
        </div>

        {error && (
          <div className="cc-banner">
            <strong>{status === "sample" ? "Offline mode" : "Could not load"}</strong>
            <span style={{ flex: 1, minWidth: 200 }}>
              {error}
              {status === "sample" && " Showing generated sample paths instead."}
            </span>
            <button className="cc-btn" onClick={() => load(selected, currency)}>
              Try again
            </button>
            {status !== "sample" && (
              <button className="cc-btn" onClick={useSample}>
                Load sample data
              </button>
            )}
          </div>
        )}

        {selected.length === 0 ? (
          <div className="cc-panel">
            <div className="cc-empty">Pick an asset above to start a comparison.</div>
          </div>
        ) : (
          <>
            <div className="cc-grid">
              <section className="cc-panel">
                <div className="cc-head">
                  <h2>Performance</h2>
                  <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                    {Object.keys(WINDOWS).map((w) => (
                      <button
                        key={w}
                        className="cc-chip"
                        aria-pressed={windowKey === w}
                        onClick={() => setWindowKey(w)}
                        style={
                          windowKey === w
                            ? { background: "#2563eb", borderColor: "#2563eb", color: "#fff" }
                            : undefined
                        }
                      >
                        {w}
                      </button>
                    ))}
                  </span>
                </div>
                <div className="cc-body" style={{ height: 290 }}>
                  {loading ? (
                    <div className="cc-empty">Loading…</div>
                  ) : perf.length === 0 ? (
                    <div className="cc-empty">No data returned.</div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={perf} margin={{ top: 6, right: 8, bottom: 4, left: -14 }}>
                        <CartesianGrid stroke="#eef0f3" vertical={false} />
                        <XAxis
                          dataKey="sym"
                          stroke="#9ca3af"
                          tick={{ fontSize: 11 }}
                          tickLine={false}
                        />
                        <YAxis
                          stroke="#9ca3af"
                          tick={{ fontSize: 11 }}
                          tickLine={false}
                          axisLine={false}
                          width={50}
                          tickFormatter={(v) => `${v}%`}
                        />
                        <ReferenceLine y={0} stroke="#9ca3af" />
                        <Tooltip content={<BarTooltip windowKey={windowKey} />} cursor={{ fill: "#f1f3f6" }} />
                        <Bar dataKey="value" isAnimationActive={false} radius={[3, 3, 0, 0]}>
                          {perf.map((d) => (
                            <Cell key={d.id} fill={d.value >= 0 ? "#0a8f4e" : "#d93025"} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </section>

              <section className="cc-panel">
                <div className="cc-head">
                  <h2>Correlation</h2>
                  <span className="cc-muted">Hourly log returns</span>
                </div>
                <div className="cc-body">
                  {loading ? (
                    <div className="cc-empty">Loading…</div>
                  ) : matrix.labels.length === 0 ? (
                    <div className="cc-empty">Not enough history.</div>
                  ) : (
                    <>
                      <div
                        className="cc-matrix"
                        style={{ gridTemplateColumns: `34px repeat(${matrix.labels.length}, 1fr)` }}
                      >
                        <div />
                        {matrix.labels.map((l) => (
                          <div key={"c" + l} className="cc-axis">{l}</div>
                        ))}
                        {matrix.labels.map((row, i) => (
                          <MatrixRow key={"r" + row} label={row} values={matrix.values[i]} />
                        ))}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          marginTop: 12,
                          fontSize: 11,
                          color: "#6b7280",
                        }}
                      >
                        <span>−1</span>
                        <div
                          style={{
                            flex: 1,
                            height: 6,
                            borderRadius: 3,
                            background: "linear-gradient(90deg,#d93025,#f1f2f4,#0a8f4e)",
                          }}
                        />
                        <span>+1</span>
                      </div>
                    </>
                  )}
                </div>
              </section>
            </div>

            <section className="cc-panel">
              <div className="cc-head">
                <h2>Relative value</h2>
                <span className="cc-muted">One unit of A priced in units of B</span>
              </div>
              <div className="cc-body">
                <div className="cc-pair">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <select
                      value={pair.a}
                      onChange={(e) => setPair((p) => ({ ...p, a: e.target.value }))}
                      aria-label="Base asset"
                    >
                      {enriched.map((r) => (
                        <option key={r.id} value={r.id}>{r.sym}</option>
                      ))}
                    </select>
                    <span className="cc-muted">/</span>
                    <select
                      value={pair.b}
                      onChange={(e) => setPair((p) => ({ ...p, b: e.target.value }))}
                      aria-label="Quote asset"
                    >
                      {enriched.map((r) => (
                        <option key={r.id} value={r.id}>{r.sym}</option>
                      ))}
                    </select>
                  </div>

                  {pairData ? (
                    <>
                      <Stat k="Ratio now" v={pairData.now.toPrecision(6)} />
                      <Stat k="7d change" v={fmtPct(pairData.change)} cls={tone(pairData.change)} />
                      <Stat k="7d low" v={pairData.lo.toPrecision(5)} />
                      <Stat k="7d high" v={pairData.hi.toPrecision(5)} />
                      <Stat k="Return corr." v={pairData.corr.toFixed(3)} />
                    </>
                  ) : (
                    <span className="cc-muted">Select two assets with loaded history.</span>
                  )}
                </div>
              </div>
            </section>

            <section className="cc-panel">
              <div className="cc-head">
                <h2>Quote board</h2>
                <span className="cc-muted">Click a header to sort</span>
              </div>
              <div className="cc-tablewrap">
                <table className="cc-table">
                  <thead>
                    <tr>
                      {COLS.map((c) => (
                        <th
                          key={c.key}
                          onClick={() => sortBy(c.key)}
                          style={sort.key === c.key ? { color: "#2563eb" } : undefined}
                        >
                          {c.label}
                          {sort.key === c.key ? (sort.dir === -1 ? " ▾" : " ▴") : ""}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td colSpan={COLS.length} style={{ textAlign: "center", padding: 30 }}>
                          Loading…
                        </td>
                      </tr>
                    ) : (
                      sorted.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <span
                              className="cc-swatch"
                              style={{ background: colorOf[r.id] || "#2563eb" }}
                            />
                            <strong>{r.sym}</strong>{" "}
                            <span className="cc-muted">{r.name}</span>
                          </td>
                          <td>{fmtPrice(r.current_price, currency)}</td>
                          <Pct v={r.price_change_percentage_1h_in_currency} />
                          <Pct v={r.price_change_percentage_24h_in_currency} />
                          <Pct v={r.price_change_percentage_7d_in_currency} />
                          <td>{r.vol ? `${r.vol.toFixed(1)}%` : "—"}</td>
                          <td className="down">{r.mdd ? `${r.mdd.toFixed(2)}%` : "—"}</td>
                          <td>{fmtCompact(r.total_volume, currency)}</td>
                          <td>{fmtCompact(r.market_cap, currency)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------- small pieces ---------------- */

function MatrixRow({ label, values }) {
  return (
    <>
      <div className="cc-axis row">{label}</div>
      {values.map((v, j) => (
        <div
          key={j}
          className="cc-cell"
          title={`${label}: ${v.toFixed(3)}`}
          style={{ background: corrColor(v), color: Math.abs(v) > 0.6 ? "#fff" : "#374151" }}
        >
          {v.toFixed(2)}
        </div>
      ))}
    </>
  );
}

function corrColor(v) {
  const t = Math.max(-1, Math.min(1, v));
  const base = [241, 242, 244];
  const target = t >= 0 ? [10, 143, 78] : [217, 48, 37];
  const w = Math.abs(t);
  const c = base.map((b, i) => Math.round(b + (target[i] - b) * w));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function Pct({ v }) {
  return <td className={tone(v)}>{fmtPct(v)}</td>;
}

function Stat({ k, v, cls }) {
  return (
    <div className="cc-stat">
      <span className="k">{k}</span>
      <span className={"v " + (cls || "")}>{v}</span>
    </div>
  );
}

function BarTooltip({ active, payload, label, windowKey }) {
  if (!active || !payload?.length) return null;
  const v = payload[0].value;
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #d0d4da",
        borderRadius: 4,
        padding: "8px 10px",
        fontSize: 12,
        boxShadow: "0 2px 6px rgba(0,0,0,.08)",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 3 }}>{label}</div>
      <div style={{ color: v >= 0 ? "#0a8f4e" : "#d93025" }}>
        {v >= 0 ? "+" : ""}
        {v.toFixed(2)}% over {windowKey}
      </div>
    </div>
  );
}
