'use strict';
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const mode = process.env.RACK_EXE ? 'packaged' : 'development';
const artifacts = path.join(root, 'test-artifacts', `v${require('../package.json').version}`, `appreciation-${mode}`);
const profile = path.join(artifacts, 'profiles', new Date().toISOString().replace(/[:.]/g, '-'));
const report = { mode, profile, date: new Date().toISOString(), tests: [], pageErrors: [],
  qrSource: 'user supplied PNG, unchanged bytes', actualScan: 'not performed; no payment initiated', clipboard: 'isolated application; daily clipboard unchanged' };
let app, rack;
const pages = new WeakSet();
const observe = page => { if (!pages.has(page)) { pages.add(page); page.on('pageerror', error => report.pageErrors.push(error.message)); } };
const count = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).length);
async function check(name, task) {
  try { const detail = await task(); report.tests.push({ name, passed: true, detail }); console.log(`通过：${name}`); }
  catch(error) { report.tests.push({ name, passed: false, error: error.message }); throw error; }
}
async function open() {
  const pending = app.waitForEvent('window');
  await rack.locator('#appreciationButton').click();
  const page = await pending;
  observe(page);
  await page.waitForFunction(() => document.getElementById('appreciationQr')?.naturalWidth === 594);
  return page;
}
async function close(page, action) {
  const pending = page.waitForEvent('close');
  try { await action(); }
  catch (error) { if (!page.isClosed()) throw error; }
  await pending;
  // 渲染目标先关闭，随后 BrowserWindow 才完成销毁；等待真实窗口状态。
  const deadline = Date.now() + 3000;
  while (await count() !== 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(await count(), 1);
}
async function run() {
  await fs.mkdir(artifacts, { recursive: true });
  const env = { ...process.env, RACK_TEST_MODE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.RACK_EXE || require('electron'),
    args: [...(process.env.RACK_EXE ? [] : [root]), '--rack-test', `--data-dir=${profile}`], env, cwd: root });
  app.on('window', observe); rack = await app.firstWindow(); observe(rack);
  await rack.waitForFunction(() => !!window.rack);
  await check('默认不弹赞赏窗，入口使用普通按钮且二维码原图未改动', async () => {
    assert.equal(await count(), 1);
    const bytes = await fs.readFile(path.join(root, 'src/assets/appreciation-qr.png'));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), 'd606b4b625a9150ce35285d3c47bad3f37376696dea73dc037e9025b906b300b');
    const style = await rack.locator('#appreciationButton').evaluate(button => {
      const own = getComputedStyle(button), other = getComputedStyle(document.getElementById('pauseButton'));
      return { text: button.textContent.trim(), classes: [...button.classList], ownBackground: own.backgroundColor,
        otherBackground: other.backgroundColor, ownColor: own.color, otherColor: other.color, animation: own.animationName };
    });
    assert.equal(style.text, '赞赏'); assert.equal(style.ownBackground, style.otherBackground);
    assert.equal(style.ownColor, style.otherColor); assert.equal(style.animation, 'none');
    return { style, qrBytes: bytes.length, startupWindows: 1 };
  });
  await check('普通和窄衣架所有按钮可见、可命中且不相互覆盖', async () => {
    const native = await app.browserWindow(rack), original = await native.evaluate(w => w.getBounds());
    const layouts = [];
    for (const width of [1024, 768, 690, 601, 600, 550, 546, 540, 521, 512, 409, 331, 330, 307, 240]) {
      await native.evaluate((w, width) => w.setBounds({ ...w.getBounds(), width }), width);
      await rack.waitForFunction(width => Math.abs(innerWidth - width) <= 2, width);
      await rack.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await rack.evaluate(() => {
        const toolbar = document.querySelector('.toolbar').getBoundingClientRect();
        const buttons = [...document.querySelectorAll('.toolbar-actions > button, .auto-hide-options > button')].map(button => {
          const r = button.getBoundingClientRect(), hit = document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button');
          return { id: button.id, x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,hit:hit===button };
        });
        return { width: innerWidth, toolbar: { x:toolbar.x,y:toolbar.y,right:toolbar.right,bottom:toolbar.bottom }, buttons };
      });
      assert.equal(layout.buttons.length, 8);
      for (const b of layout.buttons) assert(b.width>0 && b.height>0 && b.hit && b.x>=layout.toolbar.x-1 && b.right<=layout.toolbar.right+1
        && b.y>=layout.toolbar.y-1 && b.bottom<=layout.toolbar.bottom+1, `按钮超出或被遮挡：${JSON.stringify({width,layout,b})}`);
      for (let i=0;i<layout.buttons.length;i++) for(let j=i+1;j<layout.buttons.length;j++) {
        const a=layout.buttons[i],b=layout.buttons[j];
        assert(Math.min(a.right,b.right)-Math.max(a.x,b.x)<=.5 || Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)<=.5);
      }
      layouts.push(layout);
      if (width === 546 || width === 307) await rack.screenshot({path:path.join(artifacts,`rack-${width}.png`),omitBackground:true});
    }
    await native.evaluate((w, bounds) => w.setBounds(bounds), original);
    await rack.waitForFunction(width => Math.abs(innerWidth-width)<=2,original.width);
    return layouts;
  });
  await check('点击展示完整二维码，专用预加载只有关闭权限，关闭按钮销毁窗口', async () => {
    const page = await open();
    const data = await page.evaluate(() => {
      const image = document.getElementById('appreciationQr'), r=image.getBoundingClientRect();
      return { naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,width:r.width,height:r.height,
        imageVisible:r.x>=0 && r.y>=0 && r.right<=innerWidth && r.bottom<=innerHeight,
        closeVisible:document.getElementById('closeButton').getBoundingClientRect().bottom<=innerHeight,
        require:typeof window.require,process:typeof window.process,rack:typeof window.rack,
        api:Object.keys(window.appreciation),pixelated:getComputedStyle(image).imageRendering };
    });
    assert.equal(data.naturalWidth,594); assert.equal(data.naturalHeight,594);
    assert.equal(data.width,data.height); assert.equal(data.imageVisible,true); assert.equal(data.closeVisible,true);
    assert.equal(data.pixelated,'pixelated'); assert.deepEqual(data.api,['close']);
    assert.equal(data.require,'undefined'); assert.equal(data.process,'undefined'); assert.equal(data.rack,'undefined');
    assert.equal(await count(),2);
    await page.screenshot({path:path.join(artifacts,'appreciation-window.png')});
    await close(page,()=>page.locator('#closeButton').click());
    return data;
  });
  await check('快速重复打开复用一个窗口，Esc及原生关闭后都可重新打开', async () => {
    const pending=app.waitForEvent('window');
    await rack.evaluate(()=>Promise.all([window.rack.openAppreciation(),window.rack.openAppreciation(),window.rack.openAppreciation()]));
    const page=await pending; await page.waitForFunction(()=>document.getElementById('appreciationQr')?.naturalWidth===594);
    const windowId=await (await app.browserWindow(page)).evaluate(w=>w.id);
    await rack.evaluate(()=>window.rack.openAppreciation()); assert.equal(await count(),2);
    assert.equal(await (await app.browserWindow(page)).evaluate(w=>w.id),windowId);
    await close(page,()=>page.keyboard.press('Escape'));
    const again=await open(); const native=await app.browserWindow(again);
    await close(again,()=>native.evaluate(w=>w.close()));
    return { singleton:true,esc:true,nativeClose:true,reopened:true };
  });
  await check('加载失败释放窗口及按钮，后续点击可重试', async () => {
    await app.evaluate(({BrowserWindow})=>{
      const original=BrowserWindow.prototype.loadFile;
      BrowserWindow.prototype.loadFile=function(file,...args){
        if(file.endsWith('appreciation.html')) { BrowserWindow.prototype.loadFile=original; return Promise.reject(new Error('测试：赞赏页加载失败')); }
        return original.call(this,file,...args);
      };
    });
    await rack.locator('#appreciationButton').click();
    await rack.waitForFunction(()=>!document.getElementById('appreciationButton').disabled);
    await rack.waitForFunction(()=>document.getElementById('errorMessage').textContent.includes('赞赏'));
    assert.equal(await count(),1);
    const page=await open(); await close(page,()=>page.locator('#closeButton').click());
    return { failedWindowReleased:true,retry:true };
  });
  await check('赞赏打开时自动隐藏及顶部恢复正常，托盘隐藏不会关闭赞赏', async () => {
    const page=await open();
    await rack.evaluate(()=>window.rack.setAutoHide(false));
    const runtime=await app.evaluate(({app})=>app.__rackTest.runtime());
    const inside={x:runtime.expandedBounds.x+60,y:runtime.expandedBounds.y+40};
    const outside={x:inside.x,y:runtime.expandedBounds.y+runtime.expandedBounds.height+100};
    await app.evaluate(({app},point)=>app.__rackTest.setAutoHideCursor(point),inside);
    await rack.evaluate(()=>window.rack.setAutoHideSpeed('medium')); await rack.evaluate(()=>window.rack.setAutoHide(true));
    const states=await app.evaluate(({app},{outside,inside})=>{
      const before=app.__rackTest.autoHideTick(outside),near=app.__rackTest.autoHideTick(outside,999),due=app.__rackTest.autoHideTick(outside,1);
      const runtime=app.__rackTest.runtime();
      app.__rackTest.autoHideTick({x:inside.x,y:runtime.displayBounds.y+2});
      app.__rackTest.autoHideTick(inside);
      return {before,near,due,revealed:app.__rackTest.runtime().autoHide};
    },{outside,inside});
    assert.equal(states.before.suspended,false);assert.equal(states.near.collapsed,false);assert.equal(states.due.collapsed,true);assert.equal(states.revealed.collapsed,false);
    assert.equal(await (await app.browserWindow(page)).evaluate(w=>w.isVisible()),true);
    await rack.evaluate(()=>window.rack.hide());assert.equal(await (await app.browserWindow(page)).evaluate(w=>w.isVisible()),true);
    await app.evaluate(({app})=>app.__rackTest.restore()); await rack.evaluate(()=>window.rack.setAutoHide(false));
    await close(page,()=>page.locator('#closeButton').click());
    return {source:'isolated cursor/clock controller test',states,independentWindow:true};
  });
  await check('无页面错误，正常退出会关闭仍在显示的赞赏窗',async()=>{
    const page=await open();assert.deepEqual(report.pageErrors,[]);
    await rack.screenshot({path:path.join(artifacts,'rack-appreciation-button.png'),omitBackground:true});
    await app.close();app=null;assert.equal(page.isClosed(),true);return {pageErrors:0,closedOnExit:true};
  });
}
run().then(()=>{report.passed=true;}).catch(error=>{console.error(error);report.passed=false;report.error=error.stack;process.exitCode=1;}).finally(async()=>{
  if(app) await app.close().catch(()=>{});
  await fs.mkdir(artifacts,{recursive:true});await fs.writeFile(path.join(artifacts,'verification.json'),JSON.stringify(report,null,2));
  console.log(`赞赏验证记录：${path.join(artifacts,'verification.json')}`);
});
