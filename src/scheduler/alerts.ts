import { getInvocationsByTask, getTask } from "../db/queries.js";
import type { SchedulerDeps } from "./index.js";
import { createLogger } from "../logger.js";

const logger = createLogger("alerts");
const log = (...args: unknown[]) => logger.info(...args);

export function sendPermanentFailureAlert(
  deps: SchedulerDeps,
  taskId: string,
  reason: string,
): void {
  const { db, config, client } = deps;
  const task = getTask(db, taskId);
  const invocations = getInvocationsByTask(db, taskId);
  const invocationIds = invocations.map((inv) => inv.id).join(", ") || "none";
  const retryCount = task?.retryCount ?? 0;
  const maxRetries = config.maxRetries;

  // Rich Linear comment with failure context
  const comment = [
    `**Task permanently failed**`,
    ``,
    `**Reason:** ${reason}`,
    `**Retry count:** ${retryCount}/${maxRetries}`,
    `**Invocations:** ${invocationIds}`,
  ].join("\n");

  client.createComment(taskId, comment).catch((err) => {
    log(`comment failed for task ${taskId}: ${err}`);
  });

  // Optional webhook notification
  if (config.alertWebhookUrl) {
    const payload = {
      text: `Orca: task ${taskId} permanently failed`,
      attachments: [
        {
          color: "danger",
          title: "Permanent Task Failure",
          fields: [
            { title: "Task ID", value: taskId, short: true },
            {
              title: "Retry count",
              value: `${retryCount}/${maxRetries}`,
              short: true,
            },
            { title: "Reason", value: reason, short: false },
            { title: "Invocations", value: invocationIds, short: false },
          ],
        },
      ],
    };

    fetch(config.alertWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((res) => {
        if (!res.ok) {
          log(`webhook returned ${res.status} for task ${taskId}`);
        }
      })
      .catch((err) => {
        log(`webhook failed for task ${taskId}: ${err}`);
      });
  }
}
