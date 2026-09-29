const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v26.0';

// Ordem fixa de exibicao: Uniandrade, Ibirapuera, SMG
// Cor de cada uma pra diferenciar rapido no dash (mesma familia de azul pra
// Uniandrade/Ibirapuera, mas com tom diferente pra nao confundir; SMG em
// dourado, mais legivel que amarelo puro em fundo branco)
// alphaInstituicaoId = InstituicaoID usado na API da Alfa pra essa unidade
const ACCOUNTS = [
  { name: 'Uniandrade', id: '107419093141255', alphaInstituicaoId: 1, color: '#2563EB', bg: '#DBEAFE' },
  { name: 'Ibirapuera', id: '113511182725885', alphaInstituicaoId: 4, color: '#0D9488', bg: '#CCFBF1' },
  { name: 'SMG', id: '102024700446622', alphaInstituicaoId: 3, color: '#D97706', bg: '#FEF3C7' },
];

// API da Alfa (cadastro real do lead). Ano de ingresso fixo em 2027 e
// periodo 1, conforme confirmado. Mes/Dia mudam por chamada.
const ALPHA_BASE_URL = 'https://alpha.uniandrade.br/WsApiDashboard/api/Dashboard/Campanha';
const ALPHA_ANO_INGRESSO = 2027;
const ALPHA_PERIODO_INGRESSO = 1;

// Quando o form estiver rodando, o lead dele vem como action_type "lead".
// O lead do WhatsApp (clique -> conversa) vem como conversa iniciada.
// Soma os dois sem separar, como pedido.
const LEAD_ACTION_TYPES = [
  'lead',
  'onsite_conversion.messaging_conversation_started_7d',
];

// Cache simples em memoria pra nao bater na API do Meta a cada refresh de tela
let cache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos

function todayInSaoPaulo() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

function daysOfCurrentMonthUpToToday() {
  const today = todayInSaoPaulo();
  const [year, month] = today.split('-').map(Number);
  const days = [];
  for (let d = 1; d <= Number(today.split('-')[2]); d++) {
    const dd = String(d).padStart(2, '0');
    const mm = String(month).padStart(2, '0');
    days.push(`${year}-${mm}-${dd}`);
  }
  return days;
}

