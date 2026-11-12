import { object } from '../src/application/input-validation';
import { parseWagerMessage } from '../src/infrastructure/messaging/parse-wager-message';
import { SqsGateway } from '../src/infrastructure/messaging/sqs-gateway';
import { sqsConfig } from '../src/infrastructure/messaging/sqs.config';

const file = process.argv[2];

if (!file) throw new Error('Usage: bun run queue:send path/to/message.json');

const payload = object(await Bun.file(file).json());

const parsed = parseWagerMessage(JSON.stringify(payload));

const gateway = new SqsGateway(sqsConfig());

try {
  await gateway.request(payload, parsed.command.walletId, parsed.delivery.messageId);
  console.log(JSON.stringify({ accepted: true, messageId: parsed.delivery.messageId }));
} finally {
  gateway.close();
}
