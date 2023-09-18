// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as path from "path";
import { LambdaRestApiProps, RestApi } from "aws-cdk-lib/aws-apigateway";
import {
  AllowedMethods,
  CacheHeaderBehavior,
  CachePolicy,
  CacheQueryStringBehavior,
  DistributionProps,
  IOrigin,
  OriginRequestPolicy,
  OriginSslPolicy,
  PriceClass,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Policy, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { ArnFormat, Aws, Duration, Lazy, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import { CloudFrontToApiGatewayToLambda } from "@aws-solutions-constructs/aws-cloudfront-apigateway-lambda";

import { addCfnSuppressRules } from "../../utils/utils";
import { SolutionConstructProps } from "../types";

export interface BackEndProps extends SolutionConstructProps {
  readonly solutionVersion: string;
  readonly solutionName: string;
  readonly secretsManagerPolicy: Policy;
  readonly logsBucket: IBucket;
  readonly uuid: string;
  readonly cloudFrontPriceClass: string;
}

export class BackEnd extends Construct {
  public domainName: string;

  constructor(scope: Construct, id: string, props: BackEndProps) {
    super(scope, id);

    const imageHandlerLambdaFunctionRole = new Role(this, "ImageHandlerFunctionRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      path: "/",
    });
    props.secretsManagerPolicy.attachToRole(imageHandlerLambdaFunctionRole);

    const imageHandlerLambdaFunctionRolePolicy = new Policy(this, "ImageHandlerFunctionPolicy", {
      statements: [
        new PolicyStatement({
          actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
          resources: [
            Stack.of(this).formatArn({
              service: "logs",
              resource: "log-group",
              resourceName: "/aws/lambda/*",
              arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            }),
          ],
        }),
        new PolicyStatement({
          actions: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
          resources: [
            Stack.of(this).formatArn({
              service: "s3",
              resource: "*",
              region: "",
              account: "",
            }),
          ],
        }),
        new PolicyStatement({
          actions: ["rekognition:DetectFaces", "rekognition:DetectModerationLabels"],
          resources: ["*"],
        }),
      ],
    });

    addCfnSuppressRules(imageHandlerLambdaFunctionRolePolicy, [
      { id: "W12", reason: "rekognition:DetectFaces requires '*' resources." },
    ]);
    imageHandlerLambdaFunctionRole.attachInlinePolicy(imageHandlerLambdaFunctionRolePolicy);

    const imageHandlerLambdaFunction = new NodejsFunction(this, "ImageHandlerLambdaFunction", {
      description: `${props.solutionName} (${props.solutionVersion}): Performs image edits and manipulations`,
      memorySize: 1024,
      runtime: Runtime.NODEJS_16_X,
      timeout: Duration.minutes(15),
      role: imageHandlerLambdaFunctionRole,
      entry: path.join(__dirname, "../../../image-handler/index.ts"),
      environment: {
        AUTO_WEBP: props.autoWebP,
        CORS_ENABLED: props.corsEnabled,
        CORS_ORIGIN: props.corsOrigin,
        SOURCE_BUCKETS: props.sourceBuckets,
        REWRITE_MATCH_PATTERN: "",
        REWRITE_SUBSTITUTION: "",
        ENABLE_SIGNATURE: props.enableSignature,
        SECRETS_MANAGER: props.secretsManager,
        SECRET_KEY: props.secretsManagerKey,
        ENABLE_DEFAULT_FALLBACK_IMAGE: props.enableDefaultFallbackImage,
        DEFAULT_FALLBACK_IMAGE_BUCKET: props.fallbackImageS3Bucket,
        DEFAULT_FALLBACK_IMAGE_KEY: props.fallbackImageS3KeyBucket,
      },
      bundling: {
        externalModules: ["sharp"],
        nodeModules: ["sharp"],
        commandHooks: {
          beforeBundling(inputDir: string, outputDir: string): string[] {
            return [];
          },
          beforeInstall(inputDir: string, outputDir: string): string[] {
            return [];
          },
          afterBundling(inputDir: string, outputDir: string): string[] {
            return [`cd ${outputDir}`, "npx rimraf node_modules/sharp && npm install --arch=x64 --platform=linux sharp"];
          },
        },
      },
    });

    const imageHandlerLogGroup = new LogGroup(this, "ImageHandlerLogGroup", {
      logGroupName: `/aws/lambda/${imageHandlerLambdaFunction.functionName}`,
      retention: props.logRetentionPeriod as RetentionDays,
    });

    addCfnSuppressRules(imageHandlerLogGroup, [
      {
        id: "W84",
        reason: "CloudWatch log group is always encrypted by default.",
      },
    ]);

    const cachePolicy = new CachePolicy(this, "CachePolicy", {
      cachePolicyName: `ServerlessImageHandler-${props.uuid}`,
      defaultTtl: Duration.days(1),
      minTtl: Duration.seconds(1),
      maxTtl: Duration.days(365),
      enableAcceptEncodingGzip: true,
      headerBehavior: CacheHeaderBehavior.allowList("origin", "accept"),
      queryStringBehavior: CacheQueryStringBehavior.allowList("signature"),
    });

    const originRequestPolicy = new OriginRequestPolicy(this, "OriginRequestPolicy", {
      originRequestPolicyName: `ServerlessImageHandler-${props.uuid}`,
      headerBehavior: CacheHeaderBehavior.allowList("origin", "accept"),
      queryStringBehavior: CacheQueryStringBehavior.allowList("signature"),
    });

    const apiGatewayRestApi = RestApi.fromRestApiId(
      this,
      "ApiGatewayRestApi",
      Lazy.string({
        produce: () => imageHandlerCloudFrontApiGatewayLambda.apiGateway.restApiId,
      })
    );

    const origin: IOrigin = new HttpOrigin(`${apiGatewayRestApi.restApiId}.execute-api.${Aws.REGION}.amazonaws.com`, {
      originPath: "/image",
      originSslProtocols: [OriginSslPolicy.TLS_V1_1, OriginSslPolicy.TLS_V1_2],
    });

    const cloudFrontDistributionProps: DistributionProps = {
      comment: "Image Handler Distribution for Serverless Image Handler",
      defaultBehavior: {
        origin,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
        originRequestPolicy,
        cachePolicy,
      },
      priceClass: props.cloudFrontPriceClass as PriceClass,
      enableLogging: true,
      logBucket: props.logsBucket,
      logFilePrefix: "api-cloudfront/",
      errorResponses: [
        { httpStatus: 500, ttl: Duration.minutes(10) },
        { httpStatus: 501, ttl: Duration.minutes(10) },
        { httpStatus: 502, ttl: Duration.minutes(10) },
        { httpStatus: 503, ttl: Duration.minutes(10) },
        { httpStatus: 504, ttl: Duration.minutes(10) },
      ],
    };

    const logGroupProps = {
      retention: props.logRetentionPeriod as RetentionDays,
    };

    const apiGatewayProps: LambdaRestApiProps = {
      handler: imageHandlerLambdaFunction,
      deployOptions: {
        stageName: "image",
      },
      binaryMediaTypes: ["*/*"],
    };

    const imageHandlerCloudFrontApiGatewayLambda = new CloudFrontToApiGatewayToLambda(
      this,
      "ImageHandlerCloudFrontApiGatewayLambda",
      {
        existingLambdaObj: imageHandlerLambdaFunction,
        insertHttpSecurityHeaders: false,
        logGroupProps,
        cloudFrontDistributionProps,
        apiGatewayProps,
      }
    );

    imageHandlerCloudFrontApiGatewayLambda.apiGateway.node.tryRemoveChild("Endpoint"); // we don't need the RestApi endpoint in the outputs

    this.domainName = imageHandlerCloudFrontApiGatewayLambda.cloudFrontWebDistribution.distributionDomainName;
  }
}