async function fetchAccountInsights(accountId) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/act_${accountId}/insights`);
  url.searchParams.set('level', 'account');
  url.searchParams.set('fields', 'actions,date_start');
  url.searchParams.set('time_increment', '1');
  url.searchParams.set('date_preset', 'this_month');
  url.searchParams.set('access_token', META_ACCESS_TOKEN);

  const res = await fetch(url.toString());
  const json = await res.json();

  if (json.error) {
    throw new Error(`Meta API (${accountId}): ${json.error.message}`);
  }

  // date_start -> soma de leads (whats + forms) daquele dia
  const byDay = {};
  for (const row of json.data || []) {
    const actions = row.actions || [];
    let leads = 0;
    for (const action of actions) {
      if (LEAD_ACTION_TYPES.includes(action.action_type)) {
        leads += Number(action.value || 0);
      }
    }
    byDay[row.date_start] = leads;
  }
  return byDay;
}

// Soma "visitantes" de todas as campanhas retornadas naquele dia/instituicao.
// "visitantes" e o cadastro bruto (lead) na Alfa, confirmado pelo Gabriel.
async function fetchAlphaVisitantesForDay(instituicaoId, month, day) {
  const url = new URL(ALPHA_BASE_URL);
  url.searchParams.set('AnoIngresso', String(ALPHA_ANO_INGRESSO));
  url.searchParams.set('PeriodoIngresso', String(ALPHA_PERIODO_INGRESSO));
  url.searchParams.set('Mes', String(month));
  url.searchParams.set('Dia', String(day));
  url.searchParams.set('InstituicaoID', String(instituicaoId));

  const res = await fetch(url.toString());
  const json = await res.json();

  if (!Array.isArray(json)) return 0;
  return json.reduce((sum, campanha) => sum + Number(campanha.visitantes || 0), 0);
}

async function fetchAlphaByDay(instituicaoId, isoDays) {
  const byDay = {};
  await Promise.all(
    isoDays.map(async (isoDay) => {
      const [, m, d] = isoDay.split('-').map(Number);
      try {
        byDay[isoDay] = await fetchAlphaVisitantesForDay(instituicaoId, m, d);
      } catch (err) {
        byDay[isoDay] = null; // falha pontual pra aquele dia, nao derruba o resto
      }
    })
  );
  return byDay;
}

async function getDashboardData() {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const days = daysOfCurrentMonthUpToToday();
  const results = [];

  for (const account of ACCOUNTS) {
    const [metaByDay, alphaByDay] = await Promise.all([
      fetchAccountInsights(account.id),
      fetchAlphaByDay(account.alphaInstituicaoId, days),
    ]);

    const rows = days.map((day) => ({
      day,
      metaLeads: metaByDay[day] || 0,
      alphaLeads: alphaByDay[day] ?? 0,
    }));
    const totalMeta = rows.reduce((sum, r) => sum + r.metaLeads, 0);
    const totalAlpha = rows.reduce((sum, r) => sum + (r.alphaLeads || 0), 0);

    results.push({
      name: account.name,
      color: account.color,
      bg: account.bg,
      rows,
      totalMeta,
      totalAlpha,
    });
  }

  cache = { data: results, fetchedAt: now };
  return results;
}

function formatDay(isoDay) {
  const [, m, d] = isoDay.split('-');
  return `${d}/${m}`;
}

const BAR_AREA_HEIGHT = 200; // px, altura util pras barras (sem contar numero e label)
const VISIBLE_DAYS = 10; // quantas colunas ficam cheias na largura da tela, o resto fica no scroll
const BAR_GAP = 12; // px de espaco entre colunas

function renderSection(account) {
  const maxLeads = Math.max(
    1,
    ...account.rows.map((r) => Math.max(r.metaLeads, r.alphaLeads || 0))
  );

  const barsHtml = account.rows // ordem cronologica, dia 1 -> hoje
    .map((r) => {
      const metaHeight = Math.max(2, Math.round((r.metaLeads / maxLeads) * BAR_AREA_HEIGHT));
      const alphaValue = r.alphaLeads;
      const alphaHeight =
        alphaValue === null ? 0 : Math.max(2, Math.round((alphaValue / maxLeads) * BAR_AREA_HEIGHT));
      const alphaDisplay = alphaValue === null ? '-' : alphaValue;

      return `
        <div class="day-group">
          <div class="mini-bars">
            <div class="mini-bar-wrap">
              <span class="bar-value">${r.metaLeads}</span>
              <div class="bar" style="height:${metaHeight}px;background:${account.color}"></div>
            </div>
            <div class="mini-bar-wrap">
              <span class="bar-value alpha-value">${alphaDisplay}</span>
              <div class="bar alpha" style="height:${alphaHeight}px;background:${account.color}55"></div>
            </div>
          </div>
          <span class="bar-label">${formatDay(r.day)}</span>
        </div>`;
    })
    .join('');

  return `
    <section class="card">
      <div class="card-header" style="background:${account.bg}">
        <h2 style="color:${account.color}">${account.name}</h2>
        <div class="totals">
          <div class="total">
            <span class="total-label">Meta (mes)</span>
            <span class="total-value" style="color:${account.color}">${account.totalMeta}</span>
          </div>
          <div class="total">
            <span class="total-label">Alfa (mes)</span>
            <span class="total-value alpha-value" style="color:${account.color}">${account.totalAlpha}</span>
          </div>
        </div>
      </div>
      <div class="chart">
        ${barsHtml}
      </div>
    </section>`;
}

app.get('/', async (req, res) => {
  try {
    const data = await getDashboardData();
    const sectionsHtml = data.map(renderSection).join('\n');

    res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Leads - Uniandrade / Ibirapuera / SMG</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="1800">
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    background: #f4f5f7;
    color: #1a1a1a;
    margin: 0;
    padding: 24px;
  }
  h1 {
    font-size: 20px;
    margin: 0 0 20px 0;
  }
  .grid {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .card {
    background: #fff;
    border-radius: 10px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    padding: 16px 18px;
    width: 100%;
  }
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: -16px -18px 16px -18px;
    padding: 12px 18px;
    border-radius: 10px 10px 0 0;
  }
  .card-header h2 {
    font-size: 16px;
    margin: 0;
    font-weight: 700;
  }
  .total {
    text-align: right;
  }
  .totals {
    display: flex;
    gap: 20px;
  }
  .total-label {
    display: block;
    font-size: 11px;
    color: #666;
  }
  .total-value {
    display: block;
    font-size: 20px;
    font-weight: 700;
  }
  .total-value.alpha-value {
    opacity: 0.65;
  }
  .chart {
    display: flex;
    align-items: flex-end;
    gap: ${BAR_GAP}px;
    overflow-x: auto;
    padding-bottom: 4px;
    scroll-behavior: smooth;
  }
  .day-group {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    flex: 0 0 calc((100% - ${(VISIBLE_DAYS - 1) * BAR_GAP}px) / ${VISIBLE_DAYS});
  }
  .mini-bars {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    gap: 4px;
    width: 100%;
    height: ${BAR_AREA_HEIGHT}px;
  }
  .mini-bar-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    width: 50%;
    height: 100%;
  }
  .bar-value {
    font-size: 12px;
    font-weight: 600;
    color: #333;
    margin-bottom: 4px;
  }
  .bar-value.alpha-value {
    color: #777;
  }
  .bar {
    width: 100%;
    max-width: 26px;
    border-radius: 4px 4px 0 0;
  }
  .bar-label {
    font-size: 11px;
    color: #888;
    margin-top: 6px;
    white-space: nowrap;
  }
  .legend {
    display: flex;
    gap: 16px;
    font-size: 12px;
    color: #666;
    margin-bottom: 16px;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .legend .dot {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    display: inline-block;
  }
  .updated {
    margin-top: 16px;
    font-size: 12px;
    color: #999;
  }
</style>
</head>
<body>
  <h1>Leads do mes</h1>
  <div class="legend">
    <span><span class="dot" style="background:#555"></span> Meta (entrou no anuncio)</span>
    <span><span class="dot" style="background:#555;opacity:0.4"></span> Alfa (cadastrado de fato)</span>
  </div>
  <div class="grid">
    ${sectionsHtml}
  </div>
  <div class="updated">Atualizado a cada 10 minutos. Ultima busca: ${new Date(cache.fetchedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</div>
  <script>
    document.querySelectorAll('.chart').forEach(function (el) {
      el.scrollLeft = el.scrollWidth;
    });
  </script>
</body>
</html>`);
  } catch (err) {
    res.status(500).send(`<pre>Erro ao buscar dados: ${err.message}</pre>`);
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard rodando na porta ${PORT}`);
});
