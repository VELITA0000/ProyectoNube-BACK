import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SNSClient } from "@aws-sdk/client-sns";
import {
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { getEnv } from "../config/env.js";

function awsClientConfig() {
  const env = getEnv();
  // Static credentials are used for local dev / AWS Academy sessions; on Lambda
  // the three vars are left empty and the SDK falls back to the runtime
  // credential chain (LabRole).
  const credentials =
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          sessionToken: env.AWS_SESSION_TOKEN,
        }
      : undefined;
  return {
    region: env.AWS_REGION,
    credentials,
  };
}

let s3: S3Client | null = null;
let sqs: SQSClient | null = null;
let sns: SNSClient | null = null;
let cognito: CognitoIdentityProviderClient | null = null;

export function getS3(): S3Client {
  s3 ??= new S3Client(awsClientConfig());
  return s3;
}

export function getSqs(): SQSClient {
  sqs ??= new SQSClient(awsClientConfig());
  return sqs;
}

export function getSns(): SNSClient {
  sns ??= new SNSClient(awsClientConfig());
  return sns;
}

export function getCognito(): CognitoIdentityProviderClient {
  cognito ??= new CognitoIdentityProviderClient(awsClientConfig());
  return cognito;
}
