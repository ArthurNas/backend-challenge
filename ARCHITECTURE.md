# Arquitetura e decisões

## Organização

Um projeto NestJS, com camadas de domínio, aplicação e infraestrutura. HTTP e SQS
chamam o mesmo caso de uso. Domínio sem decorators do NestJS ou ORM.
Instâncias independentes compartilham PostgreSQL e SQS. Nenhuma garantia depende
de memória local. Controllers adaptam HTTP; providers conectam dependências; módulos
agrupam funcionalidades. Workers executam os trabalhos em segundo plano.

## Dinheiro

Money imutável com decimal.js, contratos em string com exatamente duas casas
na saída. Não aceitar notação científica, valores negativos de entrada ou mais de
duas casas. Não arredondar silenciosamente entradas inválidas. Persistir em NUMERIC
com precisão e limite explícitos, validando escala antes de chegar ao banco, que pode
arredondar ao converter. Valores monetários nunca passam por Number().
BRL é a moeda dos exemplos; o modelo valida moedas distintas com a lista
ISO-4217 oferecida por Intl no runtime. Entradas e saídas exigem exatamente duas casas
decimais. Sem sinais, espaços ou zeros inteiros à esquerda (exceto zero).
Limite: NUMERIC(20,2), até 999999999999999999.99 em módulo. Decimal isolado com 40
dígitos de precisão; overflow é rejeitado antes de alterar a carteira. Negativos
existem como resultados internos de aritmética, nunca em Money.from de entradas.

Wallet.debit/credit retornam o ledger da movimentação. Nenhuma mutação ocorre se
uma validação falhar. Os casos de uso persistem o par atomicamente e criam
o ledger OPENING junto da abertura positiva. As classes não fazem I/O nem garantem
concorrência distribuída; os adapters PostgreSQL aplicam os locks e constraints.

## Persistência e concorrência

MikroORM 6.6 é a escolha por permitir uma unidade de trabalho explícita e
transações com locks. Mapeamentos de persistência separados do domínio.
Cada processamento usa EntityManager isolado e transação SQL com lock de linha
da wallet (SELECT FOR UPDATE). Carteiras diferentes não compartilham lock.
Ordem de aquisição de locks consistente; deadlocks ou falhas transitórias permitem
retry limitado da transação inteira. Nenhuma chamada SQS dentro da transação financeira.

Saldo, transação, ledger, inbox quando aplicável e outbox são gravados no mesmo commit
SQL. DecimalType em modo string e WalletMapper preservam
Money sem conversão para number. Records do ORM ficam separados das classes do domínio.

O schema já protege unicidades, saldo não negativo, NaN e imutabilidade do ledger
(UPDATE, DELETE e TRUNCATE). Transações terminais são imutáveis; exclusão de transações
é proibida. Triggers de constraint adiadas ao commit validam saldo contra a soma do
ledger, versão, cadeia dos saldos e correspondência entre transação e lançamento.
wallet_version no record do ledger ordena a cadeia sem depender de timestamps.
Inserção no ledger também bloqueia a linha da carteira; nenhum lock é global.

A quarta migration protege a identidade da carteira mesmo antes de existir ledger,
o conteúdo e o histórico da outbox e a transição de PENDING_REFERENCE. Uma referência
interna exige a referência externa correspondente. Essas proteções também valem para
escritas SQL que não passam pela aplicação.

Trade-off: somar o ledger no commit custa O(n) por carteira e pode ser caro em
carteiras com histórico grande. É uma proteção explícita de integridade para esta
primeira versão. Não há promessa de throughput; antes de otimizar, medir e preservar
as mesmas garantias com testes de concorrência e SQL direto.

Os testes HTTP incluem rejeição persistida, 50 duplicatas, carteiras distintas e
três processos independentes compartilhando o banco, seguidos de reinício e replay.
Timeout de lock: 5s; até três tentativas para unicidade concorrente, deadlock,
serialização e lock timeout. Só erros que asseguram rollback são repetidos internamente.
Uma falha de conexão com resultado de commit incerto retorna 503; o cliente reenvia
com a mesma chave. Não há publicação SQS dentro da transação financeira.
Criação inicia version=1 mesmo com OPENING; só movimentações posteriores que mudarem
saldo incrementam version. LOSS e operações de valor zero não incrementam version.

## Idempotência

