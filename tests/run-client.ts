import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client';
// 如果上面一行导入失败，并且 @modelcontextprotocol/sdk 安装在项目 node_modules 中，
// 尝试相对路径，但这通常不推荐，确保 tsconfig 和 node 解析能找到它。
// import { Client, StreamableHTTPClientTransport } from './node_modules/@modelcontextprotocol/sdk/client/index.js';

async function main() {
  // 确保 URL 和端口与您的服务器调试配置一致
  // 默认 "Debug Playwright MCP (HTTP)" 使用 8080 端口，路径为 /mcp
  const transport = new StreamableHTTPClientTransport('http://localhost:8080/mcp');
  const client = new Client(transport);

  try {
    console.log('Attempting to connect to the MCP server...');
    await client.connect();
    console.log('Client connected successfully.');

    // 示例 1: 调用 'ping' 工具 (一个简单的测试工具)
    // 在 src/tools/core.ts 的 ping 工具的 handle 方法中设置断点
    console.log("Calling 'ping' tool...");
    const pingResponse = await client.tool('ping', {});
    console.log("'ping' tool response:", JSON.stringify(pingResponse, null, 2));

    // 示例 2: 调用 'browser_navigate' 工具
    // 在 src/tools/navigate.ts 的 navigate 工具的 handle 方法中设置断点
    // console.log("Calling 'browser_navigate' tool to 'https://example.com'...");
    // const navigateResponse = await client.tool('browser_navigate', { url: 'https://example.com' });
    // console.log("'browser_navigate' tool response:", JSON.stringify(navigateResponse, null, 2));

  } catch (error) {
    console.error('Client encountered an error:', error);
  } finally {
    if (client.isConnected) {
      await client.close();
      console.log('Client disconnected.');
    }
  }
}

main().catch(err => {
  console.error("Error in main execution:", err);
});