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

export class Tab {
  readonly context: Context;
  readonly page: playwright.Page;
  private _consoleMessages: playwright.ConsoleMessage[] = [];
  private _requests: Map<playwright.Request, playwright.Response | null> = new Map();
  private readonly MAX_REQUESTS_TO_KEEP = 400; // 新增：定义保留请求的最大数量
  private _snapshot: PageSnapshot | undefined;
  private _onPageClose: (tab: Tab) => void;

  constructor(context: Context, page: playwright.Page, onPageClose: (tab: Tab) => void) {
    this.context = context;
    this.page = page;
    this._onPageClose = onPageClose;
    page.on('console', event => this._consoleMessages.push(event));
    page.on('request', request => {
      this._requests.set(request, null);
      this._manageRequestsLimit(); // 新增：在添加新请求后管理请求数量
    });

    this.page.on('response', response => {
      // 确保请求对象存在于映射中（通常 'request' 事件会先触发）
      // 如果请求因某些原因（例如，从缓存提供服务而没有触发 'request' 事件，尽管不太可能用于XHR/fetch）
      // 或者如果这是一个非常快速失败的请求，可能需要更复杂的逻辑，
      // 但对于标准流程，请求应该已经存在。
      if (this._requests.has(response.request()) || !response.request().url().startsWith('data:')) {
        // 对于data: URL的响应，可能没有对应的 'request' 事件先被记录到 _requests 中，
        // 但这些通常不是我们关心的 "API" 请求，所以可以安全地更新或添加。
        // 如果 response.request() 不在 _requests 中，并且不是 data URI，
        // 那么我们仍然添加它并管理限制。
        if (!this._requests.has(response.request()) && !response.request().url().startsWith('data:')) {
            this._requests.set(response.request(), response);
            this._manageRequestsLimit(); // 如果是新条目，则管理限制
        } else if (this._requests.has(response.request())) {
            this._requests.set(response.request(), response); // 仅更新，不改变大小
        }
      }
    });

    this.page.on('console', message => {
      this._consoleMessages.push(message);
    });
    page.on('close', () => this._onClose());
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

  // 新增：管理请求列表大小的方法
  private _manageRequestsLimit() {
    while (this._requests.size > this.MAX_REQUESTS_TO_KEEP) {
      // Map 会记住插入顺序，所以第一个 key 是最早的
      const oldestRequestKey = this._requests.keys().next().value;
      if (oldestRequestKey) {
        this._requests.delete(oldestRequestKey);
      } else {
        // 如果没有 key 了（理论上在 size > 0 时不应发生），则退出循环
        break;
      }
    }
  }

  private _clearCollectedArtifacts() {
    this._consoleMessages.length = 0;
    this._requests.clear();
  }

  private _onClose() {
    this._clearCollectedArtifacts();
    this._onPageClose(this);
  }

  async navigate(url: string) {
    this._clearCollectedArtifacts();

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

  requests(): Map<playwright.Request, playwright.Response | null> {
    return this._requests;
  }

  async captureSnapshot() {
    this._snapshot = await PageSnapshot.create(this.page);
  }
}
