#!/usr/bin/env node
/**
 * qzone-mcp —— QQ 空间操作 MCP 服务器
 *
 * 核心设计：浏览器常驻后台，p_skey 不会消失，避免反复扫码。
 *
 * 1. 首次使用：qzone_login 弹浏览器扫码，登录后浏览器保持后台运行
 * 2. 平时：用后台浏览器里的最新 Cookie 调 API（p_skey 一直有效）
 * 3. Cookie 过期：自动从后台浏览器提取最新 Cookie（无需扫码）
 * 4. 浏览器被关闭：重新启动，若登录态失效才需要重新扫码
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
const USER_DATA_DIR = path.join(ROOT, 'user_data');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const COOKIE_NAMES = ['p_skey', 'p_uin', 'skey', 'uin', 'pt4_token', 'ptcz', 'RK', 'pgv_pvid'];

if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });

// 常驻的浏览器上下文（登录后保持运行，不关闭）
let persistentContext = null;

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
 * 获取或创建常驻浏览器上下文。
 * 浏览器启动后保持运行，p_skey 不会消失。
 */
async function getPersistentContext() {
  if (persistentContext) {
    // 检查是否还活着
    try {
      await persistentContext.pages();
      return persistentContext;
    } catch {
      persistentContext = null;
    }
  }
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const launchOpts = {
    headless: false,
    userAgent: UA,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling'],
  };
  if (fs.existsSync(edgePath)) launchOpts.executablePath = edgePath;
  persistentContext = await chromium.launchPersistentContext(USER_DATA_DIR, launchOpts);
  return persistentContext;
}

/** 从常驻浏览器提取最新 Cookie */
async function extractCookiesFromContext() {
  const ctx = await getPersistentContext();
  const cookies = await ctx.cookies();
  const cookieDict = {};
  let uin = '';
  for (const c of cookies) {
    if (COOKIE_NAMES.includes(c.name) || c.name.startsWith('p_') || c.name.startsWith('pt')) {
      cookieDict[c.name] = c.value;
    }
    if (c.name === 'uin') uin = c.value.replace('o', '');
  }
  if (!uin) uin = (cookieDict.p_uin || '').replace('o', '');
  if (!cookieDict.p_skey) return null;
  const cfg = { uin, cookies: cookieDict };
  saveConfig(cfg);
  return cfg;
}

/**
 * 确保有有效的 Cookie。
 * 1. 先用保存的 Cookie（25 分钟缓存）
 * 2. 过期则从常驻浏览器提取最新 Cookie
 * 3. 浏览器未登录则等待扫码
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

  // 从常驻浏览器提取最新 Cookie
  try {
    cfg = await extractCookiesFromContext();
    if (cfg && await checkCookieValid(cfg)) {
      lastCheckTime = Date.now();
      lastValid = true;
      return cfg;
    }
  } catch {}

  // 浏览器也未登录，需要扫码
  cfg = await loginAndWait();
  if (cfg) {
    lastCheckTime = Date.now();
    lastValid = true;
    return cfg;
  }

  throw new Error('无法获取有效登录态，请调用 qzone_login 扫码');
}

/** 启动浏览器并等待扫码登录 */
async function loginAndWait() {
  const ctx = await getPersistentContext();
  const page = ctx.pages().length > 0 ? ctx.pages()[0] : await ctx.newPage();
  try {
    await page.goto('https://user.qzone.qq.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {}

  console.error('[qzone-mcp] 请扫码登录 QQ 空间...');
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    const cfg = await extractCookiesFromContext();
    if (cfg && await checkCookieValid(cfg)) return cfg;
  }
  throw new Error('扫码登录超时（300秒）');
}

const server = new McpServer({ name: 'qzone', version: '1.0.0' });

server.tool(
  'qzone_login',
  '扫码登录 QQ 空间。登录后浏览器保持后台运行，只要不关闭就无需再扫码。',
  {},
  async () => {
    try {
      const cfg = await loginAndWait();
      return { content: [{ type: 'text', text: `登录成功！QQ 号：${cfg.uin}\n浏览器已保持后台运行，后续无需再扫码。` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `登录失败：${e?.message ?? e}` }], isError: true };
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

server.tool(
  'qzone_close_browser',
  '关闭后台浏览器。关闭后需要重新登录。仅在不需要使用时调用。',
  {},
  async () => {
    if (persistentContext) {
      await persistentContext.close().catch(() => {});
      persistentContext = null;
      return { content: [{ type: 'text', text: '后台浏览器已关闭。下次使用需重新登录。' }] };
    }
    return { content: [{ type: 'text', text: '浏览器未运行。' }] };
  }
);

await server.connect(new StdioServerTransport());
