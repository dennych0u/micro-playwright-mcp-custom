/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { z } from 'zod';
import { defineTool } from './tool.js';
import type * as playwright from 'playwright'; // 如果不再直接使用 playwright 类型，可以移除
// 新增: 导入 Redis 相关函数和类型
import { getAllRequestsForPage, StoredRequestResponse } from '../redisClient.js'; 

/**
 * Extracts the hostname from a URL string.
 * @param url The URL string to parse.
 * @returns The hostname part of the URL (e.g., "www.example.com").
 *          If the input is not a valid URL but could be a hostname itself, it returns the input string.
 *          Returns an empty string if parsing fails and input is not a simple hostname-like string.
 */
function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch (e) {
    if (/^[a-zA-Z0-9.-]+$/.test(url) && url.includes('.')) {
        return url; 
    }
    return ''; 
  }
}

/**
 * Checks if the hostname of a URL exactly matches a specific target hostname.
 * @param requestUrl The URL string of the request to check.
 * @param targetHostname The target hostname (e.g., "www.example.com") to match against. Assumed to be a clean hostname.
 * @returns True if the requestUrl's hostname exactly matches the targetHostname, false otherwise.
 */
function urlMatchesHostname(requestUrl: string, targetHostname: string): boolean {
  const requestHostname = extractDomain(requestUrl);
  return requestHostname !== '' && targetHostname !== '' && requestHostname === targetHostname;
}

async function processRequestResponsePair(request: playwright.Request, response: playwright.Response | null) { // 已移除
  let requestBody: any = null;
  const postDataBuffer = request.postDataBuffer();
  if (postDataBuffer) {
    const contentTypeHeader = Object.keys(request.headers()).find(key => key.toLowerCase() === 'content-type');
    const contentType = contentTypeHeader ? request.headers()[contentTypeHeader] : undefined;
    if (contentType && contentType.includes('application/json')) {
      try {
        requestBody = JSON.parse(postDataBuffer.toString('utf-8'));
      } catch (e) {
        requestBody = postDataBuffer.toString('utf-8'); // Fallback to string if JSON parsing fails
      }
    } else {
      requestBody = postDataBuffer.toString('utf-8');
    }
  } else {
    requestBody = request.postData(); // Fallback for form data (e.g., application/x-www-form-urlencoded)
  }

  const requestDetails = {
    url: request.url(),
    method: request.method(),
    headers: request.headers(), // Returns headers with lower-case names
    body: requestBody,
  };

  let responseDetails = null;
  if (response) {
    let responseBodyContent: any = null;
    const responseHeaders = await response.allHeaders(); // Preserves original header casing
    const contentTypeHeader = Object.keys(responseHeaders).find(key => key.toLowerCase() === 'content-type');
    const contentType = contentTypeHeader ? responseHeaders[contentTypeHeader] : undefined;

    if (response.status() === 204 || response.status() === 205) {
        responseBodyContent = null; // HTTP 204 No Content, HTTP 205 Reset Content
    } else {
        try {
            // Check if the response is available - fixed type comparison issue
            const currentResponse = await request.response();
            const finished = currentResponse === response;
            
            if (!finished) {
                responseBodyContent = "Response not finished or already disposed";
            } else if (contentType && contentType.includes('application/json')) {
                try {
                    responseBodyContent = await response.json();
                } catch (e: any) { // Explicitly type 'e' as any
                    // If JSON parsing fails, try to get text
                    try {
                        responseBodyContent = await response.text();
                    } catch (textError: any) { // Explicitly type 'textError' as any
                        responseBodyContent = `Error fetching response body (JSON parse failed, text fallback failed): ${e.message} / ${textError.message}`;
                    }
                }
            } else if (contentType && (contentType.includes('text/') || 
                      contentType.includes('application/javascript') || 
                      contentType.includes('application/xml'))) {
                // Handle common text-based types
                responseBodyContent = await response.text();
            } else {
                // For binary, unknown content types, or if text/json is not appropriate/fails
                try {
                    const buffer = await response.body();
                    if (buffer && buffer.length > 0) {
                        // For binary data, just indicate the size and type
                        responseBodyContent = `Binary response (size: ${buffer.length} bytes, content-type: ${contentType || 'unknown'})`;
                    } else {
                        responseBodyContent = null; // Empty body
                    }
                } catch (e: any) {
                    responseBodyContent = `Cannot access response body: ${e.message}`;
                }
            }
        } catch (e: any) {
            // This catch block handles errors from response.json(), response.text(), or response.body()
            responseBodyContent = `Error fetching response body: ${e.message}`;
        }
    }
    
    if (responseBodyContent === "" && !(contentType && contentType.startsWith("text/"))) {
        responseBodyContent = null;
    }

    responseDetails = {
      status: response.status(),
      statusText: response.statusText(),
      headers: responseHeaders,
      body: responseBodyContent,
    };
  }

  return {
    request: requestDetails,
    response: responseDetails,
  };
}

