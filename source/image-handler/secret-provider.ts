// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

/**
 * Class provides cached access to the Secret Manager.
 */
export class SecretProvider {
  private readonly cache: { secretId: string; secret: string } = {
    secretId: null,
    secret: null,
  };

  constructor(private readonly secretsManager: SecretsManagerClient) {}

  /**
   * Returns the secret associated with the secret ID.
   * Note: method caches the secret associated with `secretId` and makes a call to SecretManager
   * in case if the `secretId` changes, i.e. when SECRETS_MANAGER environment variable values changes.
   * @param secretId The secret ID.
   * @returns Secret associated with the secret ID.
   */
  async getSecret(secretId: string): Promise<string> {
    // BCP: bypass Secrets Manager when the key is supplied directly via env var.
    if (process.env.SIH_SECRET_KEY) {
      return process.env.SIH_SECRET_KEY;
    }
    if (this.cache.secretId === secretId && this.cache.secret) {
      return this.cache.secret;
    } else {
      const response = await this.secretsManager.send(new GetSecretValueCommand({ SecretId: secretId }));
      this.cache.secretId = secretId;
      this.cache.secret = response.SecretString;

      return this.cache.secret;
    }
  }
}
