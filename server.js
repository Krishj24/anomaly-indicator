const express = require('express');
const cors    = require('cors');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;

// Allow requests from GitHub Pages and localhost
app.use(cors({
  origin: [
    /\.github\.io$/,
    /localhost/,
    /127\.0\.0\.1/
  ],
  methods: ['GET','POST','OPTIONS']
}));
app.use(express.json());

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Anomaly Intel Backend', version: '1.0.0' });
});

// ── OHLCV ────────────────────────────────────────────────────────────────────
app.get('/api/ohlcv', async (req, res) => {
  const { symbol, interval = '1h', range = '1mo' } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await resp.json();
    const chart = data?.chart?.result?.[0];
    if (!chart) return res.status(404).json({ error: 'No data found for symbol' });
    const ts = chart.timestamp;
    const q  = chart.indicators.quote[0];
    const candles = ts.map((t, i) => ({
      time:   t,
      open:   q.open[i]   ? +q.open[i].toFixed(2)   : null,
      high:   q.high[i]   ? +q.high[i].toFixed(2)   : null,
      low:    q.low[i]    ? +q.low[i].toFixed(2)    : null,
      close:  q.close[i]  ? +q.close[i].toFixed(2)  : null,
      volume: q.volume[i] || 0
    })).filter(c => c.open && c.close);
    res.json({ symbol, interval, range, candles });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DETECT ────────────────────────────────────────────────────────────────────
app.post('/api/detect', (req, res) => {
  const { candles, volMultiplier=2.5, atrMultiplier=2.0, gapThreshold=0.5, velBars=4 } = req.body;
  if (!candles || candles.length < 20) return res.status(400).json({ error: 'Not enough candle data' });

  const calcATR = (idx, period=14) => {
    if (idx < period) return null;
    let s = 0;
    for (let i = idx-period+1; i <= idx; i++) {
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - (candles[i-1]?.close ?? candles[i].open)),
        Math.abs(candles[i].low  - (candles[i-1]?.close ?? candles[i].open))
      );
      s += tr;
    }
    return s / period;
  };

  const avgVol = (idx, period=20) => {
    if (idx < period) return null;
    let s = 0;
    for (let i = idx-period; i < idx; i++) s += candles[i].volume;
    return s / period;
  };

  const anomalies = [];
  for (let i = 20; i < candles.length; i++) {
    const c = candles[i], prev = candles[i-1];
    const triggers = [];

    const av = avgVol(i);
    if (av && c.volume > av * volMultiplier)
      triggers.push({ type:'VOL_SPIKE', detail:`${(c.volume/av).toFixed(1)}x avg volume` });

    const atr = calcATR(i);
    const body = Math.abs(c.close - c.open);
    if (atr && body > atr * atrMultiplier)
      triggers.push({ type:'PRICE_SHOCK', detail:`${(body/atr).toFixed(1)}x ATR body` });

    const gapPct = Math.abs(c.open - prev.close) / prev.close * 100;
    if (gapPct >= gapThreshold) {
      const dir = c.open > prev.close ? 'UP' : 'DOWN';
      triggers.push({ type:`GAP_${dir}`, detail:`${gapPct.toFixed(2)}% gap ${dir.toLowerCase()}` });
    }

    if (i >= velBars) {
      const bullRun = Array.from({length:velBars},(_,k)=>candles[i-k]).every(x=>x.close>x.open)
        && candles[i].volume > candles[i-1].volume && candles[i-1].volume > candles[i-2].volume;
      const bearRun = Array.from({length:velBars},(_,k)=>candles[i-k]).every(x=>x.close<x.open)
        && candles[i].volume > candles[i-1].volume && candles[i-1].volume > candles[i-2].volume;
      if (bullRun) triggers.push({ type:'MOMENTUM_BULL', detail:`${velBars} consecutive bull bars rising volume` });
      if (bearRun) triggers.push({ type:'MOMENTUM_BEAR', detail:`${velBars} consecutive bear bars rising volume` });
    }

    if (triggers.length)
      anomalies.push({ index:i, time:c.time, candle:c, triggers, score:triggers.length, highConviction:triggers.length>=2 });
  }
  res.json({ anomalies, total: anomalies.length });
});

