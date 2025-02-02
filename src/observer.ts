/**
 * AR.IO Observer
 * Copyright (C) 2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import { Timings } from '@szmarczak/http-timer';
import got, { RequestError } from 'got';
import crypto from 'node:crypto';
import pMap from 'p-map';

import {
  ArnsNameAssessment,
  ArnsNameAssessments,
  ArnsNamesSource,
  EpochHeightSource,
  GatewayAssessments,
  GatewayHostsSource,
  ObserverReport,
  OwnershipAssessment,
} from './types.js';

const REPORT_FORMAT_VERSION = 1;

const NAME_PASS_THRESHOLD = 0.8;

interface ArnsResolution {
  statusCode: number;
  resolvedId: string | null;
  ttlSeconds: string | null;
  contentLength: string | null;
  contentType: string | null;
  dataHashDigest: string | null;
  timings: Timings | null;
}

// TODO consider moving this into a resolver class
export function getArnsResolution({
  host,
  arnsName,
}: {
  host: string;
  arnsName: string;
}): Promise<ArnsResolution> {
  const url = `https://${arnsName}.${host}/`;
  const stream = got.stream.get(url, {
    timeout: {
      lookup: 5000,
      connect: 2000,
      secureConnect: 2000,
      socket: 1000,
    },
  });
  const dataHash = crypto.createHash('sha256');

  let streamBytesProcessed = 0;
  const MAX_BYTES_TO_PROCESS = 1048576; // 1MiB

  return new Promise<ArnsResolution>((resolve, reject) => {
    let response: any;

    const resolveWithResponse = (response: any) =>
      resolve({
        statusCode: response.statusCode,
        resolvedId: response.headers['x-arns-resolved-id'] ?? null,
        ttlSeconds: response.headers['x-arns-ttl-seconds'],
        contentType: response.headers['content-type'],
        contentLength: response.headers['content-length'],
        dataHashDigest: dataHash.digest('base64url'),
        timings: response.timings,
      });

    const resolveWith404 = () =>
      resolve({
        statusCode: 404,
        resolvedId: null,
        ttlSeconds: null,
        contentType: null,
        contentLength: null,
        dataHashDigest: null,
        timings: null,
      });

    stream.on('error', (error: RequestError) => {
      if ((error as any)?.response?.statusCode === 404) {
        resolveWith404();
      } else {
        reject(error);
      }
    });

    stream.on('response', (resp) => {
      response = resp;
    });

    stream.on('data', (data) => {
      const bytesToProcess = Math.min(
        data.length,
        MAX_BYTES_TO_PROCESS - streamBytesProcessed,
      );

      if (bytesToProcess > 0) {
        dataHash.update(data.slice(0, bytesToProcess));
        streamBytesProcessed += bytesToProcess;
      }

      if (streamBytesProcessed >= MAX_BYTES_TO_PROCESS) {
        stream.on('close', () => {
          resolveWithResponse(response);
        });

        stream.destroy();
      }
    });

    stream.on('end', () => {
      resolveWithResponse(response);
    });
  });
}

async function assessOwnership({
  host,
  expectedWallets,
}: {
  host: string;
  expectedWallets: string[];
}): Promise<OwnershipAssessment> {
  try {
    const url = `https://${host}/ar-io/info`;
    const resp = await got
      .get(url, {
        timeout: {
          lookup: 5000,
          connect: 2000,
          secureConnect: 2000,
          socket: 1000,
        },
      })
      .json<any>();
    if (resp?.wallet) {
      if (!expectedWallets.includes(resp.wallet)) {
        return {
          expectedWallets,
          observedWallet: null,
          failureReason: `Wallet mismatch: expected one of ${expectedWallets.join(
            ', ',
          )} but found ${resp.wallet}`,
          pass: false,
        };
      } else {
        return {
          expectedWallets,
          observedWallet: resp.wallet,
          pass: true,
        };
      }
    }
    return {
      expectedWallets,
      observedWallet: null,
      failureReason: `No wallet found`,
      pass: false,
    };
  } catch (error: any) {
    return {
      expectedWallets,
      observedWallet: null,
      failureReason: error?.message as string,
      pass: false,
    };
  }
}

export class Observer {
  private observerAddress: string;
  private referenceGatewayHost: string;
  private epochHeightSource: EpochHeightSource;
  private observedGatewayHostList: GatewayHostsSource;
  private prescribedNamesSource: ArnsNamesSource;
  private chosenNamesSource: ArnsNamesSource;
  private gatewayAsessementConcurrency: number;
  private nameAssessmentConcurrency: number;

  constructor({
    observerAddress,
    prescribedNamesSource,
    epochHeightSource,
    chosenNamesSource,
    referenceGatewayHost,
    observedGatewayHostList,
    gatewayAssessmentConcurrency,
    nameAssessmentConcurrency,
  }: {
    observerAddress: string;
    referenceGatewayHost: string;
    epochHeightSource: EpochHeightSource;
    observedGatewayHostList: GatewayHostsSource;
    prescribedNamesSource: ArnsNamesSource;
    chosenNamesSource: ArnsNamesSource;
    gatewayAssessmentConcurrency: number;
    nameAssessmentConcurrency: number;
  }) {
    this.observerAddress = observerAddress;
    this.referenceGatewayHost = referenceGatewayHost;
    this.epochHeightSource = epochHeightSource;
    this.observedGatewayHostList = observedGatewayHostList;
    this.prescribedNamesSource = prescribedNamesSource;
    this.chosenNamesSource = chosenNamesSource;
    this.gatewayAsessementConcurrency = gatewayAssessmentConcurrency;
    this.nameAssessmentConcurrency = nameAssessmentConcurrency;
  }

  async assessArnsName({
    host,
    arnsName,
  }: {
    host: string;
    arnsName: string;
  }): Promise<ArnsNameAssessment> {
    // TODO handle exceptions
    const referenceResolution = await getArnsResolution({
      host: this.referenceGatewayHost,
      arnsName,
    });

    const gatewayResolution = await getArnsResolution({
      host,
      arnsName,
    });

    let pass = true;
    let failureReason: string | undefined = undefined;

    const checkedProperties: Array<keyof ArnsResolution> = [
      'resolvedId',
      'ttlSeconds',
      'contentType',
      'dataHashDigest',
    ];
    for (const property of checkedProperties) {
      if (referenceResolution[property] !== gatewayResolution[property]) {
        pass = false;
        failureReason =
          (failureReason !== undefined ? failureReason + ', ' : '') +
          `${property} mismatch`;
      }
    }

    return {
      assessedAt: +(Date.now() / 1000).toFixed(0),
      expectedStatusCode: referenceResolution.statusCode,
      resolvedStatusCode: gatewayResolution.statusCode,
      expectedId: referenceResolution.resolvedId ?? null,
      resolvedId: gatewayResolution.resolvedId ?? null,
      expectedDataHash: referenceResolution.dataHashDigest ?? null,
      resolvedDataHash: gatewayResolution.dataHashDigest ?? null,
      failureReason,
      pass,
      timings: gatewayResolution?.timings?.phases,
    };
  }

  // TODO add port
  async assessArnsNames({
    host,
    names,
  }: {
    host: string;
    names: string[];
  }): Promise<ArnsNameAssessments> {
    return pMap(
      names,
      async (name) => {
        try {
          return await this.assessArnsName({
            host,
            arnsName: name,
          });
        } catch (err) {
          const errorMessage =
            typeof err === 'object' &&
            err !== null &&
            'message' in err &&
            typeof err.message === 'string'
              ? err.message
              : undefined;
          return {
            assessedAt: +(Date.now() / 1000).toFixed(0),
            expectedId: null,
            resolvedId: null,
            expectedDataHash: null,
            resolvedDataHash: null,
            failureReason: errorMessage?.slice(0, 512),
            pass: false,
          };
        }
      },
      { concurrency: this.nameAssessmentConcurrency },
    ).then((results) => {
      return results.reduce((assessments, assessment, index) => {
        assessments[names[index]] = assessment;
        return assessments;
      }, {} as ArnsNameAssessments);
    });
  }

  async generateReport(): Promise<ObserverReport> {
    const epochStartHeight = await this.epochHeightSource.getEpochStartHeight();
    const epochEndHeight = await this.epochHeightSource.getEpochEndHeight();
    const prescribedNames = await this.prescribedNamesSource.getNames({
      height: epochStartHeight,
    });
    const chosenNames = await this.chosenNamesSource.getNames({
      height: epochStartHeight,
    });

    // Assess gateway
    const gatewayAssessments: GatewayAssessments = {};
    const gatewayHosts = await this.observedGatewayHostList.getHosts();

    // Create map of FQDN => hosts to handle duplicates
    const hostWallets: { [key: string]: string[] } = {};
    gatewayHosts.forEach((host) => {
      (hostWallets[host.fqdn] ||= []).push(host.wallet);
    });

    await pMap(
      gatewayHosts,
      async (host) => {
        const ownershipAssessment = await assessOwnership({
          host: host.fqdn,
          expectedWallets: hostWallets[host.fqdn].sort(),
        });

        const [prescribedAssessments, chosenAssessments] = await Promise.all([
          await this.assessArnsNames({
            host: host.fqdn,
            names: prescribedNames,
          }),
          await this.assessArnsNames({
            host: host.fqdn,
            names: chosenNames,
          }),
        ]);

        const nameCount = new Set([...prescribedNames, ...chosenNames]).size;
        const namePassCount = Object.values({
          ...prescribedAssessments,
          ...chosenAssessments,
        }).reduce(
          (count, assessment) => (assessment.pass ? count + 1 : count),
          0,
        );
        const namesPass = namePassCount >= nameCount * NAME_PASS_THRESHOLD;

        gatewayAssessments[host.fqdn] = {
          ownershipAssessment,
          arnsAssessments: {
            prescribedNames: prescribedAssessments,
            chosenNames: chosenAssessments,
            pass: namesPass,
          },
          pass: ownershipAssessment.pass && namesPass,
        };
      },
      { concurrency: this.gatewayAsessementConcurrency },
    );

    return {
      formatVersion: REPORT_FORMAT_VERSION,
      observerAddress: this.observerAddress,
      epochStartHeight,
      epochEndHeight,
      generatedAt: +(Date.now() / 1000).toFixed(0),
      gatewayAssessments,
    };
  }
}
