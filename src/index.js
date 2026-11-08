#!/usr/bin/env node
/**
 * qzone-mcp —— QQ 空间操作 MCP 服务器
 *
 * 方案 A：通过 CDP 连接用户已登录的 Edge，实时提取 Cookie。
 * 完全不用扫码，只要 Edge 开着且登录了 QQ 空间即可。
 *
 * 使用前需要用调试端口启动 Edge：
 *   msedge.exe --remote-debugging-port=9222
 *
 * 1. 优先用保存的 Cookie（25 分钟缓存）
 * 2. 过期则从 Edge 实时提取最新 Cookie（p_skey 一直有效）
 * 3. 连接失败则提示用户启动带调试端口的 Edge
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const COOKIE_NAMES = ['p_skey', 'p_uin', 'skey', 'uin', 'pt4_token', 'ptcz', 'RK', 'pgv_pvid'];
const CDP_ENDPOINT = process.env.QZONE_CDP || 'http://localhost:9222';

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return null; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function getGTk(pSkey) {
  let h = 5381;
  for (let i = 0; i < pSkey.length; i++) h += (h << 5) + pSkey.charCodeAt(i);
  return h & 0x7fffffff;
}

function cookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

function parseJsonp(text) {
  const m = text.match(/[Cc]allback\((\{[\s\S]*\})\s*\)/);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  try { return JSON.parse(text); } catch {}
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch {} }
  return { code: -1, msg: 'parse error', raw: String(text).slice(0, 500) };
}

/** 用 API 检查 Cookie 是否有效 */
async function checkCookieValid(cfg) {
  if (!cfg?.cookies?.p_skey) return false;
  const cookies = cfg.cookies;
  const gTk = getGTk(cookies.p_skey);
  const params = new URLSearchParams({
    uin: cfg.uin, ftype: '0', sort: '0', pos: '0', num: '1',
    replynum: '0', g_tk: gTk, callback: '_preloadCallback',
    code_version: '1', format: 'jsonp', need_private_comment: '1',
  });
  try {
    const res = await fetch(`https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6?${params}`, {
      headers: { 'User-Agent': UA, 'Cookie': cookieHeader(cookies) },
      signal: AbortSignal.timeout(10000),
    });
    return parseJsonp(await res.text()).code === 0;
  } catch { return false; }
}

/**
 * 通过 CDP 连接到用户已登录的 Edge。
 * 不启动新浏览器，只连接已运行的 Edge。
 */
async function connectEdge() {
  try {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    return browser;
  } catch {
    throw new Error(
      `无法连接到 Edge（${CDP_ENDPOINT}）。\n` +
      `请先用以下命令启动 Edge：\n` +
      `  msedge.exe --remote-debugging-port=9222\n\n` +
      `然后在 Edge 里登录 QQ 空间，再调用工具。`
    );
  }
}

/** 从已连接的 Edge 实时提取最新 Cookie */
async function extractCookiesFromEdge() {
  const browser = await connectEdge();
  const contexts = browser.contexts();
  const cookieDict = {};
  let uin = '';
  for (const ctx of contexts) {
    const cookies = await ctx.cookies();
    for (const c of cookies) {
      if (COOKIE_NAMES.includes(c.name) || c.name.startsWith('p_') || c.name.startsWith('pt')) {
        cookieDict[c.name] = c.value;
      }
      if (c.name === 'uin') uin = c.value.replace('o', '');
    }
  }
  if (!uin) uin = (cookieDict.p_uin || '').replace('o', '');
  if (!cookieDict.p_skey) {
    throw new Error('Edge 中未找到 p_skey，请在 Edge 里登录 QQ 空间后重试。');
  }
  const cfg = { uin, cookies: cookieDict };
  saveConfig(cfg);
  return cfg;
}

/**
 * 确保有有效的 Cookie。
 * 1. 先用保存的 Cookie（25 分钟缓存）
 * 2. 过期则从 Edge 实时提取最新 Cookie
 * 3. 提取失败则提示用户启动 Edge
 */
const COOKIE_CACHE_TTL = 25 * 60 * 1000;
let lastCheckTime = 0;
let lastValid = false;

async function ensureValidConfig() {
  let cfg = loadConfig();

  // 缓存：25 分钟内验证过有效，直接用
  if (cfg && lastValid && Date.now() - lastCheckTime < COOKIE_CACHE_TTL) {
    return cfg;
  }

  if (cfg && await checkCookieValid(cfg)) {
    lastCheckTime = Date.now();
    lastValid = true;
    return cfg;
  }
  lastValid = false;

  // 从 Edge 实时提取最新 Cookie
  cfg = await extractCookiesFromEdge();
  if (cfg && await checkCookieValid(cfg)) {
    lastCheckTime = Date.now();
    lastValid = true;
    return cfg;
  }

  throw new Error('Cookie 无效，请在 Edge 里确认已登录 QQ 空间。');
}