// ── GNEWS ─────────────────────────────────────────────────────────────────────
app.get('/api/news', async (req, res) => {
  const { query, from, to } = req.query;
  const KEY = process.env.GNEWS_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'GNEWS_API_KEY not set in Railway' });
  try {
    const p = new URLSearchParams({ q:query, lang:'en', sortby:'publishedAt', max:'10', apikey:KEY, ...(from&&{from}), ...(to&&{to}) });
    const r = await fetch(`https://gnews.io/api/v4/search?${p}`);
    const d = await r.json();
    res.json({ articles: d.articles || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── REUTERS RSS ───────────────────────────────────────────────────────────────
app.get('/api/reuters', async (req, res) => {
  try {
    const xml = await fetch('https://feeds.reuters.com/reuters/businessNews').then(r=>r.text());
    const items = [];
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const b = m[1];
      const title   = b.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] || b.match(/<title>(.*?)<\/title>/)?.[1] || '';
      const link    = b.match(/<link>(.*?)<\/link>/)?.[1] || '';
      const pubDate = b.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
      if (title) items.push({ title, link, publishedAt:pubDate, source:'Reuters', tier:1 });
    }
    res.json({ articles: items.slice(0,20) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GROQ ANALYSIS ─────────────────────────────────────────────────────────────
app.post('/api/analyse', async (req, res) => {
  const { anomaly, newsArticles, symbol } = req.body;
  const KEY = process.env.GROQ_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set in Railway' });

  const newsText = newsArticles.slice(0,6).map((a,i)=>`[${i+1}] ${a.source} | ${a.publishedAt||a.pubDate||''}: ${a.title}`).join('\n');
  const prompt = `You are a financial market analyst. A market anomaly was detected on ${symbol}.

ANOMALY:
- Time: ${new Date(anomaly.time*1000).toISOString()}
- Triggers: ${anomaly.triggers.map(t=>`${t.type}: ${t.detail}`).join(', ')}
- Candle: O${anomaly.candle.open} H${anomaly.candle.high} L${anomaly.candle.low} C${anomaly.candle.close} V${anomaly.candle.volume}

NEWS AROUND THAT TIME:
${newsText || 'No news found.'}

Respond ONLY in raw JSON (no markdown, no backticks):
{"probableCause":"1-2 sentence explanation","confidence":"CONFIRMED|LIKELY|UNCLEAR|TECHNICAL","confidenceReason":"why this confidence level","keyHeadline":"most relevant headline or null","marketType":"fundamental|technical|mixed","actionableNote":"1 sentence trader takeaway"}`;

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:'POST',
      headers:{ 'Authorization':`Bearer ${KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ model:'llama-3.3-70b-versatile', messages:[{role:'user',content:prompt}], max_tokens:400, temperature:0.3 })
    });
    const d = await r.json();
    const raw = d.choices?.[0]?.message?.content || '{}';
    res.json(JSON.parse(raw.replace(/```json|```/g,'').trim()));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MANUAL LOOKUP ─────────────────────────────────────────────────────────────
app.get('/api/manual-lookup', async (req, res) => {
  const { symbol, timestamp } = req.query;
  if (!symbol || !timestamp) return res.status(400).json({ error: 'symbol and timestamp required' });
  const ts   = parseInt(timestamp);
  const from = new Date((ts-7200)*1000).toISOString();
  const to   = new Date((ts+1800)*1000).toISOString();
  const kwMap = {
    '^NSEI':'Nifty OR RBI OR SEBI OR Indian market','^NSEBANK':'BankNifty OR RBI OR interest rate India',
    '^GSPC':'S&P 500 OR Fed OR Federal Reserve OR CPI','^IXIC':'Nasdaq OR Fed OR tech stocks',
    'CL=F':'crude oil OR OPEC OR EIA','BZ=F':'Brent crude OR OPEC OR oil','USDINR=X':'USD INR OR rupee OR RBI'
  };
  const query = kwMap[symbol] || symbol;
  try {
    const KEY = process.env.GNEWS_API_KEY;
    let articles = [];
    if (KEY) {
      const p = new URLSearchParams({ q:query, lang:'en', sortby:'publishedAt', max:'10', apikey:KEY, from, to });
      const r = await fetch(`https://gnews.io/api/v4/search?${p}`);
      const d = await r.json();
      articles = (d.articles||[]).map(a=>({...a,source:a.source?.name||'GNews',tier:2}));
    }
    const xml = await fetch('https://feeds.reuters.com/reuters/businessNews').then(r=>r.text()).catch(()=>'');
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const b = m[1];
      const title = b.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]||'';
      const link  = b.match(/<link>(.*?)<\/link>/)?.[1]||'';
      const pub   = b.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]||'';
      if (title) articles.push({ title, link, publishedAt:pub, source:'Reuters', tier:1 });
    }
    res.json({ articles: articles.slice(0,12), from, to, query });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Anomaly Intel backend on port ${PORT}`));
