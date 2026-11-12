# Distributed Wagering Processor

Serviço financeiro do desafio backend com API NestJS, PostgreSQL, SQS, idempotência
persistente, inbox/outbox e workers de publicação e referências pendentes.

- [Enunciado original](docs/CHALLENGE.md)
- [Decisões de arquitetura](ARCHITECTURE.md)
- [Endpoints e exemplo em PowerShell](docs/API.md)
- [Workers, filas e testes em containers](docs/ASYNC.md)

## Requisitos

- Bun 1.x (runtime, gerenciador de dependências e testes).
- Docker com Compose para PostgreSQL e SQS local.

## Execução local

```powershell
Copy-Item .env.example .env # apenas na primeira configuração
bun install --frozen-lockfile
bun run infra:up
bun run db:migrate
bun run start:dev
```

O Compose inicia PostgreSQL e LocalStack. O script de inicialização provisiona as
filas de comandos, DLQ e eventos. Em outro terminal, execute `bun run worker` para
consumir comandos, publicar eventos e retomar referências pendentes. O worker oferece
HTTP e métricas na porta 3001. Para testar apenas HTTP, basta subir o serviço
`postgres` com `docker compose up -d --wait postgres`. PostgreSQL nativo também pode
ser usado: ajuste `DATABASE_URL` no `.env` para um banco de desenvolvimento próprio.
Credenciais do exemplo são exclusivamente locais.

O PostgreSQL do Compose fica disponível em `localhost:5433` no Windows, mapeado
para a porta `5432` interna do container. Isso evita conflito com instalações locais
de PostgreSQL que já utilizem `5432`. A `DATABASE_URL` deve usar a porta `5433`.

```powershell
Invoke-RestMethod http://localhost:3000/health/live
```

Resposta: `{ "status": "ok" }`. Este endpoint só comprova que o processo está vivo.
`GET /health/ready` verifica o banco migrado e as três filas SQS; retorna 503 se uma
dependência estiver indisponível. Ambos os endpoints são públicos.

```powershell
bun run typecheck
bun run build
bun run start
bun run infra:down
```

Para verificar somente o módulo de health, sem banco, com porta temporária e
encerramento automático:

```powershell
bun scripts/smoke.ts
```

O servidor completo exige `DATABASE_URL`, mas consegue iniciar com o banco fora do
ar: liveness responde e os endpoints financeiros retornam 503 quando a conexão falha.
As migrations são um comando explícito; não são executadas automaticamente ao iniciar.

`infra:down` mantém o volume do PostgreSQL.

## Banco e testes

Após subir o PostgreSQL e copiar `.env.example` para `.env`:

```powershell
bun run db:migrate
```

As migrations criam carteiras, transações, ledger, inbox, outbox e agendamento de
referências, com constraints e triggers. As verificações entre tabelas são adiadas
até o commit, permitindo gravar o conjunto
atomicamente. Para desfazer a última migration em um banco de desenvolvimento:

```powershell
bun run db:rollback
```

Testes de domínio e verificações de código não precisam do PostgreSQL:

```powershell
bun run test:unit
bun run typecheck
bun run build
bun run format:check
```

Para executar a integração com PostgreSQL e LocalStack do Compose:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://wagering:wagering_local@localhost:5433/postgres'
$env:TEST_SQS_ENDPOINT = 'http://localhost:4566'
bun run test:integration
```

A suíte exige permissão `CREATEDB`: cria um banco com nome aleatório
`wagering_test_...` e remove somente esse banco ao terminar. Não aplica migrations
ao banco informado na URL; usa essa conexão para administrar o banco temporário.
O comando explícito exige TEST_DATABASE_URL e TEST_SQS_ENDPOINT e falha se uma delas
estiver ausente. `bun test` pula integração sem TEST_DATABASE_URL e também pula a
suíte assíncrona sem TEST_SQS_ENDPOINT. Para uma verificação completa e reproduzível
no Linux, use `bun run test:containers`.

A suíte verifica regras unitárias, migrations up/down/up, constraints e API no
PostgreSQL 17 e LocalStack reais. Inclui 50 duplicatas paralelas, três processos Bun
independentes para HTTP e workers, reinício com replay, morte pós-commit/pré-ack,
disputa de saldo, retry/DLQ, publishers concorrentes e falhas injetadas.
Reconciliação é verificada nos cenários financeiros. A imagem Bun e a suíte Linux
também são executadas pelo Compose.

Última execução em Linux/Compose (12/11/2026): 169 testes passaram, sem falhas,
com PostgreSQL 17, LocalStack 4.0.3 e Bun 1.4.4.

Os eventos ficam em `outbox_messages` até o publisher confirmá-los no SQS.
Referências ausentes ficam em `PENDING_REFERENCE`; o worker as retoma com backoff
persistente e TTL de 24h. Reenviar a mesma operação retorna o estado persistido.

## Formatação

```powershell
bun run format
```

## Estrutura

- `src/domain/`: regras financeiras sem dependência de NestJS ou banco.
- `src/application/`: casos de uso e contratos com a persistência e identidade.
- `src/http/`: controllers, validação de entrada e tradução de erros para HTTP.
- `test/domain.test.ts`: testes unitários das regras financeiras.
- `src/infrastructure/database/`: mapeamentos separados do domínio, migration e repositório.
- `src/infrastructure/messaging/`: SDK SQS, validação do envelope e consumidor.
- `src/infrastructure/workers/`: publicação, referências e shutdown.
- `test/integration/database.test.ts`: verificações com PostgreSQL real.
- `test/integration/api.test.ts`: HTTP real, falhas e múltiplos processos.
- `test/integration/async.test.ts`: SQS real, crash recovery, retries e workers concorrentes.
- `src/main.ts`: cria o servidor e habilita encerramento por sinais.
- `src/app.module.ts`: módulo raiz, que reúne os módulos da aplicação.
- `src/health/health.module.ts`: registra o controller de health.
- `src/health/health.controller.ts`: transforma uma requisição HTTP em resposta.
- `compose.yaml`: serviços locais para desenvolvimento.
- `infra/localstack/init-sqs.sh`: criação das filas.

