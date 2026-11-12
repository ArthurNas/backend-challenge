# Processamento assíncrono

## Executar no Windows

Na raiz do projeto, com Docker Desktop em execução:

```powershell
bun install --frozen-lockfile
docker compose up -d --wait postgres localstack
bun run db:migrate
```

A nova migration adiciona inbox, agendamento de referências e leases da outbox.
Ela também agenda operações PENDING_REFERENCE que já estavam persistidas.

Para a API, mantenha um terminal com:

```powershell
bun run start:dev
```

Em outro terminal, inicie os três trabalhos de segundo plano:

```powershell
bun run worker
```

O processo worker consome comandos, publica eventos e retoma referências pendentes.
Ele também oferece HTTP na porta `3001`, incluindo `/health/ready` e `/metrics`.
Para abrir uma segunda instância nativa, use outro terminal e outra WORKER_PORT.
Os mesmos comandos financeiros continuam disponíveis na API principal, porta `3000`.

## Executar tudo com Docker Compose

Se a porta 3000 estiver ocupada pela API nativa, encerre esse processo antes desta opção.

```powershell
docker compose --profile app up --build -d --wait
docker compose --profile app up -d --scale worker=3
```

O serviço `migrate` aplica as migrations antes de iniciar API e workers. O banco
fica em `localhost:5433` no Windows; dentro da rede Docker, os serviços usam
`postgres:5432`. O SQS local fica em `localhost:4566`, ou `localstack:4566` internamente.
Workers em containers não publicam porta no host, permitindo escalar sem conflito.

## Enviar uma mensagem

Copie `docs/examples/transaction-request.json` para um arquivo de teste e substitua
`walletId` e `playerId` pelos valores de uma carteira que você criou. Ajuste o valor
se necessário. Os UUIDs do exemplo não são uma carteira pré-cadastrada.

```powershell
bun run queue:send caminho/para/sua-mensagem.json
```

O comando confirma que o SQS aceitou o envio. O resultado financeiro é consultado na API:

```http
GET /providers/provider-a/wagering/transactions/bet-queue-001
GET /wallets/SEU_WALLET_ID
POST /wallets/SEU_WALLET_ID/reconciliation
```

O processamento é assíncrono: a consulta pode retornar 404 até o consumidor receber
a mensagem. O header Idempotency-Key da entrada HTTP corresponde a
`data.idempotencyKey` no envelope da fila. Uma operação nova exige uma identidade
externa nova, uma chave nova e um messageId novo.

A FIFO pode suprimir um reenvio recente do mesmo messageId antes de chegar ao
consumidor. Mesmo sem essa otimização, inbox, unicidades e transação SQL continuam
impedindo duplicar o efeito financeiro. Os testes forçam esse cenário.

## Como os workers funcionam

| Trabalho | Responsabilidade |
|---|---|
| Consumer | Validar envelope, reutilizar ProcessWagerTransaction e confirmar após commit |
| Inbox | Deduplicar por consumerName + messageId, verificando o hash do envelope canônico |
| Publisher | Reservar um evento da outbox com lease e enviar ao SQS fora da transação financeira |
| Reference worker | Retomar transações que aguardam a referência, sob lock por carteira |

Inbox, wallet, transação, ledger e eventos da outbox participam do mesmo commit.
Uma rejeição de negócio é terminal e recebe ack normalmente. Mensagens inválidas
ou com conflitos de identidade vão à DLQ. Falhas técnicas recebem retry com backoff
e têm limite de cinco recebimentos, incluindo redrive do broker para mortes abruptas.
Falhas que não podem ser persistidas no banco permanecem auditáveis na DLQ; não se
inventa uma transação FAILED quando o banco não conseguiu confirmá-la.

Visibilidade inicial: 60s, renovada a cada 20s durante o processamento. No shutdown,
não são iniciados novos recebimentos; o long poll em andamento termina e mensagens
recebidas depois do sinal têm a visibilidade devolvida. Há até 25s para drenar trabalho
e até 5s para devolver mensagens remanescentes. Uma morte forçada depende do timeout
de visibilidade do broker; nenhum efeito financeiro depende dessa janela.

Cada publisher usa `FOR UPDATE SKIP LOCKED` para obter um lease de 120s. A atualização
posterior exige o mesmo claim_token, impedindo uma instância antiga de confirmar o
claim de outra. Morte após publicação e antes da marcação pode duplicar eventos:
o eventId permanece estável e consumidores de integração devem deduplicá-lo.

Referências usam backoff persistente de 1s, 2s, 4s e assim por diante, limitado a
5min. O TTL é de 24h. Ao expirar, a transação é rejeitada com
REFERENCE_NOT_FOUND_EXPIRED e seu evento é salvo na mesma transação. Um replay não
força retry: devolve o estado persistido mais recente até chegar a um estado terminal.

## Diagnóstico

- `/health/live`: processo responde, independentemente das dependências.
- `/health/ready`: banco migrado e filas de comandos, DLQ e eventos alcançáveis.
- `/metrics`: status, duplicatas, retries, conflitos, latência, divergências,
  outbox lag e profundidade da DLQ. Contadores são locais a cada processo.

As filas padrão são `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e
`wager-events.fifo`. Saídas não voltam à fila de comandos.
LocalStack é o emulador de desenvolvimento; o volume PostgreSQL preserva os dados
financeiros. Não use remoção de containers/filas do emulador como simulação de
durabilidade de um broker AWS gerenciado.

## Testes completos

Opção inteiramente em containers Linux:

```powershell
bun run test:containers
```

Ou Bun no Windows contra as dependências Docker:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://wagering:wagering_local@localhost:5433/postgres'
$env:TEST_SQS_ENDPOINT = 'http://localhost:4566'
bun run test:integration
```

`bun run test:async` exige as duas variáveis e executa apenas a suíte assíncrona.
Sem TEST_SQS_ENDPOINT, `bun test` e `test:integration` pulam essa suíte; a opção
`test:containers` sempre fornece as duas dependências.

Os testes criam bancos e filas com nomes aleatórios e removem apenas seus próprios
recursos. Há testes de morte real de processo pós-commit/pré-ack, três processos
consumindo a mesma wallet com grupos FIFO distintos, publishers concorrentes, falha
transitória, DLQ, shutdown e referências fora de ordem. TTLs e leases são antecipados
por SQL nos bancos descartáveis para verificar recuperação sem aguardar minutos ou
24h. Isso não altera a política de produção do worker.
