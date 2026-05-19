// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// BCP entry point: runs the image handler as a long-lived Fastify HTTP server
// instead of a Lambda function. Behaviour is otherwise identical to index.ts.

import Fastify from "fastify";
import { RekognitionClient } from "@aws-sdk/client-rekognition";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ImageHandler } from "./image-handler";
import { ImageRequest } from "./image-request";
import { SecretProvider } from "./secret-provider";
import { ImageHandlerEvent, StatusCodes } from "./lib";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";

// When AWS_ENDPOINT_URL_S3 is set (e.g. pointing at MinIO), enable path-style
// addressing which MinIO requires. Production S3 uses virtual-hosted style.
const s3Client = new S3Client({
  region: AWS_REGION,
  ...(process.env.AWS_ENDPOINT_URL_S3 ? { forcePathStyle: true } : {}),
});

const rekognitionClient = new RekognitionClient({ region: AWS_REGION });
const secretsManagerClient = new SecretsManagerClient({ region: AWS_REGION });
const secretProvider = new SecretProvider(secretsManagerClient);

const imageRequest = new ImageRequest(s3Client, secretProvider);
const imageHandler = new ImageHandler(s3Client, rekognitionClient);

const app = Fastify({ logger: true });

app.get<{ Params: { "*": string } }>("/*", async (request, reply) => {
  const path = `/${request.params["*"]}`;

  const event: ImageHandlerEvent = {
    path,
    queryStringParameters: (request.query as Record<string, string>) ?? {},
    headers: request.headers as Record<string, string>,
    requestContext: {},
  };

  try {
    const imageRequestInfo = await imageRequest.setup(event);
    const processed = await imageHandler.process(imageRequestInfo);

    let headers: Record<string, string> = {
      "Cache-Control": imageRequestInfo.cacheControl,
    };
    if (imageRequestInfo.headers) {
      headers = { ...headers, ...imageRequestInfo.headers };
    }
    if (imageRequestInfo.secondsToExpiry !== undefined) {
      headers["Cache-Control"] = `max-age=${imageRequestInfo.secondsToExpiry},public`;
    }
    headers["Content-Type"] = imageRequestInfo.contentType;
    if (imageRequestInfo.expires) headers["Expires"] = imageRequestInfo.expires;
    if (imageRequestInfo.lastModified) headers["Last-Modified"] = imageRequestInfo.lastModified;

    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) reply.header(key, value);
    }

    return reply.status(StatusCodes.OK).send(processed);
  } catch (error) {
    const statusCode = error?.status ?? StatusCodes.INTERNAL_SERVER_ERROR;
    const body = error?.status
      ? JSON.stringify(error)
      : JSON.stringify({ message: "Internal error. Please contact the system administrator.", code: "InternalError", status: StatusCodes.INTERNAL_SERVER_ERROR });

    return reply.status(statusCode).header("Content-Type", "application/json").send(body);
  }
});

const shutdown = () => app.close().then(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

app.listen({ port: PORT, host: "0.0.0.0" }).catch((err) => {
  console.error(err);
  process.exit(1);
});
