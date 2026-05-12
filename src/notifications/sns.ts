import { PublishCommand } from "@aws-sdk/client-sns";
import { getEnv } from "../config/env.js";
import { getSns } from "../aws/clients.js";

type TransactionEvent =
  | "purchase.succeeded"
  | "purchase.failed"
  | "session.published";

export interface TransactionNotification {
  event: TransactionEvent;
  clientId?: string;
  clientEmail?: string;
  clientName?: string;
  sessionId?: string;
  sessionTitle?: string;
  sessionUrl?: string;
  purchaseIds?: string[];
  totalUsd?: number;
  paymentIntentId?: string;
  message?: string;
  metadata?: Record<string, string | number | boolean | undefined>;
}

const SUBJECTS: Record<TransactionEvent, string> = {
  "purchase.succeeded": "[photo-app] Purchase succeeded",
  "purchase.failed": "[photo-app] Purchase failed",
  "session.published": "[photo-app] Session published",
};

// Best-effort publish to SNS. We never fail the caller if SNS is unset or down:
// transactional notifications are observability, not part of the business flow.
export async function publishTransactionNotification(
  payload: TransactionNotification,
): Promise<boolean> {
  const env = getEnv();
  const topic = env.SNS_TRANSACTIONS_TOPIC_ARN.trim();
  if (!topic) return false;

  try {
    await getSns().send(
      new PublishCommand({
        TopicArn: topic,
        Subject: SUBJECTS[payload.event],
        Message: JSON.stringify(payload, null, 2),
        MessageAttributes: {
          event: { DataType: "String", StringValue: payload.event },
        },
      }),
    );
    return true;
  } catch (err) {
    console.error("SNS publishTransactionNotification error", err);
    return false;
  }
}
