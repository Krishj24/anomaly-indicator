const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── YAHOO FINANCE OHLCV ─────────────────────────────────────────────────────
app.get('/api/ohlcv', async (req, res) => {
  const { symbol, interval = '1h', range = '1mo' } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await resp.json();
    const chart = data?.chart?.result?.[0];
    if (!chart) return res.status(404).json({ error: 'No data found for symbol' });

    const timestamps = chart.timestamp;
    const q = chart.indicators.quote[0];
    const candles = timestamps.map((t, i) => ({
      time: t,
      open:   q.open[i]   ? +q.open[i].toFixed(2)   : null,
      high:   q.high[i]   ? +q.high[i].toFixed(2)   : null,
      low:    q.low[i]    ? +q.low[i].toFixed(2)    : null,
      close:  q.close[i]  ? +q.close[i].toFixed(2)  : null,
      volume: q.volume[i] || 0
    })).filter(c => c.open && c.close);

    res.json({ symbol, interval, range, candles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ANOMALY DETECTION ────────────────────────────────────────────────────────
app.post('/api/detect', (req, res) => {
  const { candles, volMultiplier = 2.5, atrMultiplier = 2.0, gapThreshold = 0.5, velBars = 4 } = req.body;
  if (!candles || candles.length < 20) return res.status(400).json({ error: 'Not enough candle data' });

  const anomalies = [];

  // ATR helper
  const calcATR = (idx, period = 14) => {
    if (idx < period) return null;
    let sum = 0;
    for (let i = idx - period + 1; i <= idx; i++) {
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1]?.close ?? candles[i].open),
        Math.abs(candles[i].low  - candles[i - 1]?.close ?? candles[i].open)
      );
      sum += tr;
    }
    return sum / period;
  };

  // Rolling avg volume
  const avgVol = (idx, period = 20) => {
    if (idx < period) return null;
    let sum = 0;
    for (let i = idx - period; i < idx; i++) sum += candles[i].volume;
    return sum / period;
  };

  for (let i = 20; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const triggers = [];

    // 1. Volume spike
    const avgV = avgVol(i);
    if (avgV && c.volume > avgV * volMultiplier) {
      triggers.push({ type: 'VOL_SPIKE', detail: `${(c.volume / avgV).toFixed(1)}x avg volume` });
    }

    // 2. Price shock
    const atr = calcATR(i);
    const body = Math.abs(c.close - c.open);
    if (atr && body > atr * atrMultiplier) {
      triggers.push({ type: 'PRICE_SHOCK', detail: `${(body / atr).toFixed(1)}x ATR body` });
    }

    // 3. Gap
    const gapPct = Math.abs(c.open - prev.close) / prev.close * 100;
    if (gapPct >= gapThreshold) {
      const dir = c.open > prev.close ? 'UP' : 'DOWN';
      triggers.push({ type: `GAP_${dir}`, detail: `${gapPct.toFixed(2)}% gap ${dir.toLowerCase()}` });
    }

    // 4. Velocity / momentum run
    if (i >= velBars) {
      const bullRun = Array.from({ length: velBars }, (_, k) => candles[i - k])
        .every(x => x.close > x.open) &&
        candles[i].volume > candles[i - 1].volume &&
        candles[i - 1].volume > candles[i - 2].volume;
      const bearRun = Array.from({ length: velBars }, (_, k) => candles[i - k])
        .every(x => x.close < x.open) &&
        candles[i].volume > candles[i - 1].volume &&
        candles[i - 1].volume > candles[i - 2].volume;
      if (bullRun) triggers.push({ type: 'MOMENTUM_BULL', detail: `${velBars} consecutive bull bars with rising volume` });
      if (bearRun) triggers.push({ type: 'MOMENTUM_BEAR', detail: `${velBars} consecutive bear bars with rising volume` });
    }

    if (triggers.length > 0) {
      anomalies.push({
        index: i,
        time: c.time,
        candle: c,
        triggers,
        score: triggers.length,
        highConviction: triggers.length >= 2
      });
    }
  }

  res.json({ anomalies, total: anomalies.length });
});

// ─── NEWS FETCH (GNews) ───────────────────────────────────────────────────────
app.get('/api/news', async (req, res) => {
  const { query, from, to } = req.query;
  const GNEWS_KEY = process.env.GNEWS_API_KEY;
  if (!GNEWS_KEY) return res.status(500).json({ error: 'GNEWS_API_KEY not set' });

  try {
    const params = new URLSearchParams({
      q: query,
      lang: 'en',
      sortby: 'publishedAt',
      max: '10',
      apikey: GNEWS_KEY,
      ...(from && { from }),
      ...(to   && { to })
    });
    const resp = await fetch(`https://gnews.io/api/v4/search?${params}`);
    const data = await resp.json();
    res.json({ articles: data.articles || [], totalArticles: data.totalArticles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REUTERS RSS ──────────────────────────────────────────────────────────────
app.get('/api/reuters', async (req, res) => {
  const feeds = [
    'https://feeds.reuters.com/reuters/businessNews',
    'https://feeds.reuters.com/reuters/topNews',
    'https://feeds.reuters.com/reuters/worldNews'
  ];
  try {
    const results = await Promise.allSettled(feeds.map(f => fetch(f).then(r => r.text())));
    const items = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const xml = r.value;
      const matches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
      for (const m of matches) {
        const block = m[1];
        const title   = block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] || block.match(/<title>(.*?)<\/title>/)?.[1] || '';
        const link    = block.match(/<link>(.*?)<\/link>/)?.[1] || '';
        const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
        const desc    = block.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1] || block.match(/<description>(.*?)<\/description>/)?.[1] || '';
        if (title) items.push({ title, link, pubDate, description: desc.replace(/<[^>]+>/g, '').slice(0, 200), source: 'Reuters' });
      }
    }
    res.json({ articles: items.slice(0, 30) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GROQ AI ANALYSIS ─────────────────────────────────────────────────────────
app.post('/api/analyse', async (req, res) => {
  const { anomaly, newsArticles, symbol } = req.body;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });

  const triggersText = anomaly.triggers.map(t => `${t.type}: ${t.detail}`).join(', ');
  const newsText = newsArticles.slice(0, 6).map((a, i) =>
    `[${i + 1}] ${a.source || 'News'} | ${a.publishedAt || a.pubDate || ''}: ${a.title}`
  ).join('\n');

  const prompt = `You are a financial market analyst. A market anomaly was detected on ${symbol}.

ANOMALY DETAILS:
- Time: ${new Date(anomaly.time * 1000).toISOString()}
- Triggers: ${triggersText}
- Candle: Open ${anomaly.candle.open}, High ${anomaly.candle.high}, Low ${anomaly.candle.low}, Close ${anomaly.candle.close}, Volume ${anomaly.candle.volume}

NEWS AROUND THAT TIME:
${newsText || 'No news found in this window.'}

Respond in JSON only, no markdown, no explanation outside JSON:
{
  "probableCause": "1-2 sentence explanation of why this movement likely happened",
  "confidence": "CONFIRMED | LIKELY | UNCLEAR | TECHNICAL",
  "confidenceReason": "why you assigned this confidence level",
  "keyHeadline": "most relevant headline if any, else null",
  "marketType": "fundamental | technical | mixed",
  "actionableNote": "1 sentence trader takeaway"
}`;

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 400,
        temperature: 0.3
      })
    });
    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(clean));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── MANUAL TIMESTAMP LOOKUP ──────────────────────────────────────────────────
app.get('/api/manual-lookup', async (req, res) => {
  const { symbol, timestamp, keywords } = req.query;
  if (!symbol || !timestamp) return res.status(400).json({ error: 'symbol and timestamp required' });

  const ts = parseInt(timestamp);
  const from = new Date((ts - 7200) * 1000).toISOString(); // 2hrs before
  const to   = new Date((ts + 1800) * 1000).toISOString(); // 30min after

  // Build instrument-specific keyword set
  const kwMap = {
    '^NSEI':   'Nifty OR RBI OR SEBI OR "Indian market" OR BSE OR FII',
    '^NSEBANK':'BankNifty OR RBI OR "interest rate" OR banking India',
    'GC=F':    'GIFT Nifty OR "Indian futures" OR SGX Nifty',
    '^GSPC':   'S&P 500 OR Fed OR "Federal Reserve" OR CPI OR earnings',
    '^IXIC':   'Nasdaq OR Fed OR tech stocks OR "interest rate"',
    'CL=F':    'crude oil OR OPEC OR EIA OR "oil inventory" OR Iran',
    'BZ=F':    'Brent crude OR OPEC OR oil supply OR Russia',
    'USDINR=X':'USD INR OR RBI intervention OR "rupee" OR "dollar India"'
  };
  const baseKw = kwMap[symbol] || keywords || symbol;
  const query  = baseKw;

  try {
    const GNEWS_KEY = process.env.GNEWS_API_KEY;
    let gnewsArticles = [];
    if (GNEWS_KEY) {
      const params = new URLSearchParams({ q: query, lang: 'en', sortby: 'publishedAt', max: '10', apikey: GNEWS_KEY, from, to });
      const gr = await fetch(`https://gnews.io/api/v4/search?${params}`);
      const gd = await gr.json();
      gnewsArticles = (gd.articles || []).map(a => ({ ...a, source: a.source?.name || 'GNews', tier: 2 }));
    }

    // Reuters RSS (filtered by time window — best effort)
    const reutersResp = await fetch('https://feeds.reuters.com/reuters/businessNews').then(r => r.text()).catch(() => '');
    const rItems = [];
    const rMatches = [...reutersResp.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    for (const m of rMatches) {
      const block = m[1];
      const title   = block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] || '';
      const link    = block.match(/<link>(.*?)<\/link>/)?.[1] || '';
      const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
      if (title) rItems.push({ title, link, publishedAt: pubDate, source: 'Reuters', tier: 1 });
    }

    const all = [...rItems, ...gnewsArticles].slice(0, 15);
    res.json({ articles: all, from, to, query });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Market Anomaly Server running on port ${PORT}`));
