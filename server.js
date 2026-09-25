const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v26.0';

// Ordem fixa de exibicao: Uniandrade, Ibirapuera, SMG
const ACCOUNTS = [
  { name: 'Uniandrade', id: '107419093141255' },
  { name: 'Ibirapuera', id: '113511182725885' },
  { name: 'SMG', id: '102024700446622' },
];

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

async function getDashboardData() {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const days = daysOfCurrentMonthUpToToday();
  const results = [];

  for (const account of ACCOUNTS) {
    const byDay = await fetchAccountInsights(account.id);
    const rows = days.map((day) => ({ day, leads: byDay[day] || 0 }));
    const total = rows.reduce((sum, r) => sum + r.leads, 0);
    results.push({ name: account.name, rows, total });
  }

  cache = { data: results, fetchedAt: now };
  return results;
}

function formatDay(isoDay) {
  const [, m, d] = isoDay.split('-');
  return `${d}/${m}`;
}

function renderSection(account) {
  const rowsHtml = [...account.rows]
    .reverse() // dia mais recente primeiro
    .map(
      (r) => `
        <tr>
          <td>${formatDay(r.day)}</td>
          <td class="num">${r.leads}</td>
        </tr>`
    )
    .join('');

  return `
    <section class="card">
      <div class="card-header">
        <h2>${account.name}</h2>
        <div class="total">
          <span class="total-label">Total do mes</span>
          <span class="total-value">${account.total}</span>
        </div>
      </div>
      <table>
        <thead>
          <tr><th>Dia</th><th>Leads</th></tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
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
    flex-wrap: wrap;
    gap: 20px;
  }
  .card {
    background: #fff;
    border-radius: 10px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    padding: 16px 18px;
    flex: 1;
    min-width: 260px;
    max-height: 80vh;
    overflow-y: auto;
  }
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid #eee;
    position: sticky;
    top: 0;
    background: #fff;
  }
  .card-header h2 {
    font-size: 16px;
    margin: 0;
  }
  .total {
    text-align: right;
  }
  .total-label {
    display: block;
    font-size: 11px;
    color: #888;
  }
  .total-value {
    display: block;
    font-size: 20px;
    font-weight: 700;
    color: #0a58ff;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }
  th, td {
    text-align: left;
    padding: 6px 4px;
  }
  th {
    color: #888;
    font-weight: 500;
    font-size: 12px;
    border-bottom: 1px solid #eee;
  }
  td.num, th:last-child {
    text-align: right;
  }
  tr:nth-child(even) {
    background: #fafafa;
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
  <div class="grid">
    ${sectionsHtml}
  </div>
  <div class="updated">Atualizado a cada 10 minutos. Ultima busca: ${new Date(cache.fetchedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</div>
</body>
</html>`);
  } catch (err) {
    res.status(500).send(`<pre>Erro ao buscar dados: ${err.message}</pre>`);
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard rodando na porta ${PORT}`);
});
