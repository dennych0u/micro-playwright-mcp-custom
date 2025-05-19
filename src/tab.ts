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

import * as playwright from 'playwright';

import { PageSnapshot } from './pageSnapshot.js';

import type { Context } from './context.js';

// 新增: 导入 Redis 相关函数和类型
import { storeRequest, storeResponse, clearRequestsForPage, generatePageId } from './redisClient.js';

export class Tab {
  readonly context: Context;
  readonly page: playwright.Page;
  readonly pageId: string; // 新增: 用于 Redis 键作用域的唯一页面ID
  private _consoleMessages: playwright.ConsoleMessage[] = [];
  // private _requests: Map<playwright.Request, playwright.Response | null> = new Map(); // 已移除
  // private readonly MAX_REQUESTS_TO_KEEP = 400; // 已移除
  private _snapshot: PageSnapshot | undefined;
  private _onPageClose: (tab: Tab) => void;
  // 新增: 临时存储 Playwright Request 对象到其 Redis 键的映射
  private _pendingRequests: Map<playwright.Request, string> = new Map(); 

  constructor(context: Context, page: playwright.Page, onPageClose: (tab: Tab) => void) {
    this.context = context;
    this.page = page;
    this.pageId = generatePageId(); // 新增: 为此 Tab 实例生成唯一 ID
    this._onPageClose = onPageClose;
    page.on('console', event => this._consoleMessages.push(event));

    page.on('request', async request => {
      if (request.url().startsWith('data:')) return; // 忽略 data URI
      try {
        const requestKey = await storeRequest(this.pageId, request);
        this._pendingRequests.set(request, requestKey);
      } catch (error) {
        console.error(`Failed to store request ${request.url()} in Redis:`, error);
      }
    });

    this.page.on('response', async response => {
      const request = response.request();
      if (request.url().startsWith('data:')) return; // 忽略 data URI

      const requestKey = this._pendingRequests.get(request);

      if (requestKey) {
        try {
          await storeResponse(requestKey, response);
        } catch (error) {
          console.error(`Failed to store response for ${request.url()} in Redis:`, error);
        }
        this._pendingRequests.delete(request); 
      } else {
        // 如果请求未被追踪 (例如，请求事件丢失或非常快)，尝试一并存储请求和响应
        // console.warn(`Response received for untracked request: ${response.url()}. Attempting to store now.`);
        try {
            const newRequestKey = await storeRequest(this.pageId, request);
            await storeResponse(newRequestKey, response);
        } catch (error) {
            console.error(`Failed to store ad-hoc request/response for ${request.url()} in Redis:`, error);
        }
      }
    });

    this.page.on('console', message => {
      this._consoleMessages.push(message);
    });
    page.on('close', () => this._onClose()); // 确保 _onClose 被调用
    page.on('filechooser', chooser => {
      this.context.setModalState({
        type: 'fileChooser',
        description: 'File chooser',
        fileChooser: chooser,
      }, this);
    });
    page.on('dialog', dialog => this.context.dialogShown(this, dialog));
    page.on('download', download => {
      void this.context.downloadStarted(this, download);
    });
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(5000);
  }

  // private _manageRequestsLimit() { // 已移除
  // ...
  // }

  private async _clearCollectedArtifacts() { // 修改为 async
    this._consoleMessages.length = 0;
    try {
      // 清理与此 pageId 关联的 Redis 中的请求
      await clearRequestsForPage(this.pageId);
    } catch (error) {
      console.error(`Failed to clear requests for page ${this.pageId} from Redis:`, error);
    }
    this._pendingRequests.clear(); // 清理待处理请求的映射
  }

  private async _onClose() { // 修改为 async
    await this._clearCollectedArtifacts(); // 确保 Redis 清理被等待
    this._onPageClose(this);
  }

  async navigate(url: string) {
    await this._clearCollectedArtifacts(); // 导航前清理当前 pageId 的残留数据

    const downloadEvent = this.page.waitForEvent('download').catch(() => {});
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (_e: unknown) {
      const e = _e as Error;
      const mightBeDownload =
        e.message.includes('net::ERR_ABORTED') // chromium
        || e.message.includes('Download is starting'); // firefox + webkit
      if (!mightBeDownload)
        throw e;

      // on chromium, the download event is fired *after* page.goto rejects, so we wait a lil bit
      const download = await Promise.race([
        downloadEvent,
        new Promise(resolve => setTimeout(resolve, 500)),
      ]);
      if (!download)
        throw e;
    }

    // Cap load event to 5 seconds, the page is operational at this point.
    await this.page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
  }

  hasSnapshot(): boolean {
    return !!this._snapshot;
  }

  snapshotOrDie(): PageSnapshot {
    if (!this._snapshot)
      throw new Error('No snapshot available');
    return this._snapshot;
  }

  consoleMessages(): playwright.ConsoleMessage[] {
    return this._consoleMessages;
  }

  // requests(): Map<playwright.Request, playwright.Response | null> { // 已移除
  // return this._requests;
  // }

  async captureSnapshot() {
    this._snapshot = await PageSnapshot.create(this.page);
  }
}
