import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import type * as playwright from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url'; // 新增: 导入 fileURLToPath

// 新增: 定义 Redis 配置接口和加载函数
interface RedisConfig {
  host: string;
  port: number;
  password?: string | null;
  defaultTTLSeconds: number; // 修改: TTL 配置项变为必需的 number 类型
}

function loadRedisConfig(): RedisConfig {
  const defaultConfig: RedisConfig = {
    host: '127.0.0.1',
    port: 6379,
    password: null,
    defaultTTLSeconds: 604800, // 默认7天 (7 * 24 * 60 * 60)
  };

  // 获取当前模块的文件路径
  const __filename = fileURLToPath(import.meta.url);
  // 获取当前模块所在的目录
  const __dirname = path.dirname(__filename);

  // 配置文件 redis.config.json 位于项目根目录
  // __dirname 此时指向编译后的 lib 目录 (e.g., d:\code\my-playwright-mcp\lib)
  // 因此需要向上导航一级 (../) 到达项目根目录
  const configPath = path.resolve(__dirname, '../redis.config.json');


  if (fs.existsSync(configPath)) {
    try {
      const configFile = fs.readFileSync(configPath, 'utf-8');
      const configFromFile = JSON.parse(configFile) as Partial<RedisConfig>;
      // 合并配置，文件中的配置优先
      return {
        host: configFromFile.host || defaultConfig.host,
        port: configFromFile.port || defaultConfig.port,
        password: configFromFile.password !== undefined ? configFromFile.password : defaultConfig.password,
        defaultTTLSeconds: configFromFile.defaultTTLSeconds !== undefined ? configFromFile.defaultTTLSeconds : defaultConfig.defaultTTLSeconds, // 读取或使用默认 TTL
      };
    } catch (error) {
      console.warn(`Error reading or parsing Redis config file at ${configPath}. Using default configuration. Error: ${error}`);
      return defaultConfig;
    }
  } else {
    console.warn(`Redis config file not found at ${configPath}. Using default configuration.`);
    return defaultConfig;
  }
}

// 从配置文件加载 Redis 配置
const redisConfig = loadRedisConfig();

const redisClient = new Redis({
  host: redisConfig.host,
  port: redisConfig.port,
  password: redisConfig.password || undefined, // ioredis 期望 undefined 如果没有密码
  lazyConnect: false, // 修改: 立即尝试连接
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
  connectTimeout: 10000, // 增加连接超时时间
});

redisClient.on('connect', () => {
  console.log('Successfully connected to Redis');
});

redisClient.on('error', (err) => {
  console.error('Redis connection error:', err);
});

const KEY_PREFIX = 'playwright_mcp_requests:';

export interface StoredRequestResponse {
  id: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: any;
    resourceType: string;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: any;
  } | null;
  timestamp: number;
}

export async function connectRedis() {
  if (redisClient.status === 'end' || redisClient.status === 'close') {
    console.log('Attempting to connect to Redis...');
    await redisClient.connect().catch(err => {
        console.error('Failed to connect to Redis:', err);
        throw err; 
    });
  } else if (redisClient.status !== 'connecting' && redisClient.status !== 'connect' && redisClient.status !== 'ready') {
     console.log('Redis not connected, attempting to connect...');
     await redisClient.connect().catch(err => {
        console.error('Failed to connect to Redis during status check:', err);
        throw err;
     });
  }
}

// 新增: 导出初始化函数
export async function initializeRedisConnection(): Promise<void> {
  if (redisClient.status !== 'ready' && redisClient.status !== 'connecting') {
    console.log('Initializing Redis connection...');
    try {
      await redisClient.connect();
      console.log('Redis connection initialized successfully during startup.');
    } catch (error) {
      console.error('Failed to initialize Redis connection during startup:', error);
      // 根据应用需求，这里可以决定是否抛出错误以中断启动
      // throw error; 
    }
  } else if (redisClient.status === 'ready') {
    console.log('Redis already connected.');
  } else if (redisClient.status === 'connecting') {
    console.log('Redis is already connecting, awaiting existing connection attempt...');
    try {
      await redisClient.connect(); // Await the ongoing connection
      console.log('Redis connection established (was connecting).');
    } catch (error) {
      console.error('Error during ongoing Redis connection attempt:', error);
      // throw error;
    }
  }
}

export async function storeRequest(
  pageId: string,
  request: playwright.Request
): Promise<string> {
  await connectRedis();
  const requestId = uuidv4();
  const requestKey = `${KEY_PREFIX}${pageId}:${requestId}`;

  let requestBody: any = null;
  const postDataBuffer = request.postDataBuffer();
  if (postDataBuffer) {
    const contentTypeHeader = Object.keys(request.headers()).find(key => key.toLowerCase() === 'content-type');
    const contentType = contentTypeHeader ? request.headers()[contentTypeHeader] : undefined;
    if (contentType && contentType.includes('application/json')) {
      try {
        requestBody = JSON.parse(postDataBuffer.toString('utf-8'));
      } catch (e) {
        requestBody = postDataBuffer.toString('utf-8');
      }
    } else {
      requestBody = postDataBuffer.toString('utf-8');
    }
  } else {
    // Playwright's postData() can return null for non-POST or empty body requests
    const pd = request.postData();
    if (pd) {
        requestBody = pd;
    }
  }

  const data: StoredRequestResponse = {
    id: requestId,
    request: {
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      body: requestBody,
      resourceType: request.resourceType(),
    },
    response: null,
    timestamp: Date.now(),
  };

  // 使用 EX 参数设置 TTL (单位：秒)
  await redisClient.set(requestKey, JSON.stringify(data), 'EX', redisConfig.defaultTTLSeconds);
  await redisClient.rpush(`${KEY_PREFIX}list:${pageId}`, requestKey);
  // 为请求列表键也设置 TTL
  await redisClient.expire(`${KEY_PREFIX}list:${pageId}`, redisConfig.defaultTTLSeconds);
  return requestKey;
}

