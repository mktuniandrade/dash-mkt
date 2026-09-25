# Dashboard de leads - Uniandrade / Ibirapuera / SMG

Mostra, numa tela só, quantos leads (WhatsApp + formulário, somados) cada
uma das tres contas gerou por dia no mes atual, com o total do mes ao lado.

## Rodar local

```
npm install
META_ACCESS_TOKEN=seu_token_aqui npm start
```

Abre em http://localhost:3000

## Deploy no Railway

1. Sobe esse projeto pro GitHub (repo novo).
2. No Railway, cria um novo projeto a partir desse repo.
3. Em Variables, adiciona:
   - `META_ACCESS_TOKEN` = token do usuario de sistema (o mesmo que voce
     ja gerou e testou no Graph API Explorer)
4. Deploy. O Railway detecta o `npm start` sozinho.

## Se mudar o account ID de alguma conta

Os tres IDs estao fixos no topo do `server.js`, na constante `ACCOUNTS`.
Se algum mudar, edita ali direto.

## Quando os formularios (forms) entrarem no ar

Nao precisa mudar nada. O `lead` gerado por formulario ja entra
automaticamente na mesma soma do dia, junto com o lead do WhatsApp
(`onsite_conversion.messaging_conversation_started_7d`). Isso esta
definido na constante `LEAD_ACTION_TYPES` no `server.js`.

## Cache

Os dados ficam guardados em memoria por 10 minutos pra nao estourar o
limite de chamadas da API do Meta a cada vez que alguem abre a tela.
Pra mudar esse tempo, ajusta `CACHE_TTL_MS` no `server.js`.
