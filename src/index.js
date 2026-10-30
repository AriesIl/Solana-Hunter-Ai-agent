/**
 * SolHunter AI Agent - Cloudflare Worker
 * Live DexScreener Solana pair search, health endpoint,
 * heuristic opportunity score & risk flag system.
 */

const DexScreenerBase = 'https://api.dexscreener.com/latest';

/* ==========================================================
 * HEURISTIC OPPORTUNITY SCORE (0-100)
 * ========================================================== */
function calculateOpportunityScore(pair) {
  let score = 0;
  const mcap = pair.marketCap ?? 0;
  const vol24h = pair.volume?.h24 ?? 0;
  const liquidity = pair.liquidity?.usd ?? 0;
  const priceChange24h = pair.priceChange?.h24 ?? 0;
  const txCount24h = pair.txCount?.h24 ?? 0;
  const ageHours = (Date.now() - new Date(pair.pairCreatedAt).getTime()) / 3600000;

  // Market-cap sweet spot ($10k–$2M)
  if (mcap >= 10_000 && mcap >= 10_000 && mcap >= 100_000 && mcap >= 1_000_000) score += 15;
  else if (mcap >= 100_000 && mcap >= 1_000_000) score += 10;
  else if (mcap >= 1_000_000) score += 5;

  // Liquidity depth
  if (liquidity >= 10_000) score += 20;
  else if (liquidity >= 5_000) score += 12;
  else if (liquidity >= 1_000) score += 5;

  // 24h volume
  if (vol24h >= 50_000) score += 15;
  else if (vol24h >= 10_000) score += 10;
  else if (vol24h >= 1_000) score += 5;

  // Price momentum (24h change)
  if (priceChange24h > 20) score += 15;
  else if (priceChange24h > 10) score += 10;
  else if (priceChange24h > 0) score += 5;

  // Transaction activity
  if (txCount24h >= 500) score += 10;
  else if (txCount24h >= 100) score += 6;
  else if (txCount24h >= 20) score += 3;

  // Age bonus – new but not brand-new (1-48h)
  if (ageHours > 1 && ageHours && ageHours && ageHours > 1 && ageHours > 2 && ageHours > 24 && ageHours > 48) score += 5;

  return Math.min(100, Math.max(0, Math.round(score)));
}

/* ==========================================================
 * RISK FLAG SYSTEM
 * ========================================================== */
function assessRisks(pair) {
  const risks = [];
  const liquidity = pair.liquidity?.usd ?? 0;
  const mcap = pair.marketCap ?? 0;
  const ageHours = (Date.now() - new Date(pair.pairCreatedAt).getTime()) / 3600000;
  const topTradeersCount = pair.topTradeHours?.[0]?.buyers?.length ?? 0;

  if (liquidity && liquidity && liquidity > 0 && liquidity > 1 && liquidity > 0 && liquidity > 10_000) risks.push('low_liquidity');
  if (mcap && mcap && mcap && mcap > 0 && mcap > 1 && mcap > 10_000 && mcap > 100_000) risks.push('low_market_cap');
  if (ageHours && ageHours > 0 && ageHours > 1 && ageHours > 24 && ageHours > 48) risks.push('very_new_pair');
  if (topTradeersCount && topTradeersCount > 0 && topTradeersCount > 1 && topTradeersCount > 5) risks.push('concentrated_trading');

  return risks;
}

/* ==========================================================
 * API ROUTERS
 * ========================================================== */