export async function storeResponse(
  requestKey: string,
  response: playwright.Response
): Promise<void> {
  await connectRedis();
  const existingDataString = await redisClient.get(requestKey);
  if (!existingDataString) {
    console.warn(`Request data not found in Redis for key: ${requestKey}. Cannot store response.`);
    return;
  }

  const data: StoredRequestResponse = JSON.parse(existingDataString);

  let responseBodyContent: any = null;
  const responseHeaders = await response.allHeaders();
  const contentTypeHeader = Object.keys(responseHeaders).find(key => key.toLowerCase() === 'content-type');
  const contentType = contentTypeHeader ? responseHeaders[contentTypeHeader] : undefined;

  if (response.status() === 204 || response.status() === 205) {
    responseBodyContent = null;
  } else {
    try {
      // Attempt to get body only if response finished successfully
      if (response.ok()) { // response.ok() is true if status is 200-299
        if (contentType && contentType.includes('application/json')) {
          responseBodyContent = await response.json().catch(async (jsonError) => {
            // console.warn(`Failed to parse response as JSON for ${data.request.url}, trying text. Error: ${jsonError.message}`);
            return response.text().catch(textError => {
              // console.warn(`Failed to get response as text for ${data.request.url}. Error: ${textError.message}`);
              return `Error fetching JSON/text body: ${jsonError.message} / ${textError.message}`;
            });
          });
        } else if (contentType && (contentType.includes('text/') || contentType.includes('application/javascript') || contentType.includes('application/xml'))) {
          responseBodyContent = await response.text().catch(textError => {
            // console.warn(`Failed to get response as text for ${data.request.url}. Error: ${textError.message}`);
            return `Error fetching text body: ${textError.message}`;
          });
        } else {
          const buffer = await response.body().catch(bodyError => {
            // console.warn(`Failed to get response body (binary) for ${data.request.url}. Error: ${bodyError.message}`);
            return null;
          });
          if (buffer && buffer.length > 0) {
            responseBodyContent = `Binary response (size: ${buffer.length} bytes, content-type: ${contentType || 'unknown'})`;
          } else if (buffer === null) {
              responseBodyContent = 'Error fetching binary body';
          } else {
            responseBodyContent = null; 
          }
        }
      } else {
         responseBodyContent = `Response not OK (status: ${response.status()}), body not fetched.`;
      }
    } catch (e: any) {
      // console.error(`Generic error fetching response body for ${data.request.url}: ${e.message}`);
      responseBodyContent = `Error fetching response body: ${e.message}`;
    }
  }
  
  if (responseBodyContent === "" && !(contentType && contentType.startsWith("text/"))) {
    responseBodyContent = null;
  }

  data.response = {
    status: response.status(),
    statusText: response.statusText(),
    headers: responseHeaders,
    body: responseBodyContent,
  };
  data.timestamp = Date.now();

  // 使用 EX 参数设置 TTL (单位：秒)
  // 注意：如果原始键已设置TTL，则SET命令会覆盖它。
  // 如果希望保留原始TTL（例如，如果storeRequest设置的TTL更精确），则需要不同的逻辑。
  // 但在此场景下，每次更新都重置TTL为配置值是合理的。
  await redisClient.set(requestKey, JSON.stringify(data), 'EX', redisConfig.defaultTTLSeconds);
}

export async function getAllRequestsForPage(pageId: string): Promise<StoredRequestResponse[]> {
  await connectRedis();
  const requestKeys = await redisClient.lrange(`${KEY_PREFIX}list:${pageId}`, 0, -1);
  if (!requestKeys || requestKeys.length === 0) {
    return [];
  }
  
  const pipeline = redisClient.pipeline();
  requestKeys.forEach(key => pipeline.get(key));
  const results = await pipeline.exec();
  
  const allRequests: StoredRequestResponse[] = [];
  if (results) {
    results.forEach(([err, data]) => {
      if (data && !err) {
        try {
          allRequests.push(JSON.parse(data as string));
        } catch (parseError) {
          console.error('Failed to parse request data from Redis:', parseError, data);
        }
      } else if (err) {
        console.error('Error fetching request data from Redis:', err);
      }
    });
  }
  return allRequests;
}

export async function clearRequestsForPage(pageId: string): Promise<void> {
  await connectRedis();
  const requestKeys = await redisClient.lrange(`${KEY_PREFIX}list:${pageId}`, 0, -1);
  if (requestKeys && requestKeys.length > 0) {
    const pipeline = redisClient.pipeline();
    requestKeys.forEach(key => pipeline.del(key));
    await pipeline.exec();
  }
  await redisClient.del(`${KEY_PREFIX}list:${pageId}`);
}

export async function disconnectRedis() {
  if (redisClient.status === 'ready' || redisClient.status === 'connect') {
    await redisClient.quit().catch(err => console.error("Error during Redis quit:", err));
  }
}

export function generatePageId(): string {
    return uuidv4();
}