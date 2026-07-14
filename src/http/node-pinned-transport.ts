import * as http from "node:http";
import * as https from "node:https";
import type { LookupFunction } from "node:net";

import type {
  PinnedHttpTransport,
  PinnedHttpTransportRequest,
  PinnedHttpTransportResponse,
} from "./pinned-transport.js";

const FORBIDDEN_OUTBOUND_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Node HTTP transport that connects through one EgressPolicy-approved address.
 * The original authority remains the Host header and TLS SNI/certificate name;
 * no system resolver is reachable from this layer.
 */
export class NodePinnedHttpTransport implements PinnedHttpTransport {
  async send(request: Readonly<PinnedHttpTransportRequest>): Promise<PinnedHttpTransportResponse> {
    const hop = request.hop;
    const target = new URL(hop.url);
    const pinned = hop.connection.addresses[0];
    if (!pinned) throw new Error("address-pinned transport received no approved address");
    const lookup: LookupFunction = ((_hostname: string, options: unknown, callback: Function) => {
      if (options && typeof options === "object" && (options as { all?: unknown }).all === true) {
        callback(null, [{ address: pinned.address, family: pinned.family }]);
      } else {
        callback(null, pinned.address, pinned.family);
      }
    }) as LookupFunction;
    const headers = headersObject(request.headers);
    headers.host = hop.connection.authority;
    headers["content-length"] = String(request.body.byteLength);

    const client = hop.protocol === "https:" ? https : http;
    return new Promise<PinnedHttpTransportResponse>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error("address-pinned HTTP transport failed"));
      };
      const outgoing = client.request({
        protocol: hop.protocol,
        hostname: hop.hostname,
        port: hop.port,
        path: `${target.pathname}${target.search}`,
        method: hop.method,
        headers,
        lookup,
        ...(hop.connection.serverName ? { servername: hop.connection.serverName } : {}),
        agent: false,
        signal: request.signal,
      }, (response) => {
        if (settled) {
          response.destroy();
          return;
        }
        settled = true;
        const status = response.statusCode;
        if (status === undefined) {
          response.destroy();
          reject(new Error("address-pinned HTTP response has no status"));
          return;
        }
        resolve({
          status,
          headers: rawHeaderPairs(response.rawHeaders),
          body: response,
        });
      });
      outgoing.once("error", fail);
      outgoing.end(request.body);
    });
  }
}

function headersObject(
  pairs: readonly (readonly [string, string])[],
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = Object.create(null);
  for (const [rawName, rawValue] of pairs) {
    const name = rawName.toLowerCase();
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
      typeof rawValue !== "string" ||
      /[\u0000-\u001f\u007f]/.test(rawValue) ||
      FORBIDDEN_OUTBOUND_HEADERS.has(name) ||
      Object.prototype.hasOwnProperty.call(result, name)
    ) {
      throw new Error("outbound HTTP header is invalid");
    }
    result[name] = rawValue;
  }
  return result;
}

function rawHeaderPairs(raw: string[]): readonly (readonly [string, string])[] {
  if (raw.length % 2 !== 0) throw new Error("HTTP response headers are malformed");
  const pairs: Array<readonly [string, string]> = [];
  for (let index = 0; index < raw.length; index += 2) {
    pairs.push(Object.freeze([raw[index], raw[index + 1]] as const));
  }
  return Object.freeze(pairs);
}
