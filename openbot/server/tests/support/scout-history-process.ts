/** Synthetic producer used only by the abrupt-process-loss integration test. */
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { createDatabase } from "../../src/db/client";
import { createHistoryEngine } from "../../src/scout/history/runner";
import { createHistoryStore } from "../../src/scout/history/store";

const body = JSON.parse(await Bun.stdin.text()) as {
  principal: { userId: string; tenantId: string };
  input: RunAgentInput;
};
const database = createDatabase(process.env.TEST_DATABASE_URL ?? "", {
  max: 3,
});
const store = createHistoryStore(database, { leaseMs: 800 });
const engine = createHistoryEngine(store, {
  heartbeatMs: 100,
  pollMs: 10,
  maxRunMs: 5000,
});
const bound = engine.bind({
  principal: async () => body.principal,
  authorize: async () => true,
});
class Producer extends AbstractAgent {
  constructor() {
    super({ agentId: "fixture" });
  }
  run(input: RunAgentInput) {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.next({
        type: EventType.CUSTOM,
        name: "fixture-model-dispatched",
        value: {},
      });
      subscriber.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "process-partial",
        role: "assistant",
      });
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "process-partial",
        delta: "Committed before process termination",
      });
      // Deliberately no terminal event. The parent terminates this actual process.
    });
  }
}
bound.runner
  .run({
    threadId: body.input.threadId,
    input: body.input,
    agent: new Producer(),
  })
  .subscribe({
    next(event) {
      if (event.type === EventType.TEXT_MESSAGE_CONTENT)
        process.stdout.write("ready\n");
    },
    error() {
      process.stderr.write("fixture-producer-error\n");
      process.exitCode = 1;
    },
  });
