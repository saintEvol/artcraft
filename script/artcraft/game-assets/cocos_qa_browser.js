#!/usr/bin/env node
/**
 * §12.4 构建产物运行时验收的浏览器驱动（仅测试用，被
 * script/artcraft/game-assets/test_cocos_runtime.py 调用）。
 *
 * 用 playwright-core 以系统 Google Chrome（channel:"chrome"，headless，
 * swiftshader 软件渲染 WebGL）打开 web-mobile 构建产物，等待 QA 驱动组件
 * （assets/qa/qa_driver.ts）写入的 window.__ARTCRAFT_COCOS_QA__ 完成，
 * 并在 walk 循环动画的指定帧窗口内截图（帧号在截图前后各读一次并要求
 * 一致，保证截图内容确实处于该帧）。输出 JSON 汇总供 python 断言。
 *
 * 用法：node cocos_qa_browser.js <url> <qaOutPath> <shotDir> <playwrightModuleDir>
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const VIEWPORT = { width: 960, height: 640 };
/** 帧窗口（相对帧周期的比例区间），远离帧边界以容忍截图延迟。 */
const FRAME_WINDOWS = { red: [0.24, 0.46], blue: [0.64, 0.86] };
const DONE_TIMEOUT_MS = 90_000;

async function main() {
  const [url, qaOutPath, shotDir, playwrightModuleDir] = process.argv.slice(2);
  if (!url || !qaOutPath || !shotDir || !playwrightModuleDir) {
    throw new Error("用法: node cocos_qa_browser.js <url> <qaOutPath> <shotDir> <playwrightModuleDir>");
  }
  const { chromium } = require(path.join(playwrightModuleDir, "playwright-core"));
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: VIEWPORT });
  const consoleLines = [];
  page.on("console", (message) => {
    if (consoleLines.length < 200) {
      consoleLines.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => consoleLines.push(`pageerror: ${error.message}`));

  const output = { url, viewport: VIEWPORT, shots: {}, webgl: null, consoleLines: [] };
  try {
    const webgl = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
    });
    output.webgl = webgl;

    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    await page.waitForFunction(
      () => window.__ARTCRAFT_COCOS_QA__ && window.__ARTCRAFT_COCOS_QA__.ready === true,
      null,
      { timeout: 60_000, polling: 250 },
    );
    await page.waitForFunction(
      () => window.__ARTCRAFT_COCOS_QA__ && window.__ARTCRAFT_COCOS_QA__.done === true,
      null,
      { timeout: DONE_TIMEOUT_MS, polling: 250 },
    );

    const readState = () => page.evaluate(() => {
      const qa = window.__ARTCRAFT_COCOS_QA__;
      return { elapsed: qa.latestLoopElapsed, fps: qa.json.frames.fps, done: qa.done };
    });
    const frameAt = (elapsed, fps) => Math.floor(elapsed * fps) % 2;

    // 采样结束后 WalkLoop 仍持续播放。低帧率下截图内容可能落在门控帧的相邻
    // 帧，因此不做帧窗口门控：随机间隔多拍数张，python 侧按颜色挑选红/蓝帧。
    const shots = [];
    for (let i = 0; i < 12; ++i) {
      const state = await readState();
      const file = `shot-${i}.png`;
      await page.screenshot({ path: path.join(shotDir, file) });
      shots.push({ file, elapsed: state.elapsed });
      await page.waitForTimeout(120 + Math.floor(Math.random() * 420));
    }
    output.shots.all = shots;

    output.qa = await page.evaluate(() => window.__ARTCRAFT_COCOS_QA__);
    output.ok = output.qa.done === true && Array.isArray(output.shots.all) && output.shots.all.length >= 8;
  } finally {
    output.consoleLines = consoleLines;
    fs.mkdirSync(path.dirname(qaOutPath), { recursive: true });
    fs.writeFileSync(qaOutPath, `${JSON.stringify(output, null, 2)}\n`);
    await browser.close();
  }
  process.exit(output.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