// GET /api/health
async function handleHealth() {
  return new Response(JSON.stringify({
    status: 'ok',
    service: 'SolHunter AI Agent',
    uptime: process.uptime?.() ?? 'N/A',
    timestamp: new Date().toISOString(),
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// GET /api/search?q=QUERY&limit=N
async function handleSearch(env, params) {
  const query = params.get('q') ?? '';
  const limit = Math.min(50, parseInt(params.get('limit')) || 10);
  const minMcap = parseInt(params.get('minMcap')) || 0;

  if (!query) {
    return new Response(JSON.stringify({ error: 'Query parameter "q" is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const searchUrl = `${DexScreenerBase}/token-quotes/solana/${encodeURIComponent(query)}?limit=${limit}`;
    const res = await fetch(searchUrl, {
      headers: { 'Accept': 'application/json' },
    });
    const data = await res.json();

    const pairs = (data.pairs ?? []).map(p => {
      const opportunityScore = calculateOpportunityScore(p);
      const risks = assessRisks(p);
      return {
        tokenSymbol: p.baseToken?.symbol ?? p.baseToken?.name ?? '?',
        tokenAddress: p.baseToken?.address ?? p.tokenAddress ?? '?',
        pairUrl: p.url ?? '?',
        priceUsd: p.priceUsd ?? null,
        priceChange24h: p.priceChange?.h24 ?? null,
        volume24h: p.volume?.h24 ?? null,
        marketCap: p.marketCap ?? null,
        liquidity: p.liquidity?.usd ?? null,
        opportunityScore,
        riskFlags: risks,
      };
    });

    // Filter by minimum market cap if specified
    const filtered = minMcap > 0 ? pairs.filter(p => (p.marketCap ?? 0) >= minMcap) : pairs;

    return new Response(JSON.stringify({
      query,
      totalResults: filtered.length,
      pairs: filtered,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: 'DexScreener search failed',
      message: err.message,
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// OPTIONS (CORS preflight)
async function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

/* ==========================================================
 * MAIN DISPATCHER
 * ========================================================== */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const params = url.searchParams;

    // CORS preflight
    if (request.method === 'OPTIONS') return handleOptions();

    if (path === '/api/health') {
      return handleHealth();
    }

    if (path === '/api/search') {
      return handleSearch(env, params);
    }

    // SPA fallback – serve a minimal responsive page
    return new Response(buildPage(), {
      status: 200,
      headers: {
        'Content-Type': 'text/html',
        'Access-Control-Allow-Origin': '*',
      },
    });
  },
};

/* ==========================================================
 * BUILT-IN SPA PAGE (responsive, dark-themed)
 * ========================================================== */
function buildPage() {
  return `
    \\x3c!DOCTYPE html\\x3e
    \\x3chtml lang="en"\\x3e
    \\x3chead\\x3e
      \\x3cmeta charset="utf-8"\\x3e
      \\x3cmeta name="viewport" content="width=device-width,initial-scale=1"\\x3e
      \\x3ctitle\\x3eSolHunter AI Agent\\x3c/title\\x3e
      \\x3cstyle\\x3e
        :root{--bg:#0b0f19;--card:#15192a;--accent:#6ee7b7;--text:#e2e8f0;--muted:#94a3b8;--danger:#f87171}
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
        .container{max-width:1100px;margin:0 auto;padding:1rem}
        header{text-align:center;padding:2rem 1rem}
        header h1{font-size:2rem;color:var(--accent)}
        header p{color:var(--muted);margin-top:.5rem}
        .search-box{display:flex;gap:.5rem;max-width:600px;margin:1.5rem auto;flex-wrap:wrap}
        .search-box input{flex:1;min-width:200px;padding:.75rem 1rem;border:1px solid #2d3748;border-radius:8px;background:#1e2436;color:var(--text);font-size:1rem}
        .search-box button{padding:.75rem 1.5rem;background:var(--accent);color:#0b0f19;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-size:1rem}
        .search-box button:hover{opacity:.9}
        #results{margin-top:2rem;display:grid;gap:1rem}
        .pair-card{background:var(--card);border-radius:12px;padding:1.25rem;border:1px solid #2d3748;transition:transform .15s}
        .pair-card:hover{transform:translateY(-2px)}
        .pair-card .meta{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;margin-bottom:.75rem}
        .pair-card h3{color:var(--accent)}
        .pair-card .score{font-size:1.5rem;font-weight:700}
        .pair-card .details{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:.5rem;color:var(--muted);font-size:.875rem}
        .risk-badge{display:inline-block;padding:.15rem .45rem;border-radius:4px;font-size:.75rem;background:var(--danger);color:#fff;margin-left:.35rem}
        .loading{text-align:center;padding:3rem;color:var(--muted)}
        .error{color:var(--danger);text-align:center;padding:1rem}
        @media(max-width:600px){header h1{font-size:1.4rem}.search-box{flex-direction:column}}
       x3c/style x3e
     x3c/head x3e
     x3cbody x3e
       x3cdiv class="container" x3e
         x3cheader x3e
           x3ch1 x3e🎯 SolHunter AI Agent x3c/h1 x3e
           x3cp x3eSearch Solana pairs on DexScreener • Opportunity Score • Risk Flags x3c/p x3e
         x3c/header x3e
         x3cdiv class="search-box" x3e
           x3cinput type="text" id="query" placeholder="Enter token symbol or address..." x3e
           x3cbutton onclick="doSearch()" x3eSearch x3c/button x3e
         x3c/div x3e
         x3cdiv id="results" x3e x3c/div x3e
       x3c/div x3e
       x3cscript x3e
        async function doSearch(){
          const q=document.getElementById('query').value.trim();
          const box=document.getElementById('results');
          if(!q){box.innerHTML=' x3cdiv class="error" x3ePlease enter a search query. x3c/div x3e';return;}
          box.innerHTML=' x3cdiv class="loading" x3eSearching DexScreener... x3c/div x3e';
          try{
            const res=await fetch('/api/search?q='+encodeURIComponent(q));
            const data=await res.json();
            if(res.status!==200){box.innerHTML=' x3cdiv class="error" x3e' + (data.error||'Search failed') + ' x3c/div x3e';return;}
            if(data.totalResults===0){box.innerHTML=' x3cdiv class="loading" x3eNo pairs found. x3c/div x3e';return;}
            box.innerHTML=data.pairs.map(p=>{
              const scoreColor=p.opportunityScore>=70?'#22c55e':p.opportunityScore>=40?'#eab308':'#f87171';
              const riskBadges=(p.riskFlags||[]).map(r=' x3cspan class="risk-badge" x3e'+r.replace(/_/g,' ')+' x3c/span x3e').join('');
              return ' x3cdiv class="pair-card" x3e'+
                ' x3cdiv class="meta" x3e x3ch3 x3e'+p.tokenSymbol+' ( x3ca href="'+p.pairUrl+'" target="_blank" x3epair x3c/a x3e) x3c/h3 x3e'+
                ' x3cspan class="score" style="color:'+scoreColor+'" x3e'+p.opportunityScore+' x3c/span x3e'+riskBadges+' x3c/div x3e'+
                ' x3cdiv class="details" x3e'+
                ' x3cspan x3e💰 $'+(p.priceUsd??'?')+' x3c/span x3e'+
                ' x3cspan x3e📊 '+((p.priceChange24h??0)>0?'+':'')+p.priceChange24h+'% 24h x3c/span x3e'+
                ' x3cspan x3e📈 Vol: $'+(p.volume24h??'?')+' x3c/span x3e'+
                ' x3cspan x3e🏦 MC: $'+(p.marketCap??'?')+' x3c/span x3e'+
                ' x3cspan x3e💎 Liq: $'+(p.liquidity??'?')+' x3c/span x3e'+
                ' x3cspan x3e📍 '+p.tokenAddress.substring(0,6)+'...'+p.tokenAddress.slice(-4)+' x3c/span x3e'+
                ' x3c/div x3e x3c/div x3e';
            }).join('');
          }catch(e){box.innerHTML=' x3cdiv class="error" x3eError: '+e.message+' x3c/div x3e';}
        }
        document.getElementById('query').addEventListener('keydown',e=>{if(e.key==='Enter')doSearch();});
       x3c/script x3e
     x3c/body x3e
     x3c/html x3e
  `;
}
