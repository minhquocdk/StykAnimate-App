#!/usr/bin/env node
/** StykAnimate MCP server (v0.1) — stdio transport.
 *  Run: node mcp/server.mjs
 *  stdout carries only JSON-RPC; every log goes to stderr.
 *
 *  SPDX-License-Identifier: GPL-3.0-or-later
 *  Created by minhquocdk on 2026-11-03 for the MCP integration effort.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.mjs';

const server = new McpServer({ name: 'stykanimate', version: '0.1.0' });
registerTools(server);

const transport = new StdioServerTransport();
try {
  await server.connect(transport);
} catch (error) {
  console.error('stykanimate MCP server failed:', error);
  process.exit(1);
}