Header HTTP obrigatório; na fila, data.idempotencyKey. Chave globalmente única,
recomendando providerId:externalTransactionId. Unicidade adicional por
(providerId, externalTransactionId) impede repetir efeitos com uma chave diferente.
Payload canônico: objeto explícito de campos de negócio, objetos com chaves ordenadas,
dinheiro normalizado, referência ausente omitida; SHA-256 sobre JSON UTF-8.
Chaves e metadados de transporte ficam fora do hash. Mesma identidade e payload
divergente geram conflito. Replays de terminais recuperam o resultado persistido,
inclusive o saldo histórico; operações pendentes retornam o estado persistido atual.
Chave alternativa para a mesma identidade externa retorna conflito, coberto por HTTP.
Uma consulta antes do lock evita trabalho em replays; a consulta é repetida após o
lock. A constraint de unicidade cobre colisões simultâneas entre carteiras diferentes.

A segunda migration permite registrar REJECTED com jogador/moeda divergentes do
alvo, preservando o payload financeiro auditável. Operações PROCESSED continuam
obrigadas por trigger a corresponder à identidade da wallet; ledger tem FK de moeda.
O down restaura a FK antiga como NOT VALID para preservar rejeições já existentes,
mas aplica a restrição a novas escritas. Rollback é um comando de desenvolvimento:
também remove a tabela da outbox adicionada por essa migration.

## Modelagem

Entidades próximas dos esqueletos do enunciado: construtores privados, campos
explícitos, factories e transições nomeadas. Datas usam cópias defensivas nos getters
para não expor estado mutável.

## Regras adicionais adotadas

- BET, WIN, REFUND e ROLLBACK exigem valor positivo. LOSS aceita apenas zero.
  Abertura zero é permitida, sem OPENING ou ledger.
- REFUND e ROLLBACK exigem referência; WIN pode ter referência a BET da mesma rodada.
  Se fornecida, ela é validada, inclusive quando chegar fora de ordem.
- Referência ainda não terminal aguarda; referência rejeitada ou FAILED provoca
  rejeição explícita. Referência terminal válida precisa estar PROCESSED.
- Unicidade de reversão por (referência, tipo), conforme enunciado. REFUND e ROLLBACK
  distintos podem atingir a mesma BET uma vez cada; essa interpretação literal é
  mantida pela validação e pelo índice parcial no banco.
- PROCESSED, REJECTED e FAILED não admitem novas transições. PENDING pode passar a
  PENDING_REFERENCE ou terminal. PENDING_REFERENCE pode permanecer aguardando ou
  passar a terminal; tentativas são metadados persistidos, não reabertura de terminal.
- Reconciliação usa snapshot consistente do saldo e ledger, sem corrigir divergência.
  REPEATABLE READ mantém as duas consultas no mesmo snapshot; divergências geram
  log, métrica e resposta consistente=false. Diferença = storedBalance - calculatedBalance.

## Mensageria e recuperação

Entrada: wager-transactions.fifo; DLQ: wager-transactions-dlq.fifo.
Saída: wager-events.fifo, separada para não realimentar o consumidor de comandos.
GroupId por wallet; deduplicação FIFO é apenas otimização. Inbox por
(consumerName, messageId), verificando SHA-256 do JSON canônico do envelope inteiro
(chaves ordenadas, incluindo chave de idempotência e metadados) em colisões.
Reutilizar um messageId com envelope alterado é conflito e segue para DLQ.
O hash de negócio continua separado e normaliza Money. Ack somente após commit.
Redrive após cinco recebimentos; falhas transitórias não viram rejeição de negócio.
Falhas permanentes de mensagem seguem para DLQ; FAILED fica reservado a operações
identificadas e persistidas que não podem ser concluídas por erro permanente técnico.

Outbox possui envelope versionado, eventId persistido e backoff no domínio.
Publisher usa SKIP LOCKED e claim_token com lease de 120s, persistidos no banco.
Publicação fora da transação financeira; lease expirado permite retomada.
Morte entre publicação e marcação pode duplicar evento: consumidores devem deduplicar.
O eventId identifica a entrega lógica; walletVersion permite detectar snapshots antigos.
Publishers concorrentes não prometem ordem total de publicação por ordem de commit.
O conteúdo da outbox não pode ser alterado ou excluído; metadados de entrega continuam
atualizáveis. O banco calcula os horários de publicação e de próxima tentativa.
O objeto em memória só muda para publicado após a confirmação do UPDATE SQL.
Referências pendentes: worker agendado, metadados persistentes, backoff exponencial
inicial de 1s limitado a 5min e TTL de 24h; esgotamento rejeita com evento.
Shutdown interrompe recebimentos novos e aguarda até 25s por trabalho em andamento,
com mais até 5s para devolver visibilidade. O long poll já enviado termina para
que seu receipt seja conhecido, evitando abandonar uma entrega ao abortar a conexão.
Morte forçada depende de visibilidade (60s), com heartbeat de 20s no processamento.

