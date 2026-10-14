'use strict';

// 检查的是详情网页资源和排版；不启动桌面应用、不读取系统剪贴板。
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'docs', 'showcase', '预览截图');

async function run() {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [];
  const report = { date: new Date().toISOString(), screenshots: [], layouts: [], errors };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.join(root, 'docs/showcase/index.html')).href);
    await page.evaluate(() => document.querySelectorAll('img').forEach(image => { image.loading = 'eager'; }));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.images].filter(image => !image.closest('details') || image.closest('details').open)
      .every(image => image.complete && image.naturalWidth > 0));
    for (const width of [1440, 1920, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      const layout = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth,
        featureTitles: [...document.querySelectorAll('h2')].map(title => title.textContent.trim()),
        images: [...document.images].filter(image => !image.closest('details') || image.closest('details').open)
          .map(image => ({ src: image.getAttribute('src'), loaded: image.complete && image.naturalWidth > 0 })) }));
      assert(layout.content <= width + 1, `页面水平溢出：${JSON.stringify(layout)}`);
      assert(layout.images.every(image => image.loaded), '图片未正确加载');
      assert(layout.featureTitles[0].includes('自动捕捉'), '第一项功能必须解释自动捕捉');
      report.layouts.push(layout);
      if ([1440, 390].includes(width)) {
        const file = path.join(output, width === 1440 ? '完整详情-桌面.png' : '完整详情-手机.png');
        await page.screenshot({ path: file, fullPage: true }); report.screenshots.push(path.relative(root, file));
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const heroFile = path.join(output, '首屏.png');
    await page.screenshot({ path: heroFile }); report.screenshots.push(path.relative(root, heroFile));
    const capture = page.locator('#capture');
    assert.equal(await capture.count(), 1, '自动捕捉章节需提供capture锚点');
    const captureFile = path.join(output, '自动捕捉.png');
    await capture.screenshot({ path: captureFile }); report.screenshots.push(path.relative(root, captureFile));
    const video = page.locator('video');
    await video.evaluate(async element => {
      if (element.readyState >= 1) return;
      await new Promise((resolve, reject) => {
        element.addEventListener('loadedmetadata', resolve, { once: true });
        element.addEventListener('error', () => reject(new Error('播放副本加载失败')), { once: true });
      });
    });
    report.video = await video.evaluate(element => ({ duration: element.duration, width: element.videoWidth,
      height: element.videoHeight, autoplay: element.autoplay, controls: element.controls,
      src: element.querySelector('source')?.getAttribute('src') || element.getAttribute('src') }));
    assert(Math.abs(report.video.duration - 49.319002) < .1 && report.video.width === 1920 && report.video.height === 1080);
    assert(!report.video.autoplay && report.video.controls);
    const appreciation = page.locator('details').filter({ hasText: '赞赏' }).last();
    if (await appreciation.count()) {
      assert.equal(await appreciation.getAttribute('open'), null, '赞赏默认折叠');
      await appreciation.locator('summary').click();
      await appreciation.locator('img').waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('details[open] img')].every(image => image.complete && image.naturalWidth > 0));
      report.appreciation = await appreciation.locator('img').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
      assert.equal(report.appreciation.width, 594); assert.equal(report.appreciation.height, 594);
    }
    assert.equal(errors.length, 0);
    await fs.writeFile(path.join(root, 'docs/showcase/验收记录.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
