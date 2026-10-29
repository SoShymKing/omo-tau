import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
let held;
input.on('line', line => {
  let command = JSON.parse(line);
  if (command.message === 'compact') {
    held = command;
    process.stderr.write('QA_COMPACTING\n');
    return;
  }
  if (command.type === 'qa_release') command = held;
  if (command.message === 'exit') {
    process.exit(0);
  }
  process.stdout.write('{native extension diagnostic}\n');
  // A large native event is not another Tau event or part of its RPC response.
  process.stdout.write('{"type":"message_update","data":"');
  process.stdout.write('x'.repeat(2 * 1024 * 1024));
  process.stdout.write('"}\n');
  if (command.message === 'nested-first') {
    process.stdout.write(JSON.stringify({
      data: { type: 'nested-prompt' }, type: 'response', id: command.id, success: true,
    }) + '\n', () => process.exit(0));
    return;
  }
  const response = JSON.stringify({ type: 'response', id: command.id, command: command.type,
    success: command.message !== 'reject', data: command });
  const split = response.indexOf('"response"') + 4;
  process.stdout.write(response.slice(0, split));
  process.stdout.write(response.slice(split) + '\n');
});