O agendamento vive em pending_references, separado dos campos imutáveis do pedido.
A migration agenda pendências preexistentes. Cada retomada bloqueia a wallet antes
de reler o status; schedulers concorrentes não reaplicam terminais. Infraestrutura
indisponível não incrementa tentativas se o SQL fizer rollback: o registro continua
durável para a próxima tentativa. O TTL continua decorrendo e usa o relógio do
PostgreSQL, não de cada processo.

Mensagens inválidas são auditáveis na DLQ. Se uma falha técnica impede a própria
persistência, não se força um registro FAILED fictício; o envelope original e o
FailureCode da DLQ permitem investigar e decidir a recuperação. FAILED continua
modelado como estado terminal para falhas permanentes persistíveis.

## Contratos e falhas

HTTP implementado: 400 payload inválido; 404 recurso ausente; 409 conflito de identidade,
idempotência ou carteira duplicada; 422 rejeição de negócio; 202 pendente; 503
infraestrutura temporariamente indisponível. Sucesso de processamento: 200, criação: 201.
Códigos de rejeição implementados: INSUFFICIENT_FUNDS, REVERSAL_INSUFFICIENT_FUNDS,
CURRENCY_MISMATCH, WALLET_PLAYER_MISMATCH, REFERENCE_MISMATCH, INVALID_REFERENCE_KIND,
REFERENCE_NOT_PROCESSED, INVALID_AMOUNT, ALREADY_REVERSED, MONEY_OUT_OF_RANGE.
REFERENCE_NOT_FOUND_EXPIRED é usado pelo worker de referências pendentes.
Contratos e roteiro em docs/API.md.

## Autenticação e observabilidade

Autenticação externa adiada, conforme seção 2 do desafio. ProviderIdentityPort está
implementado com adapter de desenvolvimento permissivo, preparado para IdP externo.
Health público. Canal SQS interno confiável, mas identidade do domínio sempre validada.
Sem tabela de senhas. Execução inicial destinada ao desenvolvimento local.

Evolução prevista: integrar um IdP OIDC externo, com guard verificando assinatura via
JWKS, issuer e audience do JWT. O contexto autenticado deve vincular o provedor ao
providerId do pedido; criação de carteira exige permissão própria. Health permanece
público. O consumidor SQS mantém a validação da identidade do domínio pelo port,
mesmo usando um canal interno. Este desenho ainda não é autenticação implementada.
Processamentos geram logs JSON com correlationId, transactionId, walletId, providerId,
status e indicador de replay; messageId é nulo no HTTP. Sem valores monetários nos logs.
/metrics expõe contadores de status/transições, duplicatas, retries, conflitos de lock,
divergências e soma/contagem da latência, além de outbox lag e profundidade da DLQ.
Métricas são por processo, sem papel em idempotência. Workers têm HTTP próprio (3001).
Contadores começam em zero; gauges de dependências são omitidos quando a consulta
falha, evitando expor uma leitura antiga como atual.
Liveness apenas indica processo vivo. Readiness consulta o schema migrado PostgreSQL
e as três filas SQS; falha em qualquer dependência resulta em 503.
Também exige a última migration conhecida pela aplicação.

Execução nativa, Compose com três workers e teste Linux estão descritos em docs/ASYNC.md.
Os testes antecipam leases/TTL apenas nos bancos descartáveis. LocalStack é um
emulador; a durabilidade de um broker AWS gerenciado não é inferida de remover
containers ou filas locais. O volume PostgreSQL preserva os dados financeiros.

## Referências

- https://docs.nestjs.com/first-steps
- https://mikro-orm.io/docs/quick-start
- https://mikro-orm.io/docs/migrations
- https://bun.com/docs/installation
- https://mikemcl.github.io/decimal.js/
- https://docs.nestjs.com/exception-filters
- https://docs.nestjs.com/fundamentals/custom-providers
- https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html
- https://docs.localstack.cloud/aws/services/sqs/