const server = new McpServer({ name: 'qzone', version: '1.0.0' });

server.tool(
  'qzone_check_login',
  '检查 Edge 登录状态。确认 Edge 已用 --remote-debugging-port=9222 启动且已登录 QQ 空间。',
  {},
  async () => {
    try {
      const cfg = await extractCookiesFromEdge();
      const valid = await checkCookieValid(cfg);
      if (valid) {
        return { content: [{ type: 'text', text: `登录有效！QQ 号：${cfg.uin}\n可以直接使用 qzone_get_feed_list 和 qzone_comment_feed。` }] };
      }
      return { content: [{ type: 'text', text: '已连接 Edge 但 Cookie 无效，请在 Edge 里重新登录 QQ 空间。' }], isError: true };
    } catch (e) {
      return { content: [{ type: 'text', text: `检查失败：${e?.message ?? e}` }], isError: true };
    }
  }
);

server.tool(
  'qzone_get_feed_list',
  '获取指定 QQ 号的说说列表，返回 tid、内容、时间等。评论前需先用本工具拿到 tid。',
  {
    targetUin: z.union([z.number(), z.string()]).describe('目标空间 QQ 号'),
    count: z.number().optional().describe('获取条数，默认 5'),
  },
  async ({ targetUin, count }) => {
    try {
      const cfg = await ensureValidConfig();
      const uin = String(targetUin);
      const cookies = cfg.cookies;
      const gTk = getGTk(cookies.p_skey);
      const params = new URLSearchParams({
        uin, ftype: '0', sort: '0', pos: '0', num: String(count ?? 5),
        replynum: '100', g_tk: gTk, callback: '_preloadCallback',
        code_version: '1', format: 'jsonp', need_private_comment: '1',
      });
      const res = await fetch(`https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6?${params}`, {
        headers: { 'User-Agent': UA, 'Cookie': cookieHeader(cookies), 'Referer': `https://user.qzone.qq.com/${uin}` },
        signal: AbortSignal.timeout(15000),
      });
      const result = parseJsonp(await res.text());
      if (result.code !== 0) {
        return { content: [{ type: 'text', text: `获取失败（code=${result.code}）：${result.message || ''}` }], isError: true };
      }
      const list = (result.msglist || []).map(m => ({
        tid: m.tid, content: (m.content || '').slice(0, 120),
        createTime: m.createTime, cmtnum: m.cmtnum || 0, nickname: m.name || '',
      }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `失败：${e?.message ?? e}` }], isError: true };
    }
  }
);

server.tool(
  'qzone_comment_feed',
  '对指定说说发表评论。需先通过 qzone_get_feed_list 拿到 tid。',
  {
    targetUin: z.union([z.number(), z.string()]).describe('说说发布者 QQ 号'),
    tid: z.string().describe('说说 ID'),
    content: z.string().describe('评论内容'),
  },
  async ({ targetUin, tid, content }) => {
    try {
      const cfg = await ensureValidConfig();
      const uin = String(targetUin);
      const cookies = cfg.cookies;
      const gTk = getGTk(cookies.p_skey);
      const myUin = String(cfg.uin);
      const txt = String(content).slice(0, 500);
      const topicId = `${uin}_${tid}`;
      const body = new URLSearchParams({
        uin: myUin, hostUin: uin, topicId, commentUin: myUin, content: txt,
        richval: '', richtype: '', inCharset: '', outCharset: '', ref: '',
        private: '0', with_fwd: '0', to_tweet: '0', hostuin: uin,
        code_version: '1', format: 'fs',
        qzreferrer: `https://user.qzone.qq.com/${uin}/mood/${tid}`,
      });
      const res = await fetch(`https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_addcomment_ugc?&g_tk=${gTk}`, {
        method: 'POST',
        headers: {
          'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'Cookie': cookieHeader(cookies), 'Referer': `https://user.qzone.qq.com/${uin}/mood/${tid}`,
          'Origin': 'https://user.qzone.qq.com',
        },
        body, signal: AbortSignal.timeout(15000),
      });
      const result = parseJsonp(await res.text());
      if (result.code === 0) {
        const id = result.data?.id;
        return { content: [{ type: 'text', text: `评论成功${id != null ? `，评论ID: ${id}` : ''}` }] };
      }
      return { content: [{ type: 'text', text: `评论失败（code=${result.code}）：${result.message || ''}` }], isError: true };
    } catch (e) {
      return { content: [{ type: 'text', text: `失败：${e?.message ?? e}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