const detailedNetworkRequestsTool = defineTool({
  capability: 'core',

  schema: {
    name: 'browser_network_requests',
    title: 'List detailed network requests',
    description: 'Returns detailed information for network requests and responses from Redis, filtered by resource types and optionally by a target hostname.',
    inputSchema: z.object({
      resource_types: z.array(z.string()).min(1).describe('Required array of resource types to filter by (e.g., ["fetch", "xhr", "script"]). At least one type must be specified.'),
      target_domain: z.string().optional().describe('Optional hostname to filter network requests. Only requests where the URL\'s hostname exactly matches this value will be returned (e.g., "www.example.com"). Inputting a full URL will attempt to extract the hostname.'),
    }),
    type: 'readOnly',
  },

  handle: async (context, params) => {
    const tab = context.currentTabOrDie();
    let allRequestsFromRedis: StoredRequestResponse[];
    try {
      // 从 Redis 获取当前 Tab 的所有请求数据
      allRequestsFromRedis = await getAllRequestsForPage(tab.pageId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Failed to get requests for page ${tab.pageId} from Redis:`, errorMessage);
      return {
        code: [`// Error fetching requests from Redis: ${errorMessage}`],
        action: async () => ({
          content: [{ type: 'text', text: `Error fetching requests from Redis: ${errorMessage}` }]
        }),
        captureSnapshot: false,
        waitForNetwork: false,
      };
    }
    
    const filteredRequests: StoredRequestResponse[] = [];

    let effectiveTargetHostname: string | undefined = undefined;
    if (params.target_domain) {
        const cleanedInput = params.target_domain.trim();
        if (cleanedInput) {
            effectiveTargetHostname = extractDomain(cleanedInput);
            if (!effectiveTargetHostname) {
                // 如果 target_domain 无效，则没有请求能匹配
            }
        }
    }

    for (const storedEntry of allRequestsFromRedis) {
      const currentResourceType = storedEntry.request.resourceType;

      if (!params.resource_types.includes(currentResourceType)) {
        continue;
      }

      if (params.target_domain) { 
        if (!effectiveTargetHostname) {
            continue; // 无效的目标域名，跳过所有
        }
        if (!urlMatchesHostname(storedEntry.request.url, effectiveTargetHostname)) {
          continue; 
        }
      }
      
      // StoredRequestResponse 结构已包含所需信息
      filteredRequests.push(storedEntry);
    }

    const resourceTypesString = params.resource_types.join(', ');
    let logMessage = `// <internal code to list detailed network requests of type(s) [${resourceTypesString}] from Redis`;
    if (effectiveTargetHostname) {
        logMessage += ` for hostname "${effectiveTargetHostname}"`;
    } else if (params.target_domain) { // 用户提供了 target_domain 但它解析为空/无效
        logMessage += ` (invalid or empty target_domain provided: "${params.target_domain}")`;
    }
    logMessage += '>';

    return {
      code: [logMessage],
      action: async () => {
        return {
          // 返回的 filteredRequests 已经是 StoredRequestResponse[] 结构
          content: [{ type: 'text', text: JSON.stringify(filteredRequests, null, 2) }]
        };
      },
      captureSnapshot: false,
      waitForNetwork: false,
    };
  },
});

export default [
  detailedNetworkRequestsTool,
];
