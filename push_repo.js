#!/usr/bin/env node
/**
 * push_repo.js — 把 index.html / data.json 推送到 GitHub Pages 仓库
 *
 * 用途：对话里发「刷新」后，AI 抓到新内容 → 写进 data.json → 跑这个脚本推送
 *      → 用户刷新页面（或点「AI刷新抓取」）就能看到最新数据。
 *
 * 前置：
 *   1. 仓库名必须是 <你的用户名>.github.io（GitHub Pages user site 硬规则）
 *   2. 建一个 fine-grained PAT，只授权该仓库、权限只勾 Contents: Read and write
 *   3. Node.js >= 18（内置 fetch）
 *
 * 用法：
 *   GITHUB_TOKEN=github_pat_xxx GITHUB_USER=your-name node push_repo.js
 *
 *   或显式传参：
 *   node push_repo.js --token=github_pat_xxx --user=your-name \
 *      [--repo=your-name.github.io] [--branch=main] [--files=index.html,data.json]
 *
 * 说明：
 *   - 逐个文件先 GET 取 sha，再 PUT；命中 409（并发冲突）会重新取 sha 重试一次。
 *   - 文本按 UTF-8 转 base64，不破坏中文。
 *   - 只读 token 也能跑，但会在 PUT 时收到 403，脚本会明确提示。
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* ---------- 参数 ---------- */
const argv = {};
process.argv.slice(2).forEach(function (a) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) argv[m[1]] = m[2];
  else if (/^--[^=]+$/.test(a)) argv[a.slice(2)] = 'true';
});

const TOKEN = argv.token || process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
const USER = argv.user || process.env.GITHUB_USER;
const REPO = argv.repo || process.env.GITHUB_REPO || (USER ? USER + '.github.io' : '');
const BRANCH = argv.branch || process.env.GITHUB_BRANCH || 'main';
const FILES = (argv.files || 'index.html,data.json')
  .split(',')
  .map(function (s) { return s.trim(); })
  .filter(Boolean);

const ROOT = __dirname;
const API = 'https://api.github.com';

/* ---------- 基础检查 ---------- */
if (typeof fetch !== 'function') {
  console.error('这个脚本需要 Node.js 18 及以上（内置 fetch）。当前版本：' + process.version);
  process.exit(1);
}
if (!TOKEN || !USER || !REPO) {
  console.error(
    '缺少参数。示例：\n' +
    '  GITHUB_TOKEN=github_pat_xxx GITHUB_USER=your-name node push_repo.js\n' +
    '或：\n' +
    '  node push_repo.js --token=github_pat_xxx --user=your-name\n'
  );
  process.exit(1);
}
if (REPO !== USER + '.github.io') {
  console.warn(
    '⚠️ 仓库名是 "' + REPO + '"，而 GitHub Pages 个人站要求仓库名必须等于 ' + USER + '.github.io。\n' +
    '   如果这不是你的个人站仓库，请改成正确名字，否则拿不到 https://' + USER + '.github.io 短网址。\n'
  );
}

function headers() {
  return {
    Authorization: 'Bearer ' + TOKEN,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'xiuxheng-workbench-push'
  };
}

function contentsUrl(file) {
  return API + '/repos/' + USER + '/' + REPO + '/contents/' + encodeURIComponent(file);
}

function explain(status) {
  if (status === 401) return 'Token 无效或已过期（401）。检查是否复制完整、是否已过期。';
  if (status === 403) return '权限不足（403）。fine-grained token 需要该仓库 Contents: Read and write。';
  if (status === 404) return '仓库或路径不存在（404）。检查用户名、仓库名，以及分支 ' + BRANCH + ' 是否已存在。';
  if (status === 409) return '分支并发冲突（409）。通常重试即可。';
  if (status === 422) return '请求被拒绝（422）。常见原因是文件过大或 sha 不匹配。';
  return 'HTTP ' + status;
}

async function getSha(file) {
  const res = await fetch(contentsUrl(file) + '?ref=' + encodeURIComponent(BRANCH), {
    headers: headers(),
    cache: 'no-store'
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('读取 ' + file + ' 失败：' + explain(res.status));
  const json = await res.json();
  return json && json.sha ? json.sha : null;
}

async function putFile(file, content, sha) {
  const body = {
    message: 'chore: 更新 ' + file + ' · ' + new Date().toISOString(),
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: BRANCH
  };
  if (sha) body.sha = sha;

  const res = await fetch(contentsUrl(file), {
    method: 'PUT',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
    body: JSON.stringify(body)
  });

  if (res.status === 409) {
    // 冲突：重新取 sha 再推一次
    const fresh = await getSha(file);
    if (fresh) body.sha = fresh;
    const retry = await fetch(contentsUrl(file), {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
      body: JSON.stringify(body)
    });
    if (!retry.ok) {
      const err = await retry.text();
      throw new Error('推送 ' + file + ' 失败：' + explain(retry.status) + '\n' + err.slice(0, 300));
    }
    const j2 = await retry.json();
    return j2.commit && j2.commit.sha;
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error('推送 ' + file + ' 失败：' + explain(res.status) + '\n' + err.slice(0, 300));
  }
  const j = await res.json();
  return j.commit && j.commit.sha;
}

async function main() {
  console.log('→ 仓库：' + USER + '/' + REPO + '（分支 ' + BRANCH + '）');

  let okCount = 0;
  for (const file of FILES) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) {
      console.log('跳过 ' + file + '（本地不存在）');
      continue;
    }
    const content = fs.readFileSync(full, 'utf8');
    const sha = await getSha(file);
    const commit = await putFile(file, content, sha);
    okCount++;
    console.log('✅ ' + file + ' 已推送' + (sha ? '（更新）' : '（新建）') + (commit ? ' · commit ' + String(commit).slice(0, 7) : ''));
  }

  if (!okCount) {
    console.log('没有文件被推送。检查 --files 或当前目录。');
    process.exit(1);
  }

  console.log('\n完成。稍等片刻 GitHub Pages 会重新构建：');
  console.log('  https://' + USER + '.github.io');
  console.log('  https://' + USER + '.github.io/data.json');
  console.log('\n如果页面没更新，先确认 Settings → Pages 的 Source 是 ' + BRANCH + ' 分支 / (root)。');
}

main().catch(function (err) {
  console.error('\n❌ ' + (err && err.message ? err.message : err));
  process.exit(1);
});
//（注：内容由AI生成）
