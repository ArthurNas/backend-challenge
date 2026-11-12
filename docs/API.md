# API financeira

## Preparação

Na raiz do projeto, com PostgreSQL disponível e `DATABASE_URL` no `.env`:

```powershell
bun install --frozen-lockfile
bun run db:migrate
bun run start:dev
```

O Bun carrega o `.env` ao executar os comandos. O servidor usa `PORT=3000` por padrão.
Autenticação externa foi adiada conforme permitido pelo desafio. `ProviderIdentityPort`
é o ponto de integração futuro; a implementação atual permite o acesso de desenvolvimento.

## Exemplo em outro terminal PowerShell

Criar uma carteira com 100 reais:

```powershell
$apiUrl = 'http://localhost:3000'
$walletBody = @{
  playerId = [guid]::NewGuid().ToString()
  initialBalance = @{ amount = '100.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 5

$wallet = Invoke-RestMethod -Method Post -Uri "$apiUrl/wallets" `
  -ContentType 'application/json' -Body $walletBody
$wallet | ConvertTo-Json -Depth 5
```

O saldo é uma string, e a versão inicial é 1. A abertura positiva também cria uma
transação interna `OPENING`, seu lançamento de crédito e eventos na outbox.

Enviar uma aposta de 25 reais:

```powershell
$bet = @{
  providerId = 'provider-a'
  externalTransactionId = [guid]::NewGuid().ToString()
  playerId = $wallet.playerId
  walletId = $wallet.id
  roundId = 'round-demo'
  gameId = 'game-demo'
  kind = 'BET'
  money = @{ amount = '25.00'; currency = 'BRL' }
}
$betJson = $bet | ConvertTo-Json -Depth 5
$headers = @{
  'Idempotency-Key' = "provider-a:$($bet.externalTransactionId)"
  'X-Correlation-Id' = 'demo-request'
}

Invoke-RestMethod -Method Post -Uri "$apiUrl/wagering/transactions" `
  -ContentType 'application/json' -Headers $headers -Body $betJson
```

Resultado esperado: `PROCESSED`, saldo `75.00` e `idempotentReplay: false`.
Executar exatamente a última requisição novamente retorna o mesmo resultado com
`idempotentReplay: true`, sem novo débito. Alterar o valor mantendo a chave retorna 409.

Consultar a carteira, o ledger e a reconciliação:

```powershell
Invoke-RestMethod "$apiUrl/wallets/$($wallet.id)"
Invoke-RestMethod "$apiUrl/wallets/$($wallet.id)/ledger?limit=50" | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method Post "$apiUrl/wallets/$($wallet.id)/reconciliation" | ConvertTo-Json -Depth 5
```

A carteira deve estar em `75.00`, com versão 2. O ledger deve conter abertura e
aposta. A reconciliação deve responder `consistent: true` e diferença `0.00`.

## Endpoints implementados

| Método | Caminho | Função |
|---|---|---|
| POST | `/wallets` | Criar carteira e abertura atômica |
| GET | `/wallets/:walletId` | Consultar saldo e versão |
| GET | `/wallets/:walletId/ledger` | Paginar lançamentos |
| POST | `/wallets/:walletId/reconciliation` | Comparar saldo e ledger |
| POST | `/wagering/transactions` | Processar operação com Idempotency-Key obrigatório |
| GET | `/wagering/transactions/:transactionId` | Consultar operação por ID interno |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consultar pela identidade externa |
| GET | `/health/live` | Verificar processo vivo, sem autenticação |
| GET | `/health/ready` | Verificar banco migrado e filas SQS |
| GET | `/metrics` | Métricas locais da instância em formato Prometheus |

O cursor do ledger é opaco e vinculado à carteira. Envie `nextCursor` como `cursor`
na próxima chamada. `limit` aceita 1 a 100, com padrão 50. A ordenação usa a versão
da carteira, preservando a sequência financeira mesmo com timestamps iguais.

## Resultados e erros

| HTTP | Situação |
|---|---|
| 201 | Carteira criada |
| 200 | Operação processada, replay processado ou consulta bem-sucedida |
| 202 | Operação persistida aguardando referência |
| 400 | Contrato inválido, cursor inválido ou OPENING enviado externamente |
| 404 | Carteira ou transação não encontrada |
| 409 | Carteira duplicada ou conflito de idempotência/identidade |
| 422 | Rejeição de negócio persistida, com failureCode |
| 503 | Falha transitória de infraestrutura |
| 500 | Erro interno não classificado como falha transitória |

Uma rejeição retorna `transactionId`, `status`, saldo observado, `failureCode` e
`idempotentReplay`. Erros anteriores à aceitação retornam `code` e `statusCode`.
Um replay de rejeição mantém 422 e a resposta histórica. A mesma identidade externa
com outra chave é conflito, mesmo quando o payload é igual.

BET/WIN/REFUND/ROLLBACK exigem valor positivo; LOSS exige zero. REFUND/ROLLBACK
exigem `referenceExternalTransactionId` e reversão integral. WIN pode referenciar
BET e ter valor diferente. Rejeições não geram ledger nem alteram a versão.

Referência ausente ou ainda pendente resulta em 202. Com `bun run worker` em execução,
ela será reprocessada com backoff, até o TTL de 24h. O publisher do mesmo processo
publica os eventos persistidos na outbox. Veja `docs/ASYNC.md` para setup e testes.

## Como o NestJS participa

Os controllers validam e adaptam HTTP; o caso de uso coordena o domínio. O módulo
conecta dependências, como `FinancialStore` à implementação PostgreSQL. Essa
separação permite à futura entrada SQS chamar `ProcessWagerTransaction` sem HTTP.
Os erros são traduzidos por um filtro comum, sem expor SQL ou payloads financeiros.
